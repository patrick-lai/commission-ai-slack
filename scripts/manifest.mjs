import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'];

export function manifestFor(tarball) {
  const bytes = readFileSync(tarball);
  const scratch = mkdtempSync(join(tmpdir(), 'commission-ai-slack-manifest-'));
  try {
    execFileSync('tar', ['-xzf', tarball, '-C', scratch]);
    const described = JSON.parse(execFileSync(join(scratch, 'commission-ai-slack', 'bin', 'commission-ai-slack'), ['version', '--json'], { encoding: 'utf8' }));
    const name = tarball.split('/').at(-1);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const files = PLATFORMS.map((platform) => ({ platform, name, sha256, bytes: statSync(tarball).size }));
    return { name: 'commission-ai-slack', version: described.version, protocol: described.protocol, files };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [tarball, target] = process.argv.slice(2);
  if (tarball === undefined || target === undefined) {
    process.stderr.write('usage: node scripts/manifest.mjs <tarball> <manifest.json>\n');
    process.exit(2);
  }
  writeFileSync(target, `${JSON.stringify(manifestFor(tarball))}\n`);
}
