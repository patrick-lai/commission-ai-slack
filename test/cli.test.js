import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { manifestFor } from '../src/scopes.js';
import { startFakeDaemon } from './helpers/fake-daemon.js';
import { GOOD_APP, GOOD_BOT, startFakeSlack } from './helpers/fake-slack.js';

const shim = fileURLToPath(new URL('../bin/commission-ai-slack', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function run(args, env = {}) {
  try {
    const stdout = execFileSync(shim, args, { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status, stdout: String(error.stdout), stderr: String(error.stderr) };
  }
}

function child(env) {
  const process_ = spawn(shim, ['run'], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  process_.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => process_.on('close', (code, signal) => resolve({ code, signal, stderr })));
  return { process: process_, exited };
}

test('version reports what the signed runtime check needs', () => {
  const described = run(['version', '--json']);
  assert.equal(described.code, 0);
  assert.deepEqual(JSON.parse(described.stdout), { version: manifest.version, protocol: 1 });
  assert.equal(run(['version']).stdout.trim(), manifest.version);
  assert.equal(run(['version', '--yaml']).code, 2);
});

test('the package is the npm package CommissionAI expects', () => {
  assert.equal(manifest.name, '@patrick-lai/commission-ai-slack');
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.publishConfig.access, 'public');
  assert.deepEqual(manifest.dependencies ?? {}, {});
  assert.deepEqual(manifest.bin, { 'commission-ai-slack': 'bin/commission-ai-slack' });
  assert.ok(manifest.files.includes('bin/') && manifest.files.includes('src/') && !manifest.files.includes('test/'));
});

test('the manifest command prints the approved Slack app manifest', () => {
  assert.equal(run(['manifest']).stdout, `${manifestFor()}\n`);
  assert.equal(JSON.parse(run(['manifest', 'Triage', 'Routes messages']).stdout).display_information.name, 'Triage');
  assert.equal(run(['help']).code, 0);
  assert.equal(run(['nonsense']).code, 2);
});

test('run refuses to start without a loopback address and a token and never prints the token', () => {
  const missing = run(['run'], {});
  assert.equal(missing.code, 64);
  const remote = run(['run'], { COMMISSION_ENDPOINT: 'http://example.com:7433', COMMISSION_CONNECTOR_TOKEN: 'cmc_secretsecretsecret' });
  assert.equal(remote.code, 64);
  assert.ok(!remote.stderr.includes('cmc_secret'));
  const secure = run(['run'], { COMMISSION_ENDPOINT: 'https://127.0.0.1:7433', COMMISSION_CONNECTOR_TOKEN: 'cmc_secretsecretsecret' });
  assert.equal(secure.code, 64);
});

test('the process serves the daemon and stops cleanly when its standard input closes', async () => {
  const daemon = await startFakeDaemon();
  const fake = await startFakeSlack();
  const env = { COMMISSION_ENDPOINT: daemon.endpoint, COMMISSION_CONNECTOR_TOKEN: daemon.token, COMMISSION_SLACK_API_BASE: fake.base };
  const served = child(env);
  try {
    const online = daemon.nextWhere('status', (status) => status.phase === 'online');
    daemon.setCredentials({ bot_token: GOOD_BOT, app_token: GOOD_APP });
    await online;
    const reported = daemon.nextWhere('result', ({ id }) => id === 'row-1');
    daemon.pushOutbox({ id: 'row-1', channel: 'C0FEEDBK', thread_ts: '1.1', text: 'hello from the process', files: [], attempts: 0 });
    assert.deepEqual((await reported).outcome, { outcome: 'delivered', delivery: 'text' });
    assert.equal(fake.callsTo('chat.postMessage')[0].payload.text, 'hello from the process');
    served.process.stdin.end();
    const ended = await served.exited;
    assert.equal(ended.code, 0);
    for (const secret of [GOOD_BOT, GOOD_APP, daemon.token]) {
      assert.ok(!ended.stderr.includes(secret), 'a secret reached the log');
    }
    assert.ok(ended.stderr.includes('connector.start') && ended.stderr.includes('connector.stop'));
  } finally {
    served.process.kill();
    await fake.close();
    await daemon.close();
  }
});

test('the process exits with a distinct code when its token is refused', async () => {
  const daemon = await startFakeDaemon();
  const served = child({ COMMISSION_ENDPOINT: daemon.endpoint, COMMISSION_CONNECTOR_TOKEN: 'cmc_revoked' });
  try {
    const ended = await served.exited;
    assert.equal(ended.code, 2);
    assert.ok(ended.stderr.includes('connector.token_invalid'));
    assert.ok(!ended.stderr.includes('cmc_revoked'));
  } finally {
    served.process.kill();
    await daemon.close();
  }
});
