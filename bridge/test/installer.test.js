'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
// Helpers are loaded below from an isolated repo-shaped source snapshot.
const repo = path.resolve(__dirname, '..', '..');
const fixtureRoot = path.join(__dirname, 'installer-fixtures');
// Capture the runtime and its local dependencies once, so every isolated
// fixture uses the same source bytes without pinning tests to an old revision.
const nativeSnapshots = Object.fromEntries(['native-runtime.js', 'native-version.js', 'global-config-snapshot.js', 'config.js']
  .map(file => [file, fs.readFileSync(path.join(repo, 'bridge', 'lib', file))]));
// Snapshot installer inputs once; backend/index/doctor use offline fixtures.
const snapshots = Object.fromEntries(['install.ps1', 'bridge/install-config.js', 'skills/claude-peer/SKILL.md', 'bridge/configure-timeout.js'].map(file => [file, fs.readFileSync(path.join(repo, file))]));
const ps5 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const ps7Candidates = [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'), path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'pwsh.exe')];
const discoveredPs7 = process.platform === 'win32' ? spawnSync(ps5, ['-NoProfile', '-NonInteractive', '-Command', "& pwsh -NoProfile -NonInteractive -Command '$PSHOME'"], { encoding: 'utf8', timeout: 15000, windowsHide: true }) : {};
const ps7 = discoveredPs7.status === 0 ? path.join(discoveredPs7.stdout.trim(), 'pwsh.exe') : ps7Candidates.find(file => fs.existsSync(file)) || ps7Candidates[0];
const shells = [{ name: 'PowerShell 5.1', exe: ps5 }, { name: 'PowerShell 7', exe: ps7 }];
const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
let launcher;
let buildRoot;
let nodeSeed;
const isolatedHelpers = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-helper-source-'));
write(path.join(isolatedHelpers, 'install-config.js'), snapshots['bridge/install-config.js']);
for (const [file, bytes] of Object.entries(nativeSnapshots)) write(path.join(isolatedHelpers, 'lib', file), bytes);
const { prepareOptions, codexParts, replaceCodex, expectedCodexWrite } = require(path.join(isolatedHelpers, 'install-config.js'));
test.after(() => removeFixture(isolatedHelpers));

function removeFixture(directory) {
  // Windows may retain an executable's delete-pending directory briefly after
  // the synchronous child exits. Bound retries; never suppress a final error.
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  assert.equal(fs.existsSync(directory), false, 'Fixture directory must be removed');
}

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, contents);
}
function load(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function quote(value) { return `'${String(value).replace(/'/g, "''")}'`; }
function environment(home, bin) {
  const allowed = ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'];
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.some(value => value.toUpperCase() === name.toUpperCase())));
  return { ...env, PATH: [bin, path.join(env.SystemRoot || 'C:\\Windows', 'System32')].join(path.delimiter),
    USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'App Data'), LOCALAPPDATA: path.join(home, 'Local Data'),
    TEMP: path.join(home, 'Temp'), TMP: path.join(home, 'Temp'), CODEX_HOME: path.join(home, '.codex'),
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/synthetic-parent-only', ANTHROPIC_AUTH_TOKEN: 'SYNTHETIC_SECRET_DO_NOT_LOG',
    CLAUDE_BRIDGE_MODEL: 'synthetic-parent-default-not-inherited', NO_COLOR: '1' };
}

function buildLauncher() {
  if (launcher) return;
  buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-installer-compiler-'));
  // Do not hardlink the running test executable: Windows Node20 cannot unlink
  // that image while this process lives. Copy once, then link each fixture to the
  // private seed, which is only mapped by synchronous, completed child calls.
  nodeSeed = path.join(buildRoot, 'node.exe');
  fs.copyFileSync(process.execPath, nodeSeed);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(nodeSeed)).digest('hex'),
    crypto.createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex'));
  launcher = path.join(buildRoot, 'launcher.exe');
  const result = spawnSync(compiler, ['/nologo', '/target:exe', `/out:${launcher}`, path.join(fixtureRoot, 'Launcher.cs')], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

test.after(() => {
  if (buildRoot) {
    removeFixture(buildRoot);
    assert.equal(fs.existsSync(buildRoot), false, 'Private executable seed must be removed');
  }
});

function pc(t, label = 'PC-A', { codex = true, parentRoot = false, binName = 'Programs with spaces' } = {}) {
  buildLauncher();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `bridge-installer-${label}-`));
  t.after(() => {
    removeFixture(base);
    assert.equal(fs.existsSync(base), false, 'Fixture files must be removed after all children finish');
  });
  const home = path.join(base, `${label} Home žluťoučký 日本`);
  const bin = path.join(home, binName);
  const source = path.join(home, 'source checkout');
  const cwd = path.join(home, 'project with spaces');
  for (const directory of [home, bin, source, cwd, path.join(home, 'Temp')]) fs.mkdirSync(directory, { recursive: true });
  fs.linkSync(nodeSeed, path.join(bin, 'node.exe'));
  fs.copyFileSync(launcher, path.join(bin, 'claude.exe'));
  fs.copyFileSync(path.join(fixtureRoot, 'external-cli.js'), path.join(bin, 'external-cli.js'));
  for (const name of ['npm', ...(codex ? ['codex'] : [])]) write(path.join(bin, `${name}.cmd`), `@"%~dp0node.exe" "%~dp0external-cli.js" ${name} %*\r\n`);
  for (const [relative, bytes] of Object.entries(snapshots)) write(path.join(source, relative), bytes);
  for (const [file, bytes] of Object.entries(nativeSnapshots)) write(path.join(source, 'bridge', 'lib', file), bytes);
  write(path.join(source, 'bridge', 'package.json'), JSON.stringify({ name: 'codex-cc-bridge', version: 'fixture', private: true, dependencies: {} }));
  write(path.join(source, 'bridge', 'package-lock.json'), '{"lockfileVersion":3}');
  write(path.join(source, 'bridge', 'index.js'), '// Offline installer fixture; never a real MCP server.\n');
  fs.copyFileSync(path.join(fixtureRoot, 'doctor.js'), path.join(source, 'bridge', 'doctor.js'));
  for (const name of ['LICENSE', 'NOTICE']) write(path.join(source, name), `fixture ${name}\n`);
  // Excluded inputs must not be installed, or even traversed.
  write(path.join(source, 'bridge', 'node_modules', 'source-only', 'sentinel'), 'do not copy');
  write(path.join(source, 'bridge', '.test-output', 'sentinel'), 'do not copy');
  const env = environment(home, bin);
  for (const directory of [env.APPDATA, env.LOCALAPPDATA]) fs.mkdirSync(directory, { recursive: true });
  if (parentRoot) { env.CLAUDE_CONFIG_DIR = path.join(home, 'Parent native 配置'); fs.mkdirSync(env.CLAUDE_CONFIG_DIR); }
  const codexRoot = env.CODEX_HOME;
  const claudeConfig = path.join(env.CLAUDE_CONFIG_DIR || home, '.claude.json');
  const codexConfig = path.join(codexRoot, 'config.toml');
  const settings = path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json');
  write(claudeConfig, JSON.stringify({ model: 'parent-model-sentinel', env: { secret: 'SYNTHETIC_SECRET_DO_NOT_LOG' }, unrelated: 17, mcpServers: { other: { command: 'other-original' } } }, null, 2));
  write(settings, '{"model":"parent-only","permissions":{"deny":["Bash(dangerous)"]}}');
  write(codexConfig, 'model = "parent-model-sentinel"\n\n[mcp_servers.other]\ncommand = "other-original"\n');
  const state = path.join(codexRoot, 'state', 'claude-bridge', 'preserved.json');
  write(state, '{"session_id":"old-session-do-not-touch"}');
  const nativeSession = path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects', 'session.jsonl');
  write(nativeSession, '{"native":"preserve"}\n');
  const controlFile = path.join(base, 'control.json');
  const log = path.join(base, 'calls.json'); write(log, '[]');
  write(controlFile, JSON.stringify({ log, claudeConfig, codexConfig })); env.INSTALLER_FIXTURE_CONTROL = controlFile;
  const destination = path.join(codexRoot, 'bridges', 'claude-bridge');
  return { base, home, bin, source, cwd, env, codexRoot, claudeConfig, codexConfig, settings, state, nativeSession, controlFile, log, destination,
    control(value) { write(controlFile, JSON.stringify({ ...load(controlFile), failed: false, seen: 0, ...value })); },
    calls() { return load(log); },
    entry() { return load(claudeConfig).mcpServers?.claude_bridge; },
    skills(target = 'Claude') { return path.join(target === 'Codex' ? path.join(home, '.agents') : env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'skills', 'claude-peer', 'SKILL.md'); },
  };
}

