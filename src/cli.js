import { readFileSync } from 'node:fs';
import { runConnector } from './connector.js';
import { Daemon, PROTOCOL, loopbackEndpoint } from './daemon.js';
import { redact } from './redact.js';
import { manifestFor } from './scopes.js';
import { Slack } from './slack.js';

const USAGE = `Usage: commission-ai-slack <command>

  version [--json]            Print the connector version, or its description as JSON.
  manifest [name] [about]     Print the Slack app manifest the connector is approved for.
  run                         Serve the CommissionAI daemon until standard input closes.

run reads COMMISSION_ENDPOINT (the daemon's loopback address) and COMMISSION_CONNECTOR_TOKEN.
`;

export function packageVersion() {
  const file = new URL('../package.json', import.meta.url);
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  return parsed.version;
}

function slackOptions(env) {
  const base = loopbackEndpoint(env.COMMISSION_SLACK_API_BASE ?? '');
  if (base === null) {
    return { env };
  }
  return { env, apiBase: `${base.origin}/api/`, allowFile: (url) => url.origin === base.origin };
}

function logger() {
  return (event, fields = {}) => {
    const line = { at: new Date().toISOString(), event };
    for (const [key, value] of Object.entries(fields)) {
      line[key] = typeof value === 'string' ? redact(value, 300) : value;
    }
    process.stderr.write(`${JSON.stringify(line)}\n`);
  };
}

async function serve(env) {
  const endpoint = loopbackEndpoint(env.COMMISSION_ENDPOINT ?? '');
  const token = env.COMMISSION_CONNECTOR_TOKEN ?? '';
  if (endpoint === null || token === '') {
    process.stderr.write('commission-ai-slack run needs COMMISSION_ENDPOINT (a loopback http address) and COMMISSION_CONNECTOR_TOKEN\n');
    return 64;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  process.stdin.once('end', stop);
  process.stdin.once('error', stop);
  process.stdin.resume();
  const slack = new Slack(slackOptions(env));
  const log = logger();
  log('connector.start', { version: packageVersion(), protocol: PROTOCOL });
  const exit = await runConnector({ daemon: new Daemon({ endpoint, token }), slack, version: packageVersion(), signal: controller.signal, log });
  log('connector.stop', { reason: exit === null ? 'stopped' : exit.reason });
  process.stdin.destroy();
  return exit === null ? 0 : exit.code;
}

export async function main(argv, env = process.env) {
  const [command, ...rest] = argv;
  switch (command) {
    case 'version':
      if (rest[0] === '--json') {
        process.stdout.write(`${JSON.stringify({ version: packageVersion(), protocol: PROTOCOL })}\n`);
        return 0;
      }
      if (rest.length === 0) {
        process.stdout.write(`${packageVersion()}\n`);
        return 0;
      }
      process.stderr.write(USAGE);
      return 2;
    case 'manifest':
      process.stdout.write(`${rest.length === 0 ? manifestFor() : manifestFor(rest[0], rest[1])}\n`);
      return 0;
    case 'run':
      return serve(env);
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(USAGE);
      return 2;
  }
}
