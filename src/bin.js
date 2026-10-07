import { main } from './cli.js';
import { redact } from './redact.js';

const major = Number(process.versions.node.split('.')[0]);

if (major < 20) {
  process.stderr.write('commission-ai-slack needs Node.js 20 or newer\n');
  process.exitCode = 127;
} else {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`commission-ai-slack stopped: ${redact(error instanceof Error ? error.message : String(error), 300)}\n`);
      process.exitCode = 1;
    },
  );
}
