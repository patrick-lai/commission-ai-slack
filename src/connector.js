import { runCall } from './commands.js';
import { DaemonError } from './daemon.js';
import { CallError } from './errors.js';
import { parseEvent } from './events.js';
import { deliverRow } from './outbound.js';
import { redact } from './redact.js';
import { runSocketMode, sleepFor } from './socket.js';

const DAEMON_BACKOFF_MS = [500, 1000, 2000, 5000, 5000, 10000];
const GIVE_UP_AFTER = 12;
const COMMAND_CONCURRENCY = 4;
const RESULT_ATTEMPTS = 3;

export class Exit extends Error {
  constructor(reason, code) {
    super(reason);
    this.reason = reason;
    this.code = code;
  }
}

function nothing() {}

export async function runConnector({ daemon, slack, version, signal, log = nothing, settings = {} }) {
  const sleep = settings.sleep ?? sleepFor;
  const backoff = settings.daemonBackoffMs ?? DAEMON_BACKOFF_MS;
  const stop = new AbortController();
  const whole = AbortSignal.any([signal, stop.signal]);
  let exit = null;
  let credentials = null;
  let identity = { user_id: '', team_id: '' };
  let generation = 0;
  let runner = null;

  const end = (error) => {
    if (exit === null) {
      exit = error;
    }
    stop.abort();
  };

  const guard = async (work, within = whole) => {
    let failures = 0;
    while (!within.aborted) {
      try {
        return await work();
      } catch (error) {
        if (!(error instanceof DaemonError)) {
          if (within.aborted) {
            return undefined;
          }
          throw error;
        }
        if (error.fatal) {
          end(new Exit(error.code, 2));
          return undefined;
        }
        failures += 1;
        if (failures >= GIVE_UP_AFTER) {
          end(new Exit('connector.daemon_unreachable', 3));
          return undefined;
        }
        log('daemon.retry', { code: error.code });
        await sleep(backoff[Math.min(failures - 1, backoff.length - 1)], within);
      }
    }
    return undefined;
  };

  const report = (phase, detail) => guard(() => daemon.status({ phase, detail, identity: identity.user_id === '' ? null : identity }));

  const receive = async (payload) => {
    const event = parseEvent(payload, identity.user_id);
    if (event === null) {
      return true;
    }
    if (event.message.workspace === '') {
      event.message.workspace = identity.team_id;
    }
    let result;
    try {
      result = await daemon.inbound(event);
    } catch (error) {
      if (!(error instanceof DaemonError)) {
        throw error;
      }
      if (error.fatal) {
        end(new Exit(error.code, 2));
      }
      log('inbound.refused', { code: error.code });
      return false;
    }
    const notice = result.notice;
    if (typeof notice === 'object' && notice !== null && credentials !== null) {
      slack.send(credentials.bot_token, notice.conversation, notice.thread_ts, notice.text).catch((error) => {
        log('notice.failed', { error: redact(error instanceof CallError ? error.message : 'unknown', 200) });
      });
    }
    return true;
  };

  const outboxLoop = async (tokens, local) => {
    while (!local.aborted) {
      const rows = await guard(() => daemon.claim(local), local);
      if (rows === undefined) {
        continue;
      }
      for (const row of rows) {
        const outcome = local.aborted ? { outcome: 'released' } : await deliverRow({ slack, bot: tokens.bot_token, daemon }, row);
        for (let attempt = 0; attempt < RESULT_ATTEMPTS; attempt += 1) {
          const sent = await guard(() => daemon.result(row.id, outcome).then(() => true), whole);
          if (sent === true) {
            break;
          }
        }
      }
    }
  };

  const startRunner = (tokens) => {
    const controller = new AbortController();
    const local = AbortSignal.any([whole, controller.signal]);
    const hooks = {
      status: (phase, detail) => report(phase, detail),
      online: () => report('online', null),
      identity: async (found) => {
        identity = { user_id: found.user_id, bot: found.bot, team_id: found.team_id, team: found.team };
        await report('connecting', null);
      },
      receive,
    };
    const done = Promise.all([runSocketMode({ slack, tokens, hooks, signal: local, settings: settings.socket }), outboxLoop(tokens, local)]);
    return {
      async stop() {
        controller.abort();
        await done;
      },
    };
  };

  const commandLoop = async () => {
    const inflight = new Set();
    while (!whole.aborted) {
      if (inflight.size >= COMMAND_CONCURRENCY) {
        await Promise.race(inflight);
        continue;
      }
      const command = await guard(() => daemon.nextCommand(whole));
      if (command === undefined || command === null) {
        continue;
      }
      const task = (async () => {
        const result = await runCall({ slack, credentials, daemon }, command.call);
        await guard(() => daemon.commandResult(command.id, result));
      })().finally(() => inflight.delete(task));
      inflight.add(task);
    }
    await Promise.allSettled(inflight);
  };

  let commands = null;
  while (!whole.aborted) {
    const session = await guard(() => daemon.session(generation, version, whole));
    if (session === undefined) {
      break;
    }
    commands ??= commandLoop();
    if (session.generation !== generation) {
      if (runner !== null) {
        await runner.stop();
        runner = null;
      }
      generation = session.generation;
      credentials = typeof session.credentials === 'object' && session.credentials !== null ? session.credentials : null;
      identity = { user_id: '', team_id: '' };
      if (credentials !== null) {
        runner = startRunner(credentials);
      }
    }
  }
  stop.abort();
  if (runner !== null) {
    await runner.stop();
  }
  if (commands !== null) {
    await commands;
  }
  return exit;
}
