'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
const mode = args.includes('--stub-mode') ? value('--stub-mode') : 'normal';
const sessionId = value(args.includes('--resume') ? '--resume' : '--session-id');
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  if (mode === 'hang') {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: process.platform === 'win32', stdio: 'ignore', windowsHide: true });
    fs.writeFileSync(path.join(process.cwd(), 'pids.json'), JSON.stringify([process.pid, child.pid]));
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === 'invalid') { process.stdout.write('not json'); return; }
  if (mode === 'exit') { process.stderr.write('test CLI failure'); process.exitCode = 7; return; }
  const file = path.join(process.cwd(), sessionId + '.fake.json');
  if (args.includes('--resume') && !fs.existsSync(file)) {
    process.stderr.write('No conversation found with session ID'); process.exitCode = 1; return;
  }
  const history = args.includes('--resume') ? JSON.parse(fs.readFileSync(file, 'utf8')).history : [];
  history.push(prompt);
  fs.writeFileSync(file, JSON.stringify({ history, args }));
  process.stdout.write(JSON.stringify({
    type: 'result', subtype: mode === 'limit' ? 'error_max_turns' : 'success',
    is_error: mode === 'limit', session_id: mode === 'drift' ? '00000000-0000-4000-8000-000000000000' : sessionId,
    result: history.join('\n---\n'), usage: { input_tokens: 12, output_tokens: 4 },
    permission_denials: mode === 'denied' ? [{ tool_name: 'Bash', tool_input: { command: 'npm test' } }] : [],
  }));
});