function invoke(fixture, shell, parameters = {}) {
  const argumentsText = Object.entries(parameters).map(([name, value]) => typeof value === 'boolean' ? (value ? `-${name}` : `-${name}:$false`) : `-${name} ${Array.isArray(value) ? `@(${value.map(quote).join(',')})` : quote(value)}`).join(' ');
  const report = path.join(fixture.base, 'parent-after.json');
  const script = `$ErrorActionPreference = 'Stop'\n$beforeEncoding = $OutputEncoding.WebName\n$before = @($env:CODEX_HOME, $env:CLAUDE_CONFIG_DIR, $env:ANTHROPIC_AUTH_TOKEN, $env:CLAUDE_BRIDGE_MODEL)\n$failed = $false\ntry { & ${quote(path.join(fixture.source, 'install.ps1'))} ${argumentsText} } catch { [Console]::Error.WriteLine($_.Exception.Message); $failed = $true } finally { @{same = (($before -join '|') -ceq (@($env:CODEX_HOME, $env:CLAUDE_CONFIG_DIR, $env:ANTHROPIC_AUTH_TOKEN, $env:CLAUDE_BRIDGE_MODEL) -join '|')); encodingSame = ($beforeEncoding -eq $OutputEncoding.WebName)} | ConvertTo-Json -Compress | Set-Content -LiteralPath ${quote(report)} -Encoding UTF8 }\nif ($failed) { exit 1 }`;
  const result = spawnSync(shell.exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    cwd: fixture.cwd, env: fixture.env, encoding: 'utf8', timeout: 90000, windowsHide: true,
  });
  const output = (result.stdout || '') + (result.stderr || '');
  assert.ifError(result.error);
  assert.ok(!output.includes('SYNTHETIC_SECRET_DO_NOT_LOG'), `Raw external output escaped: ${output}`);
  if (fs.existsSync(report)) assert.deepEqual(load(report), { same: true, encodingSame: true });
  return { ...result, output };
}
function success(result) { assert.equal(result.status, 0, result.output || result.error?.message); assert.match(result.output, /Installed bridge:/); }
function failure(result, code) { assert.notEqual(result.status, 0, result.output); if (code) assert.match(result.output, new RegExp(code)); }
function preserved(fixture) {
  assert.equal(load(fixture.state).session_id, 'old-session-do-not-touch');
  assert.equal(fs.readFileSync(fixture.nativeSession, 'utf8'), '{"native":"preserve"}\n');
  assert.equal(fs.readFileSync(fixture.settings, 'utf8'), '{"model":"parent-only","permissions":{"deny":["Bash(dangerous)"]}}');
  assert.equal(load(fixture.claudeConfig).model, 'parent-model-sentinel');
}
function backupDirs(fixture) {
  const parent = path.dirname(fixture.destination);
  return fs.existsSync(parent) ? fs.readdirSync(parent).filter(name => name.startsWith('.claude-bridge-backup-')).map(name => path.join(parent, name)) : [];
}
function fileTree(directory) {
  if (!fs.existsSync(directory)) return {};
  const values = {};
  const walk = (folder, prefix = '') => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const relative = path.join(prefix, entry.name);
      if (entry.isDirectory()) walk(path.join(folder, entry.name), relative);
      else values[relative] = fs.readFileSync(path.join(folder, entry.name), 'utf8');
    }
  }; walk(directory); return values;
}

// Grammar fixtures stay offline and dependency-free. The first two are the
// original valid-TOML false rejections; the next two cover two trailing quotes.
function multilineQuoteCases() {
  const cases = [
    { name: 'basic four-quote ending', source: 'developer_instructions = """Use the word "strict""""\n' },
    { name: 'literal four-quote ending', source: "developer_instructions = '''Use the word 'strict''''\n" },
    { name: 'basic five-quote ending', source: 'developer_instructions = """Use the word ""strict"""""\n' },
    { name: 'literal five-quote ending', source: "developer_instructions = '''Use the word ''strict'''''\n" },
  ];
  for (const quote of ['"', "'"]) {
    for (const ending of [3, 4, 5]) {
      for (const slashes of [1, 2, 3, 4]) {
        // An odd backslash run escapes the first double quote, never an apostrophe.
        const escaped = quote === '"' ? slashes % 2 : 0;
        cases.push({ name: `${quote} ending ${ending}, backslashes ${slashes}`,
          source: `developer_instructions = ${quote.repeat(3)}slashes ${'\\'.repeat(slashes)}${quote.repeat(ending + escaped)} # [mcp_servers."claude_bridge"] """ '''\n` });
      }
      cases.push({ name: `${quote} empty/content-only ending ${ending}`,
        source: `developer_instructions = ${quote.repeat(3 + ending)}\n` });
    }
    cases.push({ name: `${quote} internal quotes and target-like lines`,
      source: `developer_instructions = ${quote.repeat(3)}one ${quote} and two ${quote.repeat(2)} quotes\n [mcp_servers.claude_bridge]\n mcp_servers.claude_bridge.command = "not a target"\n # braces ] } and quotes ${quote.repeat(2)} stay inside\nlast${quote.repeat(5)} # [mcp_servers.claude_bridge]\n` });
  }
  cases.push({ name: 'basic escaped quote pair does not end the multiline string',
    source: 'developer_instructions = """escaped \\"""\n [mcp_servers.claude_bridge]\nlast""""\n' });
  cases.push({ name: 'basic line continuation retains string context',
    source: 'developer_instructions = """continued\\\n  \n [mcp_servers.claude_bridge]\nlast"""""\n' });
  cases.push({ name: 'array elements close before commas, comments and brackets',
    source: 'instructions = [\n  """basic"""", # [mcp_servers."claude_bridge"] """\n  \'\'\'literal\'\'\'\'\',\n  { value = """inline"""" }\n]\n' });
  return cases;
}

test('multiline quote endings preserve exact target spans and unrelated bytes', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-quotes-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'config.toml');
  for (const { name, source } of multilineQuoteCases()) {
    for (const newline of ['\n', '\r\n']) {
      const prefix = source.replace(/\n/g, newline);
      const target = `[mcp_servers.claude_bridge]${newline}command = "old"${newline}`;
      const unrelated = `[projects."claude_bridge"]${newline}note = "preserve"${newline}`;
      const env = `[mcp_servers.claude_bridge.env]${newline}X = "old"${newline}`;
      const text = prefix + target + unrelated + env;
      assert.equal(codexParts(prefix).owned, '', name);
      assert.deepEqual(codexParts(text), { ranges: [
        { start: prefix.length, end: prefix.length + target.length },
        { start: prefix.length + target.length + unrelated.length, end: text.length },
      ], owned: target + env }, name);
      write(file, text);
      const replacement = target.replace('old', 'new');
      replaceCodex(file, target + env, replacement);
      assert.equal(fs.readFileSync(file, 'utf8'), prefix + unrelated + replacement, name);
      replaceCodex(file, replacement, target + env);
      assert.equal(fs.readFileSync(file, 'utf8'), prefix + unrelated + target + env, name);
    }
  }
});

