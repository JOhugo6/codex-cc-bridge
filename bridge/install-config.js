'use strict';

// Installer implementation, not an MCP endpoint. All external output is captured:
// an MCP registration can contain secrets belonging to an existing installation.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { resolveModel } = require('./lib/native-runtime');
const NAME = 'claude_bridge';
const MANIFEST = '.claude-bridge-install.json';
const LEGACY_SKILL = '2c2368fe26a169e0310a08f2c144e6f31e8e5908414e736fa02474117af0b15e';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = code => { throw new Error(code); };

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function read(file) {
  try {
    if (!fs.lstatSync(file).isFile()) fail('INSTALL_NONREGULAR_FILE');
    return fs.readFileSync(file);
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function json(file) {
  const bytes = read(file);
  if (bytes === null) return {};
  try {
    const value = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    if (!object(value)) fail('INSTALL_INVALID_CONFIG');
    return value;
  } catch { fail('INSTALL_INVALID_CONFIG'); }
}

function equalBytes(a, b) { return a === null ? b === null : b !== null && a.equals(b); }

function key(file) {
  // Resolve existing ancestors so junction aliases and case differences deduplicate.
  let current = path.resolve(file);
  const suffix = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    suffix.unshift(path.basename(current)); current = parent;
  }
  // The JS realpath implementation preserves Windows 8.3 components (RUNNER~1
  // in hosted-runner TEMP), while process.cwd() expands them. Native realpath
  // resolves both spellings to the same path, including junction ancestors.
  const full = path.join(fs.realpathSync.native(current), ...suffix);
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

function inside(file, directory) {
  const relative = path.relative(key(directory), key(file));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// Node 24 on this Windows build can silently leave Unicode paths behind in
// rmSync({force:true}). Explicit unlink/rmdir keeps lock and staging cleanup
// reliable; lstat prevents traversal through links.
function remove(file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const name of fs.readdirSync(file)) remove(path.join(file, name));
    fs.rmdirSync(file);
  } else fs.unlinkSync(file);
}

function atomic(file, bytes, expected) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!equalBytes(read(file), expected)) fail('INSTALL_CONCURRENT_FILE_CHANGE');
  if (bytes === null) { fs.unlinkSync(file); return; }
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 });
    if (!equalBytes(read(file), expected)) fail('INSTALL_CONCURRENT_FILE_CHANGE');
    fs.renameSync(temp, file);
  } finally { remove(temp); }
}

function files(directory, prefix = '', exclude = []) {
  const result = [];
  for (const entry of fs.readdirSync(path.join(directory, prefix), { withFileTypes: true })) {
    if (!prefix && exclude.includes(entry.name)) continue;
    const relative = path.join(prefix, entry.name);
    if (entry.isSymbolicLink()) fail('INSTALL_SOURCE_LINK');
    if (entry.isDirectory()) result.push(...files(directory, relative));
    else if (entry.isFile()) result.push(relative);
    else fail('INSTALL_NONREGULAR_FILE');
  }
  return result;
}

