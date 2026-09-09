'use strict';
// Intentionally repository-independent CLI double. It changes only disposable
// paths named by the test and never invokes npm, native Claude, or a model.
const fs = require('node:fs');
const path = require('node:path');
const actor = process.argv[2];
const args = process.argv.slice(3);
const controlFile = process.env.INSTALLER_FIXTURE_CONTROL;
const control = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
const log = JSON.parse(fs.readFileSync(control.log, 'utf8'));
const event = { actor, args, nodeVersion: process.version, nodeExe: process.execPath, env: Object.fromEntries(['USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_BRIDGE_MODEL', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'].map(name => [name, process.env[name] ?? null])) };
log.push(event); fs.writeFileSync(control.log, JSON.stringify(log));
const invocation = actor === 'npm' ? 'npm' : `${actor}-${args[1]}`;
if (control.fail === invocation) {
  control.seen = (control.seen || 0) + 1;
  fs.writeFileSync(controlFile, JSON.stringify(control));
}
const hit = control.fail === invocation && (control.seen >= (control.failOnCall || 1)) && (control.failAlways || !control.failed);
if (hit) { control.failed = true; fs.writeFileSync(controlFile, JSON.stringify(control)); }

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}
function load(file) { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}; }
function bail() { console.error('SYNTHETIC_SECRET_DO_NOT_LOG raw CLI configuration output'); process.exit(42); }
function mutate() {
  if (control.mutateOn !== invocation) return;
  if (control.claudeConfig) {
    const current = load(control.claudeConfig);
    current.concurrent = { marker: 'unrelated-late-change' };
    current.mcpServers ||= {}; current.mcpServers.other = { type: 'stdio', command: 'unrelated-concurrent-command' };
    write(control.claudeConfig, JSON.stringify(current));
  }
  if (control.codexConfig) {
    const current = fs.existsSync(control.codexConfig) ? fs.readFileSync(control.codexConfig, 'utf8') : '';
    if (!current.includes('[late_change]')) write(control.codexConfig, current + '\n[late_change]\nvalue = "unrelated-late-change"\n');
  }
  if (control.mutateFile) write(control.mutateFile, 'concurrent-owned-file-edit');
  if (control.codexMutation) {
    const current = fs.readFileSync(control.codexConfig, 'utf8');
    let changed;
    switch (control.codexMutation) {
      case 'env': changed = current.replace('[mcp_servers.claude_bridge.env]', '[mcp_servers.claude_bridge.env]\nREVIEW_SENTINEL = "user-concurrent-env-edit"'); break;
      case 'command': changed = current.replace(/(\[mcp_servers\.claude_bridge\]\n(?:[^\n]*\n)*?command = )[^\n]*/, '$1"independent-concurrent-writer"'); break;
      case 'field': changed = current.replace('[mcp_servers.claude_bridge]', '[mcp_servers.claude_bridge]\nenabled = false'); break;
      case 'subtable': changed = current + '\n[mcp_servers.claude_bridge.concurrent]\nmarker = "user-concurrent-subtable"\n'; break;
      case 'comment': changed = current.replace('[mcp_servers.claude_bridge]', '[mcp_servers.claude_bridge]\n# user-concurrent-comment'); break;
      case 'delete': changed = current.replace(/^\[mcp_servers\.claude_bridge(?:\.[\w-]+)*\][^]*?(?=^\[|$(?![^]))/gm, ''); break;
      default: throw new Error('Unknown disposable mutation');
    }
    if (changed === current) throw new Error('Concurrent mutation did not change the target');
    write(control.codexConfig, changed);
    write(control.concurrentEvidence, changed);
  }
}

if (actor === 'npm') {
  mutate();
  if (hit) bail();
  if (args[0] !== '--prefix' || args.slice(2).join(' ') !== 'ci --no-audit --no-fund') process.exit(3);
  write(path.join(args[1], 'node_modules', 'fixture-dependency', 'index.js'), 'module.exports = "offline";\n');
  process.exit(0);
}
if (args[0] !== 'mcp' || !['add', 'add-json', 'remove', 'get'].includes(args[1]) || args[2] !== 'claude_bridge') process.exit(4);
if (actor === 'claude') {
  const file = path.join(process.env.CLAUDE_CONFIG_DIR || process.env.USERPROFILE, '.claude.json');
  if (file !== control.claudeConfig) throw new Error('Fixture root mismatch');
  if (hit && !control.failAfterWrite) { mutate(); bail(); }
  const current = load(file); current.mcpServers ||= {};
  if (args[1] === 'add-json') {
    if (args[4] !== '--scope' || args[5] !== 'user' || args.length !== 6) process.exit(5);
    if (current.mcpServers.claude_bridge) { mutate(); bail(); }
    current.mcpServers.claude_bridge = JSON.parse(args[3]);
    write(file, JSON.stringify(current, null, 2));
  } else if (args[1] === 'remove') {
    if (args[3] !== '--scope' || args[4] !== 'user' || args.length !== 5) process.exit(6);
    if (!current.mcpServers.claude_bridge) { mutate(); bail(); }
    delete current.mcpServers.claude_bridge;
    write(file, JSON.stringify(current, null, 2));
  } else if (args[1] === 'get') {
    if (!current.mcpServers.claude_bridge) process.exit(1);
    console.log('Scope: User config (available in all projects)');
    console.log('SYNTHETIC_SECRET_DO_NOT_LOG');
  } else process.exit(7);
  mutate(); if (hit) bail(); process.exit(0);
}
if (actor === 'codex') {
  const file = path.join(process.env.CODEX_HOME, 'config.toml');
  if (file !== control.codexConfig) throw new Error('Fixture root mismatch');
  if (hit && !control.failAfterWrite) { mutate(); bail(); }
  const source = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (args[1] === 'add') {
    const env = {};
    let index = 3;
    while (args[index] === '--env') {
      const value = args[index + 1];
      const equals = value.indexOf('=');
      env[value.slice(0, equals)] = value.slice(equals + 1); index += 2;
    }
    if (args[index] !== '--') process.exit(8);
    const entry = { type: 'stdio', command: args[index + 1], args: args.slice(index + 2), env };
    const kept = source.replace(/^\[mcp_servers\.claude_bridge(?:\.[\w-]+)*\][^]*?(?=^\[|$(?![^]))/gm, '');
    const text = `[mcp_servers.claude_bridge]\ncommand = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(entry.args)}\n\n[mcp_servers.claude_bridge.env]\n${Object.entries(env).map(([name, value]) => `${name} = ${JSON.stringify(value)}\n`).join('')}`;
    write(file, kept + (kept && !kept.endsWith('\n') ? '\n' : '') + text);
  } else if (args[1] === 'get') {
    const table = source.match(/^\[mcp_servers\.claude_bridge\]\n([^]*?)(?=^\[|$(?![^]))/m)?.[1];
    const envTable = source.match(/^\[mcp_servers\.claude_bridge.env\]\n([^]*?)(?=^\[|$(?![^]))/m)?.[1] || '';
    if (!table) process.exit(1);
    const parse = text => Object.fromEntries(text.split('\n').filter(line => /^\w+ = /.test(line)).map(line => {
      const [name, ...rest] = line.split(' = '); return [name, JSON.parse(rest.join(' = '))];
    }));
    const entry = parse(table);
    console.log(JSON.stringify({ name: 'claude_bridge', enabled: true, transport: { type: 'stdio', command: entry.command, args: entry.args, env: parse(envTable) } }));
  } else process.exit(9);
  mutate(); if (hit) bail(); process.exit(0);
}
process.exit(10);
