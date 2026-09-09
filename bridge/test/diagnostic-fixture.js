'use strict';
// Private test-only module seams. Production doctor/smoke never load this file.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');

function privateModule(relative, suffix = '', replacements = {}) {
  const filename = path.resolve(__dirname, relative);
  const loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const ordinaryRequire = loaded.require.bind(loaded);
  loaded.require = name => Object.hasOwn(replacements, name) ? replacements[name] : ordinaryRequire(name);
  loaded._compile(fs.readFileSync(filename, 'utf8') + '\n' + suffix, filename);
  return loaded.exports;
}
function profile(t) {
  // Canonicalize only our newly created root, before deriving any profile paths.
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-diagnostic-')));
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => /^(SystemRoot|WINDIR|PATH|PATHEXT|COMSPEC)$/i.test(name)));
  Object.assign(env, { HOME: root, USERPROFILE: root, APPDATA: path.join(root, 'appdata'),
    LOCALAPPDATA: path.join(root, 'localappdata'), TEMP: root, TMP: root,
    CLAUDE_BRIDGE_COMMAND: path.join(root, 'missing-claude.exe'), CLAUDE_BRIDGE_STATE_DIR: path.join(root, 'state') });
  for (const directory of [env.APPDATA, env.LOCALAPPDATA]) fs.mkdirSync(directory);
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return { root, env };
}
async function capture(action) {
  let stdout = '', stderr = '';
  const out = process.stdout.write, err = process.stderr.write;
  process.stdout.write = value => { stdout += value; return true; };
  process.stderr.write = value => { stderr += value; return true; };
  try { return { code: await action(), get stdout() { return stdout; }, get stderr() { return stderr; } }; }
  finally { process.stdout.write = out; process.stderr.write = err; }
}
module.exports = { privateModule, profile, capture };

// Stdio failure fixtures: launched only by diagnostic tests, never by public flags.
if (require.main === module) {
  process.stderr.write('SYNTHETIC_DIAGNOSTIC_SECRET\n');
  if (process.argv[2] === 'hang') { process.stdin.resume(); setInterval(() => {}, 1000); }
  else { process.stdout.write('not MCP JSON\n'); process.exitCode = 1; }
}