test('multiline quote endings cannot hide actual noncanonical targets or malformed strings', () => {
  const targets = [
    'mcp_servers.claude_bridge.command = "foreign"\n',
    'mcp_servers = { claude_bridge = { command = "foreign" } }\n',
    '[mcp_servers]\nclaude_bridge.command = "foreign"\n',
    '[mcp_servers."claude_bridge"]\ncommand = "foreign"\n',
    '["mcp_\\u0073ervers"."claude_bridge"]\ncommand = "foreign"\n',
    '[mcp_servers . claude_bridge.env]\nX = "foreign"\n',
    '[[mcp_servers.claude_bridge]]\ncommand = "foreign"\n',
  ];
  for (const { name, source } of multilineQuoteCases()) {
    for (const target of targets) assert.throws(() => codexParts(source + target), /INSTALL_CODEX_NONCANONICAL_CONFIG/, name);
  }
  for (const quote of ['"', "'"]) {
    for (const ending of [1, 2, 6, 7, 8]) {
      const invalid = `developer_instructions = ${quote.repeat(3)}unclosed or excessive${quote.repeat(ending)}\n`;
      assert.throws(() => codexParts(invalid), /INSTALL_CODEX_NONCANONICAL_CONFIG/);
      assert.throws(() => codexParts(invalid + targets[3]), /INSTALL_CODEX_NONCANONICAL_CONFIG/);
    }
  }
});

test('TOML restoration ignores header-shaped content in multiline strings and arrays', () => {
  const source = 'instructions = """\n[mcp_servers.claude_bridge]\nnot a real table\n"""\n[mcp_servers.claude_bridge]\nargs = [\n  "one",\n  "two"\n]\n[mcp_servers.other]\ncommand = "keep"\n';
  assert.equal(codexParts(source).owned, '[mcp_servers.claude_bridge]\nargs = [\n  "one",\n  "two"\n]\n');
});

test('post-add ownership validates complete requested tables, not a lossy CLI projection', () => {
  const server = { command: 'C:\\Program Files\\node.exe', args: ['C:\\App\\index.js'], env: { CLAUDE_BRIDGE_MODEL: 'opus', CLAUDE_BRIDGE_ALLOWED_TOOLS: '["Bash(echo \\\\U00000062 --model:*)"]' } };
  const root = `[mcp_servers.claude_bridge]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}\n`;
  const env = `[mcp_servers.claude_bridge.env]\n${Object.entries(server.env).map(([name, value]) => `${name} = ${JSON.stringify(value)}\n`).join('')}`;
  assert.equal(expectedCodexWrite(root + env, server), true);
  const literal = `[mcp_servers.claude_bridge]\ncommand = '${server.command}'\nargs = [ '${server.args[0]}', ]\n`;
  assert.equal(expectedCodexWrite(env + literal, server), true);
  for (const text of [
    root + env + 'REVIEW_SENTINEL = "concurrent"\n',
    root + env + '[mcp_servers.claude_bridge.extra]\n',
    root + 'enabled = false\n' + env,
    root + '# concurrent comment\n' + env,
    root.replace('node.exe', 'other.exe') + env,
    root + env.replace('opus', 'other'),
    root + env + env,
  ]) assert.equal(expectedCodexWrite(text, server), false, 'Unexpected target content must not become rollback authority');
});

test('noncanonical detection uses decoded absolute key paths, not comments, string bodies or sibling keys', () => {
  for (const text of [
    '[projects."C:/work/claude_bridge"]\nclaude_bridge = "not the target"\n',
    '[mcp_servers.claude_bridge_aux] # claude_bridge\ncommand = "keep"\n',
    '["mcp_servers"."claude_bridge_aux"]\ncommand = "keep"\n',
    '[projects]\nclaude_bridge.description = "keep"\n',
    '[mcp_servers]\nother = { command = "claude_bridge" }\n',
    'instructions = """\nmcp_servers.claude_bridge.command = "not an assignment"\n"""\n',
  ]) assert.equal(codexParts(text).owned, '');
  for (const text of [
    'mcp_servers.claude_bridge.command = "foreign"\n',
    'mcp_servers = { claude_bridge = { command = "foreign" } }\n',
    '[mcp_servers]\nclaude_bridge.command = "foreign"\n',
    '["mcp_\\u0073ervers"."claude_bridge"]\ncommand = "foreign"\n',
    '[mcp_servers . claude_bridge.env]\nX = "foreign"\n',
    '[[mcp_servers.claude_bridge]]\ncommand = "foreign"\n',
  ]) assert.throws(() => codexParts(text), /INSTALL_CODEX_NONCANONICAL_CONFIG/);
});

