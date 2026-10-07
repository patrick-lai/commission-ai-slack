import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { manifestFor } from '../scripts/manifest.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

function build() {
  return execFileSync(join(root, 'scripts/build-dist.sh'), { encoding: 'utf8' }).trim();
}

test('the signed runtime is one archive holding the shim and the sources, and nothing else', () => {
  const tarball = build();
  assert.equal(tarball, join(root, 'dist', `commission-ai-slack-${version}.tar.gz`));
  const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).split('\n').filter(Boolean).sort();
  const sources = readdirSync(join(root, 'src')).filter((name) => name.endsWith('.js')).map((name) => `commission-ai-slack/src/${name}`);
  assert.deepEqual(
    listing.filter((entry) => !entry.endsWith('/')),
    ['commission-ai-slack/LICENSE', 'commission-ai-slack/bin/commission-ai-slack', 'commission-ai-slack/package.json', ...sources].sort(),
  );
  const scratch = mkdtempSync(join(tmpdir(), 'commission-ai-slack-unpack-'));
  try {
    execFileSync('tar', ['-xzf', tarball, '-C', scratch]);
    const shim = join(scratch, 'commission-ai-slack', 'bin', 'commission-ai-slack');
    assert.ok((statSync(shim).mode & 0o111) !== 0, 'the shim is executable');
    assert.deepEqual(JSON.parse(execFileSync(shim, ['version', '--json'], { encoding: 'utf8' })), { version, protocol: 1 });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('the manifest lists the one archive for every platform the daemon installs on', () => {
  const tarball = build();
  const manifest = manifestFor(tarball);
  const bytes = readFileSync(tarball);
  assert.equal(manifest.name, 'commission-ai-slack');
  assert.equal(manifest.version, version);
  assert.equal(manifest.protocol, 1);
  assert.deepEqual(manifest.files.map((file) => file.platform), ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64']);
  for (const file of manifest.files) {
    assert.deepEqual([file.name, file.sha256, file.bytes], [`commission-ai-slack-${version}.tar.gz`, createHash('sha256').update(bytes).digest('hex'), bytes.length]);
  }
  const written = readFileSync(join(root, 'dist', `commission-ai-slack-${version}.tar.gz.sha256`), 'utf8');
  assert.ok(written.startsWith(manifest.files[0].sha256));
});