// cmd.exe is needed only for Windows command shims (npm.cmd / codex.cmd).
// Escape both the command processor and the extra expansion in a .cmd shim;
// never concatenate unescaped model/tool/path input into a shell command.
function cmdArgument(value, doubleEscape = false) {
  let escaped = String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  escaped = `"${escaped}"`.replace(/([()\][%!^"`<>&|;, *?])/g, '^$1');
  return doubleEscape ? escaped.replace(/([()\][%!^"`<>&|;, *?])/g, '^$1') : escaped;
}

function run(command, args, env, cwd) {
  if (!command || [command, ...args].some(arg => typeof arg !== 'string' || /[\0\r\n]/.test(arg))) fail('INSTALL_INVALID_COMMAND');
  let executable = command;
  let argv = args;
  let windowsVerbatimArguments = false;
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    executable = env.ComSpec || env.COMSPEC || path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
    const escapedCommand = command.replace(/([()\][%!^"`<>&|;, *?])/g, '^$1');
    argv = ['/d', '/s', '/c', `"${escapedCommand} ${args.map(arg => cmdArgument(arg, true)).join(' ')}"`];
    windowsVerbatimArguments = true;
  }
  const result = spawnSync(executable, argv, {
    cwd, env, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments,
    // Retain synchronous installer behavior: killing a .cmd wrapper on an
    // arbitrary deadline can leave its actual CLI modifying config after rollback.
    maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { ok: !result.error && result.status === 0, stdout: result.stdout || '' };
}

function checked(command, args, env, cwd, code) {
  const result = run(command, args, env, cwd);
  if (!result.ok) fail(code);
  return result.stdout;
}

function serverOwned(entry, options) {
  return object(entry) && typeof entry.command === 'string' && Array.isArray(entry.args)
    && entry.args.length === 1 && typeof entry.args[0] === 'string'
    && path.isAbsolute(entry.command) && path.isAbsolute(entry.args[0])
    && key(entry.command) === key(options.nodeExe)
    && key(entry.args[0]) === key(path.join(options.destination, 'index.js'));
}

function claudeEntry(file) {
  const value = json(file);
  if (value.mcpServers !== undefined && !object(value.mcpServers)) fail('INSTALL_INVALID_CONFIG');
  if (value.mcpServers && Object.hasOwn(value.mcpServers, NAME) && !object(value.mcpServers[NAME])) fail('INSTALL_INVALID_CONFIG');
  return value.mcpServers?.[NAME] ?? null;
}

function checkClaudeScopes(options) {
  const config = json(options.claudeConfig);
  const cwd = key(options.cwd);
  for (const [directory, project] of Object.entries(config.projects || {})) {
    if (path.isAbsolute(directory) && inside(cwd, directory) && object(project?.mcpServers) && Object.hasOwn(project.mcpServers, NAME)) {
      fail('INSTALL_CLAUDE_SCOPE_COLLISION');
    }
  }
  // Conservative: never shadow a same-named project registration, including one
  // in an ancestor project. No project or managed configuration is modified.
  for (let directory = options.cwd; ; directory = path.dirname(directory)) {
    const project = json(path.join(directory, '.mcp.json'));
    if (object(project.mcpServers) && Object.hasOwn(project.mcpServers, NAME)) fail('INSTALL_CLAUDE_SCOPE_COLLISION');
    if (path.dirname(directory) === directory) break;
  }
}

// Keep the exact original Codex server tables, not a stale copy of config.toml.
// Noncanonical representations fail closed rather than risking another table.
// Locate table boundaries outside TOML strings/arrays. A header-looking line in
// a multiline tool argument must never become a configuration deletion boundary.
// Decode only single-line TOML keys/strings. This is not a general TOML parser:
// unsupported post-add output is left untouched, never adopted for rollback.
function tomlString(token) {
  if (token.startsWith("'")) return token.slice(1, -1);
  return JSON.parse(token.replace(/\\(?:U([0-9a-fA-F]{8})|.)/g, (escape, hex) => {
    if (hex === undefined) return escape;
    const value = Number.parseInt(hex, 16);
    if (value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) fail('INSTALL_CODEX_NONCANONICAL_CONFIG');
    return JSON.stringify(String.fromCodePoint(value)).slice(1, -1);
  }));
}

function tomlKeyPath(text) {
  const keys = [];
  let rest = text;
  do {
    const match = rest.match(/^\s*("(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*'|[A-Za-z0-9_-]+)\s*/);
    if (!match) fail('INSTALL_CODEX_NONCANONICAL_CONFIG');
    keys.push(/^["']/.test(match[1]) ? tomlString(match[1]) : match[1]);
    rest = rest.slice(match[0].length);
    if (!rest.startsWith('.')) break;
    rest = rest.slice(1);
  } while (true);
  return { keys, rest };
}

// A successful or failed `mcp add` only owns the requested command/args/env.
// Validate the entire fragment, not `mcp get`'s lossy transport projection (which
// omits unknown fields/tables). Retain the exact validated bytes for later CAS.
function expectedCodexWrite(text, server) {
  try {
    const value = { command: undefined, args: undefined, env: Object.create(null) };
    const seen = new Set();
    const tables = new Set();
    let table;
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('[')) {
        if (!['[mcp_servers.claude_bridge]', '[mcp_servers.claude_bridge.env]'].includes(trimmed) || tables.has(trimmed)) return false;
        tables.add(trimmed); table = trimmed; continue;
      }
      if (!table) return false;
      const { keys, rest } = tomlKeyPath(trimmed);
      if (keys.length !== 1 || !rest.startsWith('=')) return false;
      const name = keys[0];
      const id = `${table}/${name}`;
      if (seen.has(id)) return false;
      seen.add(id);
      const raw = rest.slice(1).trim();
      const string = /^("(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*')$/;
      if (table === '[mcp_servers.claude_bridge.env]') {
        if (!Object.hasOwn(server.env, name) || !string.test(raw)) return false;
        value.env[name] = tomlString(raw);
      } else if (name === 'command' && string.test(raw)) value.command = tomlString(raw);
      else if (name === 'args') {
        // The installer always supplies exactly one absolute entrypoint.
        const match = raw.match(/^\[\s*("(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*')\s*,?\s*\]$/);
        if (!match) return false;
        value.args = [tomlString(match[1])];
      } else return false;
    }
    return value.command === server.command && same(value.args, server.args) && same(value.env, server.env);
  } catch { return false; }
}

function tomlHeaders(text) {
  const headers = new Map();
  headers.statements = new Set();
  let quote = null;
  let multiline = false;
  let depth = 0;
  let offset = 0;
  for (const line of text.split(/(?<=\n)/)) {
    const trimmed = line.trim();
    if (!quote && depth === 0 && /^\[/.test(trimmed)) {
      if (!/^\[\[?[^\r\n]+\]\]?\s*(?:#.*)?$/.test(trimmed)) fail('INSTALL_CODEX_NONCANONICAL_CONFIG');
      headers.set(offset, trimmed);
      offset += line.length;
      continue;
    }
    if (!quote && depth === 0 && trimmed && !trimmed.startsWith('#')) headers.statements.add(offset);
    for (let index = 0; index < line.length; index++) {
      const char = line[index];
      if (quote) {
        if (quote === '"' && char === '\\') { index++; continue; }
        if (multiline && line.slice(index, index + 3) === quote.repeat(3)) {
          // TOML permits one or two content quotes immediately before the
          // closing triple. Consume the entire 3/4/5-quote run, not a new string.
          // Basic-string escapes above already consumed any escaped first quote.
          let end = index + 3;
          while (line[end] === quote) end++;
          if (end - index > 5) fail('INSTALL_CODEX_NONCANONICAL_CONFIG');
          quote = null; multiline = false; index = end - 1;
        }
        else if (!multiline && char === quote) quote = null;
      } else {
        if (char === '#') break;
        if (char === '"' || char === "'") {
          quote = char; multiline = line.slice(index, index + 3) === char.repeat(3);
          if (multiline) index += 2;
        } else if (char === '[' || char === '{') depth++;
        else if (char === ']' || char === '}') { depth--; if (depth < 0) fail('INSTALL_CODEX_NONCANONICAL_CONFIG'); }
      }
    }
    if (quote && !multiline) fail('INSTALL_CODEX_NONCANONICAL_CONFIG');
    offset += line.length;
  }
  if (quote || depth !== 0) fail('INSTALL_CODEX_NONCANONICAL_CONFIG');
  return headers;
}

function codexParts(text) {
  const lines = text.split(/(?<=\n)/);
  const ranges = [];
  const headers = tomlHeaders(text);
  let offset = 0;
  let active = null;
  let context = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (headers.has(offset)) {
      if (active) { active.end = offset; active = null; }
      const parsed = tomlKeyPath(trimmed.replace(/^\[\[?/, ''));
      if (!/^\]\]?\s*(?:#.*)?$/.test(parsed.rest)) fail('INSTALL_CODEX_NONCANONICAL_CONFIG');
      context = parsed.keys;
      const target = context[0] === 'mcp_servers' && context[1] === NAME;
      const owned = /^\[mcp_servers\.claude_bridge(?:\.[A-Za-z0-9_-]+)*\]\s*(?:#.*)?$/.test(trimmed);
      if (owned) { active = { start: offset, end: text.length }; ranges.push(active); }
      else if (target) fail('INSTALL_CODEX_NONCANONICAL_CONFIG');
    } else if (!active && headers.statements.has(offset)) {
      const parsed = tomlKeyPath(line);
      const keys = [...context, ...parsed.keys];
      if (keys[0] === 'mcp_servers' && (keys[1] === NAME || keys.length === 1)) {
        // Aggregate root assignments cannot be narrowly restored. Dotted/inline
        // assignments to the actual target are unsupported, not foreign tables.
        fail('INSTALL_CODEX_NONCANONICAL_CONFIG');
      }
    }
    offset += line.length;
  }
  return { ranges, owned: ranges.map(range => text.slice(range.start, range.end)).join('') };
}

function replaceCodex(file, expectedOwned, replacement) {
  // Re-read immediately before the narrow write. Changes to other tables made by
  // the CLI or another process are retained; a changed owned entry is a conflict.
  for (let attempt = 0; attempt < 5; attempt++) {
    const before = read(file);
    const text = before?.toString('utf8') || '';
    const { ranges, owned } = codexParts(text);
    if (owned !== expectedOwned) fail('INSTALL_CONCURRENT_REGISTRATION_CHANGE');
    if (owned === replacement) return;
    let result = text;
    for (const range of [...ranges].reverse()) result = result.slice(0, range.start) + result.slice(range.end);
    if (replacement) result += `${result && !result.endsWith('\n') ? '\n' : ''}${replacement}`;
    try { atomic(file, Buffer.from(result), before); return; }
    catch (error) { if (error.message !== 'INSTALL_CONCURRENT_FILE_CHANGE') throw error; }
  }
  fail('INSTALL_CONCURRENT_CONFIG_CHANGE');
}

function codexEntry(options) {
  const raw = read(options.codexConfig)?.toString('utf8') || '';
  const { owned } = codexParts(raw);
  if (!owned) return { raw: '', entry: null };
  let value;
  try {
    value = JSON.parse(checked(options.codexCommand, ['mcp', 'get', NAME, '--json'], options.codexEnv, options.cwd, 'INSTALL_CODEX_GET'));
  } catch { fail('INSTALL_CODEX_GET'); }
  if (!object(value.transport) || value.transport.type !== 'stdio') fail('INSTALL_REGISTRATION_COLLISION');
  return { raw: owned, entry: value.transport };
}

function codexAddArgs(entry) {
  const args = ['mcp', 'add', NAME];
  for (const [name, value] of Object.entries(entry.env)) args.push('--env', `${name}=${value}`);
  return [...args, '--', entry.command, ...entry.args];
}

function prepareOptions(input, parentEnv = process.env) {
  const options = { ...input };
  options.target = typeof options.target === 'string' ? ['Codex', 'Claude', 'Both'].find(value => value.toLowerCase() === options.target.toLowerCase()) : undefined;
  if (options.model === undefined) options.model = 'opus';
  if (!['Codex', 'Claude', 'Both'].includes(options.target) || !Array.isArray(options.allowedTools)
      || options.allowedTools.some(value => typeof value !== 'string' || !value.trim() || value.trimStart().startsWith('-') || /[\x00-\x1f\x7f]/.test(value))
      || !['dontAsk', 'acceptEdits', 'plan', 'default', 'auto'].includes(options.permissionMode)
      || !Number.isInteger(options.timeoutSeconds) || options.timeoutSeconds < 10 || options.timeoutSeconds > 86400) fail('INSTALL_INVALID_OPTIONS');
  // The frozen native catalogue is the only catalogue.
  try { resolveModel(options.model); } catch { fail('INSTALL_MODEL'); }
  options.parentEnv = { ...parentEnv };
  options.codexRoot = path.resolve(options.codexRoot);
  options.cwd = path.resolve(options.cwd);
  options.sourceRoot = path.resolve(options.sourceRoot);
  options.destination = path.join(options.codexRoot, 'bridges', 'claude-bridge');
  options.codexConfig = path.join(options.codexRoot, 'config.toml');
  const home = parentEnv.USERPROFILE || os.homedir();
  const parentRoot = parentEnv.CLAUDE_CONFIG_DIR;
  if (parentRoot && !path.isAbsolute(parentRoot)) fail('INSTALL_PARENT_ROOT');
  options.claudeConfig = path.join(parentRoot || home, '.claude.json');
  options.codexEnv = Object.fromEntries(Object.entries(parentEnv).filter(([name]) => name.toUpperCase() !== 'CODEX_HOME'));
  options.codexEnv.CODEX_HOME = options.codexRoot;
  if (Object.hasOwn(options, 'nativeConfigRoot')) {
    if (typeof options.nativeConfigRoot !== 'string' || !path.isAbsolute(options.nativeConfigRoot)
        || options.nativeConfigRoot !== options.nativeConfigRoot.normalize('NFC')) fail('INSTALL_NATIVE_ROOT');
    try { if (!fs.statSync(options.nativeConfigRoot).isDirectory()) fail('INSTALL_NATIVE_ROOT'); }
    catch { fail('INSTALL_NATIVE_ROOT'); }
  }
  const roots = [];
  if (options.target !== 'Claude') roots.push(path.resolve(options.skillRoot));
  if (options.target !== 'Codex') roots.push(path.resolve(options.claudeSkillRoot || path.join(parentRoot || path.join(home, '.claude'), 'skills')));
  options.skillFiles = [...new Map(roots.map(root => {
    const file = path.join(root, 'claude-peer', 'SKILL.md'); return [key(file), file];
  })).values()];
  if (inside(options.destination, path.join(options.sourceRoot, 'bridge'))
      || inside(path.join(options.sourceRoot, 'bridge'), options.destination)
      || options.skillFiles.some(file => inside(file, options.destination) || key(file) === key(path.join(options.sourceRoot, 'skills', 'claude-peer', 'SKILL.md')))) fail('INSTALL_OVERLAPPING_ROOTS');
  const env = {
    CLAUDE_BRIDGE_COMMAND: options.claudeExe,
    CLAUDE_BRIDGE_STATE_DIR: path.join(options.codexRoot, 'state', 'claude-bridge'),
    CLAUDE_BRIDGE_PERMISSION_MODE: options.permissionMode,
    CLAUDE_BRIDGE_ALLOWED_TOOLS: JSON.stringify(options.allowedTools),
    CLAUDE_BRIDGE_TIMEOUT_MS: String(options.timeoutSeconds * 1000),
    CLAUDE_BRIDGE_MODEL: options.model,
  };
  if (Object.hasOwn(options, 'nativeConfigRoot')) env.CLAUDE_BRIDGE_CONFIG_DIR = options.nativeConfigRoot;
  options.server = { type: 'stdio', command: options.nodeExe, args: [path.join(options.destination, 'index.js')], env };
  return options;
}

function install(input) {
  const options = prepareOptions(input);
  const { destination } = options;
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true });
  const lock = path.join(parent, '.claude-bridge-install.lock');
  let lockHandle;
  try { lockHandle = fs.openSync(lock, 'wx', 0o600); } catch { fail('INSTALL_LOCKED'); }
  let stage;
  let backup;
  const changes = [];
  const registrations = [];
  const recovery = [];
  const backupFile = (name, bytes) => {
    if (!backup) backup = fs.mkdtempSync(path.join(parent, '.claude-bridge-backup-'));
    const file = path.join(backup, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
  };
  const update = (file, bytes) => {
    const before = read(file);
    if (equalBytes(before, bytes)) return;
    if (before !== null) backupFile(`files/${changes.length}`, before);
    changes.push({ file, before, after: bytes });
    atomic(file, bytes, before);
  };
  try {
    const manifestFile = path.join(destination, MANIFEST);
    const hasManifest = read(manifestFile) !== null;
    const previous = json(manifestFile);
    if (hasManifest && (previous.version !== 1 || !object(previous.files) || !object(previous.skills))) fail('INSTALL_INVALID_MANIFEST');
    const installedPackage = json(path.join(destination, 'package.json'));
    if (Object.keys(installedPackage).length && installedPackage.name !== 'codex-cc-bridge') fail('INSTALL_DESTINATION_COLLISION');
    const skill = fs.readFileSync(path.join(options.sourceRoot, 'skills', 'claude-peer', 'SKILL.md'));
    const skillBefore = new Map();
    for (const file of options.skillFiles) {
      const before = read(file);
      skillBefore.set(file, before);
      if (before && !before.equals(skill) && hash(before) !== previous.skills?.[key(file)]
          && hash(before.toString('utf8').replace(/\r\n/g, '\n')) !== LEGACY_SKILL) fail('INSTALL_SKILL_COLLISION');
    }
    if (!options.skipRegister) {
      if (options.target !== 'Codex') {
        checkClaudeScopes(options);
        const original = claudeEntry(options.claudeConfig);
        if (original && !serverOwned(original, options)) fail('INSTALL_REGISTRATION_COLLISION');
        registrations.push({ kind: 'Claude', original, attempted: false, last: original });
      }
      if (options.target !== 'Claude') {
        const original = codexEntry(options);
        if (original.entry && !serverOwned(original.entry, options)) fail('INSTALL_REGISTRATION_COLLISION');
        registrations.push({ kind: 'Codex', original, attempted: false, last: original.raw });
      }
    }
    stage = fs.mkdtempSync(path.join(parent, '.claude-bridge-stage-'));
    const source = path.join(options.sourceRoot, 'bridge');
    for (const relative of files(source, '', ['node_modules', '.test-output'])) {
      const target = path.join(stage, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(source, relative), target);
    }
    for (const name of ['LICENSE', 'NOTICE']) fs.copyFileSync(path.join(options.sourceRoot, name), path.join(stage, name));
    checked(options.npmCommand, ['--prefix', stage, 'ci', '--no-audit', '--no-fund'], options.parentEnv, options.cwd, 'INSTALL_NPM');
    checked(options.nodeExe, [path.join(stage, 'doctor.js')], { ...options.parentEnv, ...options.server.env }, options.cwd, 'INSTALL_DOCTOR');

    const maintained = files(stage);
    const next = { version: 1, files: {}, skills: { ...(previous.skills || {}) } };
    // Validate every existing target before any file is overwritten.
    const writes = maintained.map(relative => {
      const file = path.join(destination, relative);
      const before = read(file);
      const bytes = fs.readFileSync(path.join(stage, relative));
      if (before && !before.equals(bytes)) {
        if (hasManifest) {
          if (!Object.hasOwn(previous.files, relative) || hash(before) !== previous.files[relative]) fail('INSTALL_FILE_COLLISION');
        } else if (installedPackage.name !== 'codex-cc-bridge') {
          // Legacy adoption applies only when there is no ownership manifest.
          fail('INSTALL_FILE_COLLISION');
        }
      }
      next.files[relative] = hash(bytes);
      return { file, bytes, before };
    });
    for (const { file, bytes, before } of writes) {
      if (!equalBytes(read(file), before)) fail('INSTALL_CONCURRENT_FILE_CHANGE');
      update(file, bytes);
    }
    // Only files recorded by our prior successful install may be removed.
    for (const [relative, digest] of Object.entries(previous.files || {})) {
      if (Object.hasOwn(next.files, relative)) continue;
      const file = path.resolve(destination, relative);
      if (!inside(file, destination) || file === destination) fail('INSTALL_INVALID_MANIFEST');
      const before = read(file);
      if (before && hash(before) !== digest) fail('INSTALL_FILE_COLLISION');
      if (before) update(file, null);
    }
    for (const file of options.skillFiles) {
      if (!equalBytes(read(file), skillBefore.get(file))) fail('INSTALL_CONCURRENT_FILE_CHANGE');
      update(file, skill); next.skills[key(file)] = hash(skill);
    }

    for (const registration of registrations) {
      if (registration.kind === 'Claude') {
        checkClaudeScopes(options);
        if (!same(claudeEntry(options.claudeConfig), registration.original)) fail('INSTALL_CONCURRENT_REGISTRATION_CHANGE');
        if (same(registration.original, options.server)) continue;
        backupFile('claude-registration.json', JSON.stringify({ configFile: options.claudeConfig, name: NAME, entry: registration.original }, null, 2));
        registration.attempted = true;
        if (registration.original) {
          const removed = run(options.claudeExe, ['mcp', 'remove', NAME, '--scope', 'user'], options.parentEnv, options.cwd);
          registration.last = claudeEntry(options.claudeConfig);
          if (!removed.ok || registration.last !== null) fail('INSTALL_CLAUDE_REMOVE');
        }
        const added = run(options.claudeExe, ['mcp', 'add-json', NAME, JSON.stringify(options.server), '--scope', 'user'], options.parentEnv, options.cwd);
        registration.last = claudeEntry(options.claudeConfig);
        if (!added.ok || !same(registration.last, options.server)) fail('INSTALL_CLAUDE_ADD');
        checked(options.claudeExe, ['mcp', 'get', NAME], options.parentEnv, options.cwd, 'INSTALL_CLAUDE_GET');
      } else {
        const before = codexParts(read(options.codexConfig)?.toString('utf8') || '').owned;
        if (before !== registration.original.raw) fail('INSTALL_CONCURRENT_REGISTRATION_CHANGE');
        backupFile('codex-registration.json', JSON.stringify({ configFile: options.codexConfig, name: NAME, tables: before }, null, 2));
        registration.attempted = true;
        const added = run(options.codexCommand, codexAddArgs(options.server), options.codexEnv, options.cwd);
        const observed = codexParts(read(options.codexConfig)?.toString('utf8') || '').owned;
        // A failing CLI can have written successfully before another writer
        // changed the target. Do not claim that arbitrary snapshot as our write.
        const expected = expectedCodexWrite(observed, options.server);
        if (expected) registration.last = observed;
        if (!added.ok) fail('INSTALL_CODEX_ADD');
        if (!expected) fail('INSTALL_CODEX_VERIFY');
        // Run the maintained helper against an isolated server-only fragment,
        // then merge that fragment into the latest config, not an old snapshot.
        const fragment = path.join(stage, 'codex-timeout.toml');
        fs.writeFileSync(fragment, registration.last);
        checked(options.nodeExe, [path.join(stage, 'configure-timeout.js'), fragment, String(options.timeoutSeconds + 60)], options.parentEnv, options.cwd, 'INSTALL_CODEX_TIMEOUT');
        const timed = fs.readFileSync(fragment, 'utf8');
        replaceCodex(options.codexConfig, registration.last, timed);
        registration.last = timed;
        const actual = codexEntry(options).entry;
        if (!actual || actual.command !== options.server.command || !same(actual.args, options.server.args) || !same(actual.env, options.server.env)) fail('INSTALL_CODEX_VERIFY');
      }
    }
    update(manifestFile, Buffer.from(JSON.stringify(next, null, 2) + '\n'));
    if (backup) {
      backupFile('files.json', JSON.stringify(changes.map((change, index) => ({ target: change.file, backup: change.before === null ? null : `files/${index}`, installedSha256: change.after === null ? null : hash(change.after) })), null, 2));
    }
    return { destination, skillFiles: options.skillFiles, backup, target: options.target, registered: !options.skipRegister };
  } catch (error) {
    // Reverse only our entries. CLI calls and unrelated concurrent changes are
    // never undone by copying an entire old settings/configuration file back.
    for (const registration of [...registrations].reverse()) {
      if (!registration.attempted) continue;
      try {
        if (registration.kind === 'Codex') {
          const current = codexParts(read(options.codexConfig)?.toString('utf8') || '').owned;
          // A failed-before-write add may leave only new blank separators before
          // an unrelated appended table. Nothing of ours needs restoring; keep
          // even that concurrent formatting rather than rewriting the old bytes.
          if (current.trimEnd() === registration.original.raw.trimEnd()) continue;
          replaceCodex(options.codexConfig, registration.last, registration.original.raw);
        } else {
          const current = claudeEntry(options.claudeConfig);
          if (same(current, registration.original)) continue;
          if (!same(current, registration.last) || (current !== null && !same(current, options.server))) fail('INSTALL_CONCURRENT_REGISTRATION_CHANGE');
          if (current !== null) checked(options.claudeExe, ['mcp', 'remove', NAME, '--scope', 'user'], options.parentEnv, options.cwd, 'INSTALL_ROLLBACK_REMOVE');
          if (registration.original) checked(options.claudeExe, ['mcp', 'add-json', NAME, JSON.stringify(registration.original), '--scope', 'user'], options.parentEnv, options.cwd, 'INSTALL_ROLLBACK_ADD');
          if (!same(claudeEntry(options.claudeConfig), registration.original)) fail('INSTALL_ROLLBACK_VERIFY');
        }
      } catch { recovery.push(`${registration.kind} registration`); }
    }
    for (const change of [...changes].reverse()) {
      try {
        if (equalBytes(read(change.file), change.before)) continue;
        atomic(change.file, change.before, change.after);
      } catch { recovery.push('managed file'); }
    }
    if (backup) {
      backupFile('recovery.json', JSON.stringify({ pending: recovery, files: changes.map((change, index) => ({ target: change.file, backup: change.before === null ? null : `files/${index}` })) }, null, 2));
    }
    const code = /^INSTALL_[A-Z_]+$/.test(error.message) ? error.message : 'INSTALL_FAILED';
    const result = new Error(`${code}${recovery.length ? ' (automatic rollback incomplete; preserve the recovery backup)' : ' (owned changes rolled back)'}`);
    result.backup = backup;
    throw result;
  } finally {
    try { if (stage) remove(stage); }
    finally { fs.closeSync(lockHandle); remove(lock); }
  }
}

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', value => { input += value; });
  process.stdin.on('end', () => {
    try {
      const result = install(JSON.parse(Buffer.from(input.trim(), 'base64').toString('utf8')));
      console.log(`Installed bridge: ${result.destination}`);
      for (const file of result.skillFiles) console.log(`Installed skill: ${file}`);
      if (result.backup) console.log(`Recovery backup: ${result.backup}`);
      console.log(result.registered ? `Restart ${result.target === 'Both' ? 'Codex and Claude Code / Claudex' : result.target === 'Claude' ? 'Claude Code / Claudex' : 'Codex'} to discover claude_bridge and claude-peer.` : 'Registration skipped; register the installed bridge before using claude-peer.');
    } catch (error) {
      console.error(/^INSTALL_[A-Z_]+(?:\s|$)/.test(error.message) ? error.message : 'INSTALL_FAILED');
      if (error.backup) console.error(`Recovery backup: ${error.backup}`);
      process.exitCode = 1;
    }
  });
}

module.exports = { install, prepareOptions, codexParts, replaceCodex, cmdArgument, expectedCodexWrite };
