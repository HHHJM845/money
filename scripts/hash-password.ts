import { hashPassword } from '../server/auth';

// Read stdin, not argv, to keep the password out of process lists and shell history.
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
try { process.stdout.write(`${hashPassword(input.replace(/\r?\n$/, ''))}\n`); }
catch (error) { process.stderr.write(`${error instanceof Error ? error.message : '密码处理失败'}\n`); process.exitCode = 1; }
