import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../.local/ezbookkeeping/', import.meta.url));
const executable = fileURLToPath(new URL('../.local/ezbookkeeping/ezbookkeeping', import.meta.url));

try {
  await access(executable);
  const child = spawn(executable, ['server', 'run'], { cwd: directory, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('error', error => {
    console.error(`Cannot start the ledger: ${error.message}`);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal === 'SIGINT' ? 0 : 1);
  });
} catch (error) {
  console.error(`Local release is unavailable: ${error.message}`);
  process.exitCode = 1;
}