for (const shell of shells) {
  const available = process.platform === 'win32' && fs.existsSync(shell.exe) && fs.existsSync(compiler);
  test(`${shell.name}: executable provisioning and discovery`, { skip: !available && 'Required Windows shell/compiler unavailable' }, async t => {
    await t.test('private seed preserves the running Node version and permits immediate cleanup after descendants exit', t => {
      const a = pc(t, 'seed-A'); const b = pc(t, 'seed-B');
      assert.notEqual(fs.statSync(nodeSeed).ino, fs.statSync(process.execPath).ino, 'Seed must not be the running image');
      for (const f of [a, b]) {
        const executable = path.join(f.bin, 'node.exe');
        const childFile = path.join(f.bin, 'descendant.js');
        const parentFile = path.join(f.bin, 'parent.js');
        write(childFile, 'console.log(JSON.stringify({version:process.version,exe:process.execPath,pid:process.pid}))');
        write(parentFile, `const {spawnSync}=require('node:child_process');const r=spawnSync(process.execPath,[${JSON.stringify(childFile)}],{encoding:'utf8'});if(r.status!==0)process.exit(91);console.log(JSON.stringify({version:process.version,exe:process.execPath,child:JSON.parse(r.stdout)}));`);
        const script = `& ${quote(executable)} ${quote(parentFile)}; exit $LASTEXITCODE`;
        const result = spawnSync(shell.exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env: f.env, cwd: f.cwd, encoding: 'utf8', timeout: 30000 });
        assert.equal(result.status, 0, result.stderr || result.error?.message);
        const report = JSON.parse(result.stdout);
        assert.equal(report.version, process.version); assert.equal(report.exe, executable);
        assert.equal(report.child.version, process.version); assert.equal(report.child.exe, executable);
        assert.throws(() => process.kill(report.child.pid, 0), { code: 'ESRCH' }, 'Grandchild must have exited before fixture deletion');
        // Delete while the original test runner still lives, and before running
        // the second fixture sharing this seed. Permanent locks remain errors.
        removeFixture(f.base);
        assert.equal(fs.existsSync(f.base), false);
      }
    });
    for (const candidate of ['node', 'npm', 'claude', 'codex', 'all']) {
      await t.test(`first PATH application wins with multiple ${candidate} candidates and literal special-character paths`, t => {
        const f = pc(t, 'discovery', { binName: "Programs (first) & ! ^ %B4_PATH_SENTINEL% ' [日本]" });
        const later = path.join(f.home, 'Programs (later) žluťoučký');
        fs.mkdirSync(later); write(path.join(later, 'discovery-trap'), 'never execute this candidate');
        fs.copyFileSync(launcher, path.join(later, 'trap.exe'));
        for (const name of candidate === 'all' ? ['node', 'npm', 'claude', 'codex'] : [candidate]) {
          if (['node', 'claude'].includes(name)) fs.copyFileSync(launcher, path.join(later, `${name}.exe`));
          else write(path.join(later, `${name}.cmd`), '@"%~dp0trap.exe" %*\r\n');
        }
        f.env.PATH = [f.bin, later, path.join(f.env.SystemRoot || 'C:\\Windows', 'System32')].join(path.delimiter);
        f.env.B4_PATH_SENTINEL = 'must-not-expand';
        success(invoke(f, shell, { Target: 'Both' }));
        assert.equal(f.entry().command, path.join(f.bin, 'node.exe'));
        assert.equal(f.entry().env.CLAUDE_BRIDGE_COMMAND, path.join(f.bin, 'claude.exe'));
        for (const actor of ['npm', 'claude', 'codex']) {
          const calls = f.calls().filter(call => call.actor === actor);
          assert.ok(calls.length, `${actor} first candidate must be invoked`);
          for (const call of calls) {
            assert.equal(call.nodeVersion, process.version);
            assert.equal(call.nodeExe, path.join(f.bin, 'node.exe'));
          }
        }
        assert.equal(fs.existsSync(path.join(later, 'unexpected-invocations.txt')), false, 'Later candidates must never execute');
        preserved(f);
      });
    }
    for (const command of ['node.exe', 'npm.cmd', 'claude.exe', 'codex.cmd']) {
      await t.test(`absent ${command} rejects requested registration before installation`, t => {
        const f = pc(t, 'missing-command'); fs.unlinkSync(path.join(f.bin, command));
        failure(invoke(f, shell, { Target: 'Both' }));
        assert.deepEqual(f.calls(), []); assert.equal(fs.existsSync(f.destination), false); preserved(f);
      });
    }
  });
  test(`${shell.name}: offline installer matrix`, { skip: !available && 'Required Windows shell/compiler unavailable' }, async t => {
    const version = spawnSync(shell.exe, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' });
    assert.equal(version.status, 0); t.diagnostic(`Shell ${version.stdout.trim()}; Node ${process.version}; all external CLI/npm/doctor calls stubbed.`);
    await t.test('Claude-only without Codex; default Opus, machine-local paths, shared skill and parent unchanged', t => {
      const f = pc(t, 'PC-A', { codex: false }); success(invoke(f, shell, { Target: 'claude' }));
      const entry = f.entry();
      assert.equal(entry.type, 'stdio'); assert.equal(entry.command, path.join(f.bin, 'node.exe'));
      assert.deepEqual(entry.args, [path.join(f.destination, 'index.js')]);
      assert.deepEqual(entry.env, { CLAUDE_BRIDGE_COMMAND: path.join(f.bin, 'claude.exe'), CLAUDE_BRIDGE_STATE_DIR: path.join(f.codexRoot, 'state', 'claude-bridge'), CLAUDE_BRIDGE_PERMISSION_MODE: 'dontAsk', CLAUDE_BRIDGE_ALLOWED_TOOLS: '[]', CLAUDE_BRIDGE_TIMEOUT_MS: '900000', CLAUDE_BRIDGE_MODEL: 'opus' });
      assert.equal(fs.readFileSync(f.skills(), 'utf8'), snapshots['skills/claude-peer/SKILL.md'].toString());
      assert.ok(!fs.existsSync(f.skills('Codex'))); assert.ok(!f.calls().some(call => call.actor === 'codex'));
      assert.ok(!fs.existsSync(path.join(f.destination, 'node_modules', 'source-only')));
      assert.ok(!fs.existsSync(path.join(f.destination, '.test-output')));
      assert.equal(load(f.claudeConfig).unrelated, 17); preserved(f);
    });
    await t.test('Codex-compatible default target and timeout helper; all configured values exact through cmd shim', t => {
      const f = pc(t);
      const tools = ['Read', 'Bash(git status:*)', 'Bash(echo "žluťoučký" & 100% ! ^ |:*)', 'Bash(echo "%USERPROFILE%":*)'];
      success(invoke(f, shell, { PermissionMode: 'plan', AllowedTools: tools, Model: 'opus[1m]', TimeoutSeconds: 37 }));
      const add = f.calls().find(call => call.actor === 'codex' && call.args[1] === 'add');
      assert.ok(add); assert.ok(add.args.includes('CLAUDE_BRIDGE_ALLOWED_TOOLS=' + JSON.stringify(tools)));
      assert.ok(add.args.includes('CLAUDE_BRIDGE_MODEL=opus[1m]')); assert.ok(add.args.includes('CLAUDE_BRIDGE_TIMEOUT_MS=37000'));
      const config = fs.readFileSync(f.codexConfig, 'utf8');
      assert.match(config, /startup_timeout_sec = 30/); assert.match(config, /tool_timeout_sec = 97/); assert.match(config, /\[mcp_servers.other\]/);
      assert.equal(f.entry(), undefined); assert.ok(!fs.existsSync(f.skills())); assert.ok(fs.existsSync(f.skills('Codex'))); preserved(f);
    });
    await t.test('Both targets, two portable PCs and byte-identical maintained skills', t => {
      const a = pc(t, 'PC-A'); const b = pc(t, 'PC-B');
      for (const f of [a, b]) {
        success(invoke(f, shell, { Target: 'Both' }));
        assert.equal(fs.readFileSync(f.skills(), 'utf8'), fs.readFileSync(f.skills('Codex'), 'utf8'));
        assert.ok(f.entry().args[0].startsWith(f.home)); assert.equal(f.calls().filter(call => call.actor === 'claude' && call.args[1] === 'add-json').length, 1);
        preserved(f);
      }
      assert.ok(!JSON.stringify(b.entry()).includes(a.home)); assert.notEqual(a.entry().args[0], b.entry().args[0]);
    });
    await t.test('explicit child root exact, parent registration and shared skill honor their own existing root', t => {
      const f = pc(t, 'PC-A', { parentRoot: true }); const child = path.join(f.home, 'Child root 日本'); fs.mkdirSync(child);
      success(invoke(f, shell, { Target: 'Claude', NativeConfigRoot: child + path.sep }));
      assert.equal(f.entry().env.CLAUDE_BRIDGE_CONFIG_DIR, child + path.sep); assert.equal(f.entry().env.CLAUDE_CONFIG_DIR, undefined);
      for (const call of f.calls().filter(call => call.actor === 'claude')) assert.equal(call.env.CLAUDE_CONFIG_DIR, f.env.CLAUDE_CONFIG_DIR);
      assert.ok(fs.existsSync(f.skills())); assert.ok(!fs.existsSync(path.join(child, '.claude.json'))); preserved(f);
    });
    await t.test('parent CLAUDE_CONFIG_DIR is not implicitly inherited as bridge child setting', t => {
      const f = pc(t, 'PC-A', { parentRoot: true }); success(invoke(f, shell, { Target: 'Claude' }));
      assert.ok(!Object.hasOwn(f.entry().env, 'CLAUDE_BRIDGE_CONFIG_DIR')); preserved(f);
    });
    await t.test('SkipRegister for every target never requires Codex or invokes a registration command', t => {
      for (const Target of ['Codex', 'Claude', 'Both']) {
        const f = pc(t, Target, { codex: false }); const original = fs.readFileSync(f.claudeConfig);
        success(invoke(f, shell, { Target, SkipRegister: true }));
        assert.deepEqual(f.calls().map(call => call.actor), ['npm', 'doctor']); assert.deepEqual(fs.readFileSync(f.claudeConfig), original); preserved(f);
      }
    });
    await t.test('Codex is required only for requested registration; missing CLI does not start installation', t => {
      const f = pc(t, 'PC-A', { codex: false }); failure(invoke(f, shell, { Target: 'Both' }));
      assert.deepEqual(f.calls(), []); assert.ok(!fs.existsSync(f.destination)); preserved(f);
    });
    await t.test('equivalent custom shared skill roots deduplicate without symlinks', t => {
      const f = pc(t); const root = path.join(f.home, 'shared skills');
      const result = invoke(f, shell, { Target: 'Both', SkillRoot: root, ClaudeSkillRoot: root.toUpperCase() + path.sep }); success(result);
      assert.equal((result.output.match(/Installed skill:/g) || []).length, 1);
      assert.equal(fs.readFileSync(path.join(root, 'claude-peer', 'SKILL.md'), 'utf8'), snapshots['skills/claude-peer/SKILL.md'].toString());
    });
    await t.test('idempotent rerun preserves sessions, ancillary files and unchanged Claude registration', t => {
      const f = pc(t); const first = invoke(f, shell, { Target: 'Both' }); success(first); const original = f.entry();
      assert.ok(!fs.existsSync(path.join(path.dirname(f.destination), '.claude-bridge-install.lock')), 'Installer lock must be released: ' + first.output);
      write(path.join(f.destination, 'private-unmanaged.txt'), 'keep'); const before = fileTree(f.destination);
      success(invoke(f, shell, { Target: 'Both' })); assert.deepEqual(f.entry(), original); assert.deepEqual(fileTree(f.destination), before);
      assert.equal(f.calls().filter(call => call.actor === 'claude' && call.args[1] === 'add-json').length, 1); preserved(f);
    });
    await t.test('owned update replaces exactly one native entry, keeps backup and unrelated config', t => {
      const f = pc(t); success(invoke(f, shell, { Target: 'Both' })); const original = f.entry();
      write(path.join(f.source, 'bridge', 'index.js'), '// fixture version 2\n');
      success(invoke(f, shell, { Target: 'Both', Model: 'opus[1m]', TimeoutSeconds: 60 }));
      assert.equal(f.entry().env.CLAUDE_BRIDGE_MODEL, 'opus[1m]'); assert.equal(load(f.claudeConfig).mcpServers.other.command, 'other-original');
      assert.equal(fs.readFileSync(path.join(f.destination, 'index.js'), 'utf8'), '// fixture version 2\n');
      assert.ok(backupDirs(f).some(dir => fs.existsSync(path.join(dir, 'claude-registration.json')) && JSON.stringify(load(path.join(dir, 'claude-registration.json')).entry) === JSON.stringify(original))); preserved(f);
    });
    await t.test('foreign Claude registration is a collision before npm or any overwrite', t => {
      const f = pc(t); const cfg = load(f.claudeConfig); cfg.mcpServers.claude_bridge = { type: 'stdio', command: 'foreign-command', env: { secret: 'SYNTHETIC_SECRET_DO_NOT_LOG' } }; write(f.claudeConfig, JSON.stringify(cfg));
      const before = fs.readFileSync(f.claudeConfig); failure(invoke(f, shell, { Target: 'Claude' }), 'INSTALL_REGISTRATION_COLLISION');
      assert.deepEqual(fs.readFileSync(f.claudeConfig), before); assert.deepEqual(f.calls(), []); preserved(f);
    });
    await t.test('same name in local/project scope is rejected without touching user registration', t => {
      for (const scope of ['project', 'local']) {
        const f = pc(t, scope);
        if (scope === 'project') write(path.join(f.cwd, '.mcp.json'), JSON.stringify({ mcpServers: { claude_bridge: { command: 'project-server' } } }));
        else { const cfg = load(f.claudeConfig); cfg.projects = { [f.cwd]: { mcpServers: { claude_bridge: { command: 'local-server' } } } }; write(f.claudeConfig, JSON.stringify(cfg)); }
        failure(invoke(f, shell, { Target: 'Claude' }), 'INSTALL_CLAUDE_SCOPE_COLLISION'); assert.deepEqual(f.calls(), []); preserved(f);
      }
    });
    await t.test('local scope recognizes short-path and junction aliases without rejecting sibling projects', t => {
      const f = pc(t, 'scope-alias');
      const script = `(New-Object -ComObject Scripting.FileSystemObject).GetFolder(${quote(f.cwd)}).ShortPath`;
      const shortResult = spawnSync(ps5, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      assert.ifError(shortResult.error); assert.equal(shortResult.status, 0, shortResult.stderr);
      const shortPath = shortResult.stdout.trim();
      assert.equal(fs.realpathSync.native(shortPath), fs.realpathSync.native(f.cwd));
      const alias = path.join(f.base, 'project-junction');
      fs.symlinkSync(f.cwd, alias, 'junction');
      const cfg = load(f.claudeConfig);
      for (const directory of [shortPath, alias]) {
        cfg.projects = { [directory]: { mcpServers: { claude_bridge: { command: 'local-server' } } } };
        write(f.claudeConfig, JSON.stringify(cfg));
        const before = fs.readFileSync(f.claudeConfig);
        failure(invoke(f, shell, { Target: 'Claude' }), 'INSTALL_CLAUDE_SCOPE_COLLISION');
        assert.deepEqual(fs.readFileSync(f.claudeConfig), before);
        assert.deepEqual(f.calls(), []); assert.equal(fs.existsSync(f.destination), false);
      }
      // A missing sibling shares a string prefix but is not this project.
      cfg.projects = { [`${f.cwd}-sibling`]: { mcpServers: { claude_bridge: { command: 'sibling-server' } } } };
      write(f.claudeConfig, JSON.stringify(cfg));
      success(invoke(f, shell, { Target: 'Claude' }));
      preserved(f);
    });
    await t.test('unknown skill is not overwritten and Codex foreign/quoted registrations fail closed', t => {
      const f = pc(t); write(f.skills(), 'private user skill'); failure(invoke(f, shell, { Target: 'Claude' }), 'INSTALL_SKILL_COLLISION'); assert.equal(fs.readFileSync(f.skills(), 'utf8'), 'private user skill');
      const g = pc(t, 'quoted'); fs.appendFileSync(g.codexConfig, '\n[mcp_servers."claude_bridge"]\ncommand = "foreign"\n'); failure(invoke(g, shell), 'INSTALL_CODEX_NONCANONICAL_CONFIG');
      const h = pc(t, 'foreign'); fs.appendFileSync(h.codexConfig, '\n[mcp_servers.claude_bridge]\ncommand = "foreign"\nargs = []\n'); failure(invoke(h, shell), 'INSTALL_REGISTRATION_COLLISION');
    });
    await t.test('invalid model and explicit absent/relative/empty profile reject before npm', t => {
      for (const parameters of [{ Model: 'gpt-5' }, { Model: 'default' }, { NativeConfigRoot: 'relative-profile' }, { NativeConfigRoot: '' }]) {
        const f = pc(t, 'invalid'); failure(invoke(f, shell, { Target: 'Claude', ...parameters })); assert.deepEqual(f.calls(), []); preserved(f);
      }
      const f = pc(t, 'missing-profile'); failure(invoke(f, shell, { Target: 'Claude', NativeConfigRoot: path.join(f.home, 'not-existing') })); assert.deepEqual(f.calls(), []);
    });
    await t.test('npm and doctor failures leave previous files, skills and registrations untouched', t => {
      for (const fail of ['npm', 'doctor']) {
        const f = pc(t, fail); success(invoke(f, shell, { Target: 'Both' })); const before = fileTree(f.destination); const original = f.entry();
        write(path.join(f.source, 'bridge', 'index.js'), '// proposed new version\n'); f.control({ fail });
        failure(invoke(f, shell, { Target: 'Both', Model: 'opus[1m]' }), `INSTALL_${fail.toUpperCase()}`);
        assert.deepEqual(fileTree(f.destination), before); assert.deepEqual(f.entry(), original); preserved(f);
      }
    });
    await t.test('native add/remove/get failures restore owned entry and files while preserving concurrent unrelated changes', t => {
      for (const fail of ['claude-add-json', 'claude-remove', 'claude-get']) {
        const f = pc(t, fail); success(invoke(f, shell, { Target: 'Both' })); const before = fileTree(f.destination); const original = f.entry();
        write(path.join(f.source, 'bridge', 'index.js'), '// proposed new version\n'); f.control({ fail, failAfterWrite: true, mutateOn: fail });
        failure(invoke(f, shell, { Target: 'Both', Model: 'opus[1m]' }), 'INSTALL_CLAUDE_');
        assert.deepEqual(f.entry(), original); assert.deepEqual(fileTree(f.destination), before);
        assert.equal(load(f.claudeConfig).concurrent.marker, 'unrelated-late-change'); assert.match(fs.readFileSync(f.codexConfig, 'utf8'), /unrelated-late-change/); preserved(f);
      }
    });
    await t.test('second target failure rolls back first target and only Codex-owned tables, not late unrelated data', t => {
      const f = pc(t); success(invoke(f, shell, { Target: 'Both' })); const original = f.entry(); const oldTables = codexParts(fs.readFileSync(f.codexConfig, 'utf8')).owned; const before = fileTree(f.destination);
      f.control({ fail: 'codex-add', failAfterWrite: true, mutateOn: 'codex-add' });
      failure(invoke(f, shell, { Target: 'Both', Model: 'opus[1m]' }), 'INSTALL_CODEX_ADD');
      assert.deepEqual(f.entry(), original); assert.equal(codexParts(fs.readFileSync(f.codexConfig, 'utf8')).owned, oldTables);
      assert.match(fs.readFileSync(f.codexConfig, 'utf8'), /unrelated-late-change/); assert.equal(load(f.claudeConfig).concurrent.marker, 'unrelated-late-change'); assert.deepEqual(fileTree(f.destination), before); preserved(f);
    });
    await t.test('timeout helper failure restores exact Codex section and whole package files', t => {
      const f = pc(t); success(invoke(f, shell, { Target: 'Both' })); const oldTables = codexParts(fs.readFileSync(f.codexConfig, 'utf8')).owned; const before = fileTree(f.destination); const original = f.entry();
      write(path.join(f.source, 'bridge', 'configure-timeout.js'), 'process.exit(37);\n');
      f.control({ mutateOn: 'codex-add' }); failure(invoke(f, shell, { Target: 'Both', Model: 'opus[1m]' }), 'INSTALL_CODEX_TIMEOUT');
      assert.equal(codexParts(fs.readFileSync(f.codexConfig, 'utf8')).owned, oldTables); assert.deepEqual(f.entry(), original); assert.deepEqual(fileTree(f.destination), before); assert.match(fs.readFileSync(f.codexConfig, 'utf8'), /unrelated-late-change/);
    });
    await t.test('failed first installation removes only its own registrations and managed files', t => {
      const f = pc(t); f.control({ fail: 'codex-add', failAfterWrite: true, mutateOn: 'codex-add' });
      failure(invoke(f, shell, { Target: 'Both' }), 'INSTALL_CODEX_ADD'); assert.equal(f.entry(), undefined); assert.equal(codexParts(fs.readFileSync(f.codexConfig, 'utf8')).owned, '');
      assert.deepEqual(fileTree(f.destination), {}); assert.ok(!fs.existsSync(f.skills())); assert.equal(load(f.claudeConfig).concurrent.marker, 'unrelated-late-change'); preserved(f);
    });
    await t.test('unrecoverable native add failure keeps original entry in an explicit recovery backup', t => {
      const f = pc(t); success(invoke(f, shell, { Target: 'Claude' })); const original = f.entry(); const before = fileTree(f.destination);
      f.control({ fail: 'claude-add-json', failAlways: true }); const result = invoke(f, shell, { Target: 'Claude', Model: 'opus[1m]' }); failure(result, 'automatic rollback incomplete');
      const backup = backupDirs(f).find(dir => fs.existsSync(path.join(dir, 'recovery.json')) && load(path.join(dir, 'recovery.json')).pending.length);
      assert.ok(backup); assert.deepEqual(load(path.join(backup, 'claude-registration.json')).entry, original); assert.deepEqual(fileTree(f.destination), before); preserved(f);
    });
    await t.test('concurrent modification of an owned file is preserved rather than overwritten during rollback', t => {
      const f = pc(t); success(invoke(f, shell, { Target: 'Claude' })); const target = path.join(f.destination, 'index.js'); write(path.join(f.source, 'bridge', 'index.js'), '// update\n');
      f.control({ fail: 'claude-add-json', failAfterWrite: true, mutateOn: 'claude-add-json', mutateFile: target });
      failure(invoke(f, shell, { Target: 'Claude', Model: 'opus[1m]' }), 'automatic rollback incomplete'); assert.equal(fs.readFileSync(target, 'utf8'), 'concurrent-owned-file-edit'); preserved(f);
    });
    await t.test('concurrent skill edit during npm is not overwritten', t => {
      const f = pc(t); success(invoke(f, shell, { Target: 'Claude' })); f.control({ mutateOn: 'npm', mutateFile: f.skills() });
      failure(invoke(f, shell, { Target: 'Claude' }), 'INSTALL_CONCURRENT_FILE_CHANGE'); assert.equal(fs.readFileSync(f.skills(), 'utf8'), 'concurrent-owned-file-edit'); preserved(f);
    });
    await t.test('native remove/add failures before writing restore the original registration', t => {
      for (const fail of ['claude-remove', 'claude-add-json']) {
        const f = pc(t, fail); success(invoke(f, shell, { Target: 'Claude' })); const original = f.entry();
        f.control({ fail, mutateOn: fail }); failure(invoke(f, shell, { Target: 'Claude', Model: 'opus[1m]' }), 'INSTALL_CLAUDE_');
        assert.deepEqual(f.entry(), original); assert.equal(load(f.claudeConfig).concurrent.marker, 'unrelated-late-change'); preserved(f);
      }
    });
    await t.test('Codex verification exit failure restores both registrations and preserves unrelated changes', t => {
      const f = pc(t); success(invoke(f, shell, { Target: 'Both' })); const original = f.entry(); const tables = codexParts(fs.readFileSync(f.codexConfig, 'utf8')).owned;
      f.control({ fail: 'codex-get', failOnCall: 2, mutateOn: 'codex-add' });
      failure(invoke(f, shell, { Target: 'Both', Model: 'opus[1m]' }), 'INSTALL_CODEX_GET');
      assert.deepEqual(f.entry(), original); assert.equal(codexParts(fs.readFileSync(f.codexConfig, 'utf8')).owned, tables); assert.match(fs.readFileSync(f.codexConfig, 'utf8'), /unrelated-late-change/); preserved(f);
    });
    await t.test('explicit decomposed-Unicode native profile is rejected rather than silently normalized', t => {
      const f = pc(t); const child = path.join(f.home, 'café'); fs.mkdirSync(child);
      failure(invoke(f, shell, { Target: 'Claude', NativeConfigRoot: child }), 'INSTALL_NATIVE_ROOT'); assert.deepEqual(f.calls(), []); preserved(f);
    });
    await t.test('custom CodexRoot changes installation/state only and restores inherited CODEX_HOME', t => {
      const f = pc(t); const root = path.join(f.home, 'custom install root 日本'); const config = path.join(root, 'config.toml');
      f.control({ codexConfig: config }); success(invoke(f, shell, { Target: 'Both', CodexRoot: root }));
      assert.equal(f.entry().env.CLAUDE_BRIDGE_STATE_DIR, path.join(root, 'state', 'claude-bridge'));
      const call = f.calls().find(call => call.actor === 'codex'); assert.equal(call.env.CODEX_HOME, root);
      for (const call of f.calls().filter(call => call.actor === 'claude')) assert.equal(call.env.CODEX_HOME, f.env.CODEX_HOME);
      preserved(f);
    });
    await t.test('new upstream names cannot overwrite differing unowned destinations under a manifest', t => {
      const f = pc(t); success(invoke(f, shell, { Target: 'Both' }));
      const original = f.entry(); const tables = fs.readFileSync(f.codexConfig);
      for (const name of ['new-feature.js', path.join('lib', 'new-feature.js')]) {
        write(path.join(f.destination, name), '// user-owned, not recorded by the installer\n');
        write(path.join(f.source, 'bridge', name), '// new upstream implementation\n');
      }
      write(path.join(f.source, 'bridge', 'index.js'), '// proposed update must not be written\n');
      const before = fileTree(f.destination); const calls = f.calls().length; const backups = backupDirs(f);
      failure(invoke(f, shell, { Target: 'Both', Model: 'opus[1m]' }), 'INSTALL_FILE_COLLISION');
      assert.deepEqual(fileTree(f.destination), before); assert.deepEqual(f.entry(), original);
      assert.deepEqual(fs.readFileSync(f.codexConfig), tables); assert.deepEqual(backupDirs(f), backups);
      assert.deepEqual(f.calls().slice(calls).filter(call => call.actor !== 'codex').map(call => call.actor), ['npm', 'doctor']);
      assert.ok(!f.calls().slice(calls).some(call => ['add', 'add-json', 'remove'].includes(call.args[1]))); preserved(f);
    });
    await t.test('new absent or identical names may be adopted, updated and rolled back without touching unowned files', t => {
      const f = pc(t); success(invoke(f, shell, { Target: 'Both' }));
      const identical = 'identical-new.js'; const absent = path.join('lib', 'absent-new.js');
      write(path.join(f.destination, identical), '// identical\n'); write(path.join(f.source, 'bridge', identical), '// identical\n');
      write(path.join(f.source, 'bridge', absent), '// absent upstream\n');
      write(path.join(f.destination, 'private.txt'), 'private untouched');
      success(invoke(f, shell, { Target: 'Both' }));
      const manifest = load(path.join(f.destination, '.claude-bridge-install.json'));
      assert.ok(Object.hasOwn(manifest.files, identical)); assert.ok(Object.hasOwn(manifest.files, absent));
      write(path.join(f.source, 'bridge', identical), '// owned update\n');
      success(invoke(f, shell, { Target: 'Both', Model: 'opus[1m]' }));
      const before = fileTree(f.destination); const original = f.entry();
      write(path.join(f.source, 'bridge', absent), '// failed owned update\n');
      f.control({ fail: 'codex-add', failAfterWrite: true });
      const result = invoke(f, shell, { Target: 'Both', TimeoutSeconds: 11 }); failure(result, 'INSTALL_CODEX_ADD');
      assert.match(result.output, /owned changes rolled back/); assert.deepEqual(fileTree(f.destination), before);
      assert.deepEqual(f.entry(), original); assert.equal(fs.readFileSync(path.join(f.destination, 'private.txt'), 'utf8'), 'private untouched'); preserved(f);
    });
    await t.test('legacy adoption remains separate; an empty existing manifest cannot bypass collision checks', t => {
      const f = pc(t); success(invoke(f, shell, { Target: 'Claude' }));
      const manifest = path.join(f.destination, '.claude-bridge-install.json'); fs.unlinkSync(manifest);
      write(path.join(f.destination, 'index.js'), '// legacy installation\n');
      success(invoke(f, shell, { Target: 'Claude' }));
      assert.equal(fs.readFileSync(path.join(f.destination, 'index.js'), 'utf8'), '// Offline installer fixture; never a real MCP server.\n');
      write(manifest, '{}'); const before = fileTree(f.destination);
      failure(invoke(f, shell, { Target: 'Claude' }), 'INSTALL_INVALID_MANIFEST');
      assert.deepEqual(fileTree(f.destination), before); preserved(f);
    });
    await t.test('unrelated target-like headers survive first install, update and rollback', t => {
      for (const Target of ['Codex', 'Both']) {
        const f = pc(t, Target);
        const unrelated = '\n[projects."C:/work/claude_bridge"]\ntrust_level = "trusted"\nclaude_bridge = "unrelated project property"\n\n[mcp_servers.claude_bridge_aux]\ncommand = "unrelated-auxiliary"\nargs = []\n\n["mcp_servers"."claude_bridge_aux".env] # claude_bridge\nX = "preserve"\n\n[mcp_servers]\nother_inline = { command = "keep inline sibling" }\n';
        fs.appendFileSync(f.codexConfig, unrelated);
        success(invoke(f, shell, { Target }));
        success(invoke(f, shell, { Target, Model: 'opus[1m]' }));
        const oldTables = codexParts(fs.readFileSync(f.codexConfig, 'utf8')).owned;
        f.control({ fail: 'codex-add', failAfterWrite: true, mutateOn: 'codex-add' });
        const result = invoke(f, shell, { Target, TimeoutSeconds: 12 }); failure(result, 'INSTALL_CODEX_ADD');
        assert.match(result.output, /owned changes rolled back/);
        const after = fs.readFileSync(f.codexConfig, 'utf8');
        assert.ok(after.includes(unrelated)); assert.match(after, /unrelated-late-change/);
        assert.equal(codexParts(after).owned, oldTables); preserved(f);
      }
    });
    const quoteCases = multilineQuoteCases();
    for (const { name, source } of [...quoteCases.slice(0, 4), {
      name: 'escaped quotes, backslash parity, comments, target-like text and arrays',
      source: quoteCases.slice(4).map(({ source }, index) => source.replace(/^(developer_instructions|instructions)/, `instructions_${index}`)).join(''),
    }]) {
      await t.test(`valid TOML ${name}: Both install, update, rollback and recovery`, t => {
        const f = pc(t, 'TOML-quotes');
        write(f.codexConfig, source + fs.readFileSync(f.codexConfig, 'utf8'));
        success(invoke(f, shell, { Target: 'Both' }));
        assert.ok(fs.readFileSync(f.codexConfig, 'utf8').startsWith(source));
        write(path.join(f.source, 'bridge', 'index.js'), '// quote regression update\n');
        success(invoke(f, shell, { Target: 'Both', Model: 'opus[1m]' }));
        assert.equal(f.entry().env.CLAUDE_BRIDGE_MODEL, 'opus[1m]');
        const original = f.entry(); const before = fileTree(f.destination);
        const tables = codexParts(fs.readFileSync(f.codexConfig, 'utf8')).owned;
        write(path.join(f.source, 'bridge', 'index.js'), '// quote regression failed update\n');
        f.control({ fail: 'codex-add', failAfterWrite: true, mutateOn: 'codex-add' });
        const result = invoke(f, shell, { Target: 'Both', TimeoutSeconds: 12 });
        failure(result, 'INSTALL_CODEX_ADD'); assert.match(result.output, /owned changes rolled back/);
        const after = fs.readFileSync(f.codexConfig, 'utf8');
        assert.ok(after.startsWith(source)); assert.match(after, /unrelated-late-change/);
        assert.equal(codexParts(after).owned, tables);
        assert.deepEqual(f.entry(), original); assert.deepEqual(fileTree(f.destination), before);
        f.control({ fail: undefined, mutateOn: undefined });
        success(invoke(f, shell, { Target: 'Both', TimeoutSeconds: 12 }));
        assert.ok(fs.readFileSync(f.codexConfig, 'utf8').startsWith(source));
        assert.equal(f.entry().env.CLAUDE_BRIDGE_TIMEOUT_MS, '12000');
        assert.equal(fs.readFileSync(path.join(f.destination, 'index.js'), 'utf8'), '// quote regression failed update\n');
        preserved(f);
      });
    }
    await t.test('real target headers after four/five-quote endings still collide or reject before writes', t => {
      for (const { source } of quoteCases.slice(0, 4)) {
        for (const header of ['[mcp_servers.claude_bridge]', '[mcp_servers."claude_bridge"]']) {
          const f = pc(t, 'TOML-real-target');
          write(f.codexConfig, source + fs.readFileSync(f.codexConfig, 'utf8') + `${header}\ncommand = "foreign"\nargs = []\n`);
          const codexBefore = fs.readFileSync(f.codexConfig); const claudeBefore = fs.readFileSync(f.claudeConfig);
          const canonical = header === '[mcp_servers.claude_bridge]';
          failure(invoke(f, shell, { Target: 'Both' }), canonical ? 'INSTALL_REGISTRATION_COLLISION' : 'INSTALL_CODEX_NONCANONICAL_CONFIG');
          assert.deepEqual(fs.readFileSync(f.codexConfig), codexBefore); assert.deepEqual(fs.readFileSync(f.claudeConfig), claudeBefore);
          assert.deepEqual(f.calls().map(call => [call.actor, call.args[1]]), canonical ? [['codex', 'get']] : []);
          assert.ok(!fs.existsSync(f.destination)); preserved(f);
        }
      }
    });
    await t.test('noncanonical true target paths still reject before any external command', t => {
      for (const stanza of [
        '[mcp_servers."claude_bridge"]\ncommand = "foreign"\n',
        '["mcp_servers" . \'claude_bridge\']\ncommand = "foreign"\n',
        '[mcp_servers."claude_\\u0062ridge"]\ncommand = "foreign"\n',
        '[mcp_servers."claude_\\U00000062ridge"]\ncommand = "foreign"\n',
        '[[mcp_servers.claude_bridge]]\ncommand = "foreign"\n',
        '[mcp_servers]\n"claude_bridge" = { command = "foreign" }\n',
      ]) {
        const f = pc(t, 'noncanonical'); fs.appendFileSync(f.codexConfig, '\n' + stanza);
        const before = fs.readFileSync(f.codexConfig);
        failure(invoke(f, shell, { Target: 'Both' }), 'INSTALL_CODEX_NONCANONICAL_CONFIG');
        assert.deepEqual(fs.readFileSync(f.codexConfig), before); assert.deepEqual(f.calls(), []); preserved(f);
      }
    });
    await t.test('option-like AllowedTools reject before install or registration while parenthesized CLI flags remain data', t => {
      const f = pc(t, 'allowed-tools', { codex: false });
      for (const AllowedTools of [['Read', '--model', 'claude-unsupported'], ['Read', '--no-session-persistence'], ['  --settings={}'], ['-p'], ['--'], [''], ['Read\t--model']]) {
        failure(invoke(f, shell, { Target: 'Both', SkipRegister: true, AllowedTools }), 'INSTALL_INVALID_OPTIONS');
        assert.deepEqual(f.calls(), []); assert.ok(!fs.existsSync(f.destination)); preserved(f);
      }
      const tools = ['Read', 'Bash(git log --format="%H" --oneline:*)', 'Bash(echo --model --no-session-persistence:*)'];
      success(invoke(f, shell, { Target: 'Claude', AllowedTools: tools }));
      assert.deepEqual(JSON.parse(f.entry().env.CLAUDE_BRIDGE_ALLOWED_TOOLS), tools); preserved(f);
    });
    for (const mutation of ['env', 'command', 'field', 'subtable', 'comment', 'delete']) {
      for (const failedAdd of [true, false]) {
        await t.test(`unexpected Codex ${mutation} after ${failedAdd ? 'failed' : 'successful'} add is preserved with incomplete recovery`, t => {
          const f = pc(t); success(invoke(f, shell, { Target: 'Both' }));
          const original = f.entry(); const oldTables = codexParts(fs.readFileSync(f.codexConfig, 'utf8')).owned;
          const before = fileTree(f.destination); const originalBackups = Object.fromEntries(backupDirs(f).map(dir => [dir, fileTree(dir)]));
          write(path.join(f.source, 'bridge', 'index.js'), '// must roll back managed file update\n');
          const evidence = path.join(f.base, 'concurrent-codex.toml');
          f.control({ fail: failedAdd ? 'codex-add' : undefined, failAfterWrite: true, mutateOn: 'codex-add', codexMutation: mutation, concurrentEvidence: evidence });
          const result = invoke(f, shell, { Target: 'Both', Model: 'opus[1m]' });
          failure(result, failedAdd ? 'INSTALL_CODEX_ADD' : 'INSTALL_CODEX_VERIFY');
          assert.match(result.output, /automatic rollback incomplete/); assert.ok(!result.output.includes('(owned changes rolled back)'));
          // Independent fixture evidence proves the later write existed before rollback.
          const written = fs.readFileSync(evidence, 'utf8');
          assert.notEqual(codexParts(written).owned, oldTables);
          assert.equal(fs.readFileSync(f.codexConfig, 'utf8'), written);
          assert.deepEqual(f.entry(), original); assert.deepEqual(fileTree(f.destination), before);
          assert.equal(load(f.claudeConfig).concurrent.marker, 'unrelated-late-change'); assert.match(written, /unrelated-late-change/);
          const recovery = backupDirs(f).filter(dir => !Object.hasOwn(originalBackups, dir)); assert.equal(recovery.length, 1);
          assert.deepEqual(load(path.join(recovery[0], 'recovery.json')).pending, ['Codex registration']);
          assert.equal(load(path.join(recovery[0], 'codex-registration.json')).tables, oldTables);
          assert.deepEqual(load(path.join(recovery[0], 'claude-registration.json')).entry, original);
          for (const [dir, bytes] of Object.entries(originalBackups)) assert.deepEqual(fileTree(dir), bytes);
          preserved(f);
        });
      }
    }
    await t.test('Codex failure before writing restores other owned changes without stale table rewrites', t => {
      const f = pc(t); success(invoke(f, shell, { Target: 'Both' }));
      const original = f.entry(); const oldTables = codexParts(fs.readFileSync(f.codexConfig, 'utf8')).owned; const before = fileTree(f.destination);
      write(path.join(f.source, 'bridge', 'index.js'), '// failed update\n'); f.control({ fail: 'codex-add', mutateOn: 'codex-add' });
      const result = invoke(f, shell, { Target: 'Both', Model: 'opus[1m]' }); failure(result, 'INSTALL_CODEX_ADD'); assert.match(result.output, /owned changes rolled back/);
      assert.deepEqual(f.entry(), original); assert.deepEqual(fileTree(f.destination), before);
      assert.equal(codexParts(fs.readFileSync(f.codexConfig, 'utf8')).owned.trimEnd(), oldTables.trimEnd()); assert.match(fs.readFileSync(f.codexConfig, 'utf8'), /unrelated-late-change/); preserved(f);
    });
    await t.test('managed-file collision and install lock fail without clobbering the target', t => {
      const f = pc(t); success(invoke(f, shell, { Target: 'Claude' })); const file = path.join(f.destination, 'index.js'); write(file, 'user customization');
      failure(invoke(f, shell, { Target: 'Claude' }), 'INSTALL_FILE_COLLISION'); assert.equal(fs.readFileSync(file, 'utf8'), 'user customization');
      const lock = path.join(path.dirname(f.destination), '.claude-bridge-install.lock'); write(lock, 'another installer'); failure(invoke(f, shell, { Target: 'Claude' }), 'INSTALL_LOCKED'); assert.equal(fs.readFileSync(lock, 'utf8'), 'another installer'); preserved(f);
    });
  });
}

test('Codex narrow section restoration preserves unrelated interleaved tables and rejects target drift', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-section-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'config.toml');
  write(file, 'model = "keep"\n[mcp_servers.claude_bridge]\ncommand = "old"\n[mcp_servers.other]\ncommand = "unrelated-late"\n[mcp_servers.claude_bridge.env]\nX = "old"\n');
  const before = codexParts(fs.readFileSync(file, 'utf8')).owned;
  replaceCodex(file, before, '[mcp_servers.claude_bridge]\ncommand = "restored"\n');
  assert.match(fs.readFileSync(file, 'utf8'), /command = "unrelated-late"/); assert.match(fs.readFileSync(file, 'utf8'), /model = "keep"/);
  assert.throws(() => replaceCodex(file, before, ''), /CONCURRENT_REGISTRATION_CHANGE/);
});

