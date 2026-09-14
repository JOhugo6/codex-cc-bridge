'use strict';
// Optional C-only observer preload for independent synthetic tests. No production
// imports this fixture. It observes existing private seams, never weakens guards,
// reads a credential file, changes policy, retries or supplies native transport.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const evidence = process.env.C_NATIVE_OBSERVER_DIR;
const runtimeFile = path.resolve(__dirname, '../lib/native-runtime.js');
const integrationFile = path.resolve(__dirname, 'runtime-integration-fixture.js');
let count = 0, sequence = 0;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function record(event) {
  if (!evidence) return;
  if (count++ > 200000) return;
  fs.appendFileSync(path.join(evidence, `observer-${process.pid}.jsonl`), JSON.stringify({ sequence: ++sequence,
    ...event, ...(count === 200001 ? { truncated: true } : {}) }) + '\n');
}
function instrument(api) {
  const original = api.createRuntime;
  api.createRuntime = (options, deps) => {
    const root = options?.parentEnv?.USERPROFILE || options?.parentEnv?.HOME;
    // Leave unit/invalid-input paths entirely untouched; observe native fixtures only.
    if (typeof root !== 'string' || !/^native-contract-a1-/.test(path.basename(root))) return original(options, deps);
    const label = file => {
      const resolved = path.resolve(file);
      const relative = path.relative(root, resolved);
      return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : `outside-${digest(resolved)}`;
    };
    let phase = 'sources';
    const globalDescriptors = new Map();
    const stamp = s => ({ dev: String(s.dev), ino: String(s.ino), mode: s.mode, size: s.size,
      mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, birthtimeMs: s.birthtimeMs, directory: s.isDirectory(), symlink: s.isSymbolicLink() });
    const observe = (kind, file, value) => {
      if (kind === 'openSync') {
        globalDescriptors.set(value, file); record({ phase, file: label(file), kind });
      } else if (['fstatSync', 'readSync', 'closeSync'].includes(kind)) {
        const filename = globalDescriptors.get(file);
        if (!filename) throw new Error('Unowned fd in synthetic observer');
        record({ phase, file: label(filename), kind });
        if (kind === 'closeSync') globalDescriptors.delete(file);
      } else if (kind.toLowerCase().includes('readfile')) {
        // Existing checkedFs forbids credential content; do not initiate reads.
        if (/\.credentials\.json$|\.claude\.json$|[\\/]Anthropic[\\/]/i.test(String(file))) throw new Error('Unexpected unbounded global or credential read in private seam');
        record({ phase, file: label(file), kind, sha256: digest(value) });
      } else if (kind.toLowerCase().includes('readdir')) {
        const names = value.map(v => typeof v === 'string' ? v : v.name).sort();
        record({ phase, file: label(file), kind, inventory: names, sha256: digest(JSON.stringify(names)) });
      } else if (kind.toLowerCase().includes('stat')) record({ phase, file: label(file), kind, metadata: stamp(value) });
    };
    const wrapFs = (source, synchronous) => Object.fromEntries(Object.entries(source).map(([name, fn]) => [name,
      synchronous ? function (...args) {
        try { const value = fn.apply(source, args); observe(name, args[0], value); return value; }
        catch (e) { record({ phase, kind: name, file: typeof args[0] === 'number' ? 'global-fd' : label(args[0]), error: ['ENOENT', 'ENOTDIR'].includes(e.code) ? e.code : 'ERROR' }); throw e; }
      } : async function (...args) {
        try { const value = await fn.apply(source, args); observe(name, args[0], value); return value; }
        catch (e) { record({ phase, kind: name, file: label(args[0]), error: ['ENOENT', 'ENOTDIR'].includes(e.code) ? e.code : 'ERROR' }); throw e; }
      }]));
    const wrapped = { ...deps, fs: wrapFs(deps.fs, false), syncFs: wrapFs(deps.syncFs, true),
      async registry(...args) { const value = await deps.registry(...args); record({ phase, kind: 'registry', sha256: digest(JSON.stringify(value)) }); return value; },
      async execute(command, args, context) {
        phase = args.includes('--version') ? 'version' : args.includes('--help') ? 'help' : args.includes('doctor') ? 'doctor' : 'auth';
        record({ phase, kind: 'metadata-start' });
        try { return await deps.execute(command, args, context); }
        finally { record({ phase, kind: 'metadata-end' }); phase += '-sources'; }
      },
    };
    const runtime = original(options, wrapped);
    return Object.freeze({ async preflight(input) {
      record({ kind: 'preflight-start', profile: digest(root) });
      try { const prepared = await runtime.preflight(input); record({ kind: 'preflight-accepted', account: prepared.identity.accountFingerprint }); return prepared; }
      catch (e) { record({ kind: 'preflight-refused', code: /^NATIVE_[A-Z_]+$/.test(e.code) ? e.code : 'OTHER' }); throw e; }
    } });
  };
}
module.exports = { instrument };
if (evidence) {
  if (!path.isAbsolute(evidence) || !fs.statSync(evidence).isDirectory() || !/^package-c-|^native-observer-/.test(path.basename(evidence))) throw new Error('Dedicated evidence directory required');
  const compile = Module.prototype._compile;
  Module.prototype._compile = function (source, filename) {
    if (path.resolve(filename) === runtimeFile && source.includes('module.exports.private =')) {
      source += `\nrequire(${JSON.stringify(__filename)}).instrument(module.exports.private);`;
    }
    if (path.resolve(filename) === integrationFile) {
      source += `\nconst cOriginalConnect = module.exports.connectNative; module.exports.connectNative = (f, options = {}) => cOriginalConnect(f, { ...options, NODE_OPTIONS: ${JSON.stringify('--require "' + __filename.split(path.sep).join('/') + '"')}, C_NATIVE_OBSERVER_DIR: ${JSON.stringify(evidence)} });`;
    }
    return compile.call(this, source, filename);
  };
}