test('prepareOptions model catalogue defaults are explicit and child root omission is not parent inheritance', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-options-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = { target: 'Claude', allowedTools: [], permissionMode: 'dontAsk', timeoutSeconds: 900, model: 'opus', codexRoot: path.join(directory, 'codex'), cwd: directory, sourceRoot: path.join(directory, 'source'), nodeExe: process.execPath, claudeExe: path.join(directory, 'claude.exe'), skillRoot: path.join(directory, 'skills') };
  const env = { USERPROFILE: directory, CLAUDE_CONFIG_DIR: directory, CLAUDE_BRIDGE_MODEL: 'untrusted-parent' };
  const options = prepareOptions(input, env); assert.equal(options.server.env.CLAUDE_BRIDGE_MODEL, 'opus'); assert.ok(!Object.hasOwn(options.server.env, 'CLAUDE_BRIDGE_CONFIG_DIR')); assert.deepEqual(env, { USERPROFILE: directory, CLAUDE_CONFIG_DIR: directory, CLAUDE_BRIDGE_MODEL: 'untrusted-parent' });
  assert.throws(() => prepareOptions({ ...input, model: 'inherit' }, env), /INSTALL_MODEL/);
  for (const tool of ['--model', '--no-session-persistence', '  -p', '--', '', '   ', 'Read\t--model', '\0Read', null, 1]) {
    assert.throws(() => prepareOptions({ ...input, allowedTools: ['Read', tool] }, env), /INSTALL_INVALID_OPTIONS/);
  }
  const rules = ['Read', 'Bash(git log --oneline:*)', 'Bash(echo --settings={}:*)'];
  assert.equal(prepareOptions({ ...input, allowedTools: rules }, env).server.env.CLAUDE_BRIDGE_ALLOWED_TOOLS, JSON.stringify(rules));
});
