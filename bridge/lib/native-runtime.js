'use strict';

// Native Windows adapter for Claude Code stable releases newer than 2.1.263.
// This is a settings/launch contract, NOT an OS sandbox or an atomic policy lock.
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { fail } = require('./config');
const { isSupportedVersion, parseVersionOutput } = require('./native-version');

const RUNTIME_CONTRACT = 'native-windows-personal/2.1.263/v1';
const TEAM_RUNTIME_CONTRACT = 'native-windows-team/304-policy-snapshot/v1';
const FIRST_PARTY = 'https://api.anthropic.com';
// Only IDs exercised by this contract are admitted. Expansion requires native tests.
const MODEL_CATALOG = Object.freeze({ opus: 'claude-opus-5[1m]', 'opus[1m]': 'claude-opus-5[1m]',
  'claude-opus-5': 'claude-opus-5', 'claude-opus-5[1m]': 'claude-opus-5[1m]' });
const FLAGS = Object.freeze(['--model', '--settings', '--strict-mcp-config', '--mcp-config', '--print', '--input-format', '--output-format']);
const REMOTE_PERSONAL = 'Managed settings (remote): not fetched — requires an Enterprise or Team subscription';
const ORG_PERSONAL = 'Organization policy: not applicable to Pro and Max accounts';
const LIMIT = 256 * 1024;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const error = code => fail(code, {
  NATIVE_INPUT: 'Invalid native runtime input.',
  NATIVE_MODEL: 'Unsupported model. Select a model from the native runtime catalog.',
  NATIVE_SOURCE: 'Native settings source is malformed, unreadable, or unsupported. No task submitted.',
  NATIVE_CONFLICT: 'Native routing, authentication, or dynamic policy conflicts with this runtime. No task submitted.',
  NATIVE_ROOT: 'Native profile root is unsupported. Preserve the standard root or explicitly select an existing native profile.',
  NATIVE_PLATFORM: 'This native runtime contract supports Windows only.',
  NATIVE_COMPATIBILITY: 'Native executable requires Claude Code newer than 2.1.263 and the supported runtime flags.',
  NATIVE_AUTH: 'A saved first-party Pro, Max, or Team login is required; gateway and environment logins are unsupported.',
  NATIVE_POLICY: 'Native account policy eligibility or a fresh Team policy snapshot could not be established. No task submitted.',
  NATIVE_DIAGNOSTIC: 'Native metadata command failed or exceeded its bounds. No task submitted.',
  NATIVE_DRIFT: 'Native sources or profile identity changed before submission. Run preflight again.',
}[code] || 'Native runtime validation failed.');

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

// Pure validation: safe for request validation / completed-request replay without auth.
function resolveModel(model, configuredModel) {
  const selected = model === undefined ? (configuredModel === undefined ? 'opus' : configuredModel) : model;
  if (typeof selected !== 'string' || !Object.hasOwn(MODEL_CATALOG, selected)) throw error('NATIVE_MODEL');
  return MODEL_CATALOG[selected];
}

const PROVIDERS = ['BEDROCK', 'VERTEX', 'FOUNDRY', 'ANTHROPIC_AWS', 'ANTHROPIC_GOOGLE_CLOUD', 'MANTLE', 'GATEWAY'];
// Each pin is supplied both at process creation and in the highest ordinary settings
// tier. Deletion from the initial environment alone does NOT survive settings reload.
const EMPTY_PINS = `ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
  CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR
  CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR
  ANTHROPIC_CUSTOM_HEADERS ANTHROPIC_UNIX_SOCKET ANTHROPIC_PROFILE
  ANTHROPIC_FEDERATION_RULE_ID ANTHROPIC_ORGANIZATION_ID ANTHROPIC_WORKSPACE_ID
  ANTHROPIC_BEDROCK_BASE_URL ANTHROPIC_VERTEX_BASE_URL ANTHROPIC_FOUNDRY_BASE_URL
  ANTHROPIC_AWS_BASE_URL ANTHROPIC_GOOGLE_CLOUD_BASE_URL ANTHROPIC_BEDROCK_MANTLE_BASE_URL
  ANTHROPIC_AWS_API_KEY ANTHROPIC_FOUNDRY_API_KEY ANTHROPIC_FOUNDRY_AUTH_TOKEN
  ANTHROPIC_CUSTOM_MODEL_OPTION ANTHROPIC_SMALL_FAST_MODEL
  CLAUDE_CODE_OAUTH_REFRESH_TOKEN CLAUDE_CODE_CUSTOM_OAUTH_URL
  HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY ANTHROPIC_API_KEY_HELPER CLAUDE_CODE_API_KEY_HELPER
  CLAUDE_CODE_HOST_AUTH_ENV_VAR CLAUDE_CODE_HOST_CREDS_FILE CLAUDE_CODE_ENVIRONMENT_KIND
  CLAUDE_BG_AUTH_SNAPSHOT_PATH CLAUDE_BG_SOCKET_TOKENS_PATH CLAUDE_BG_RV_AUTH CLAUDE_BG_PTY_AUTH CLAUDE_BG_CLAIM_AUTH
  CLAUDE_SESSION_INGRESS_TOKEN_FILE AGENT_PROXY_URL AGENT_PROXY_AUTH_TOKEN`.split(/\s+/);
const FALSE_PINS = ['USE_LOCAL_OAUTH', 'USE_STAGING_OAUTH', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH'];
const MODEL_PINS = `ANTHROPIC_MODEL ANTHROPIC_DEFAULT_MODEL ANTHROPIC_DEFAULT_OPUS_MODEL
  ANTHROPIC_DEFAULT_SONNET_MODEL ANTHROPIC_DEFAULT_HAIKU_MODEL ANTHROPIC_DEFAULT_FABLE_MODEL
  CLAUDE_CODE_SUBAGENT_MODEL CLAUDE_CODE_SUBAGENT_MODEL_FORCE`.split(/\s+/);
const PIN_NAMES = new Set([...EMPTY_PINS, ...FALSE_PINS, ...MODEL_PINS, 'ANTHROPIC_BASE_URL',
  ...PROVIDERS.map(p => `CLAUDE_CODE_USE_${p}`), ...PROVIDERS.map(p => `CLAUDE_CODE_SKIP_${p}_AUTH`)]);
const ROOT_NAMES = new Set(`HOME USERPROFILE APPDATA LOCALAPPDATA HOMEDRIVE HOMEPATH SYSTEMROOT WINDIR PROGRAMFILES PROGRAMFILES(X86) PROGRAMW6432
  CLAUDE_CONFIG_DIR CLAUDE_SECURESTORAGE_CONFIG_DIR ANTHROPIC_CONFIG_DIR XDG_CONFIG_HOME
  XDG_DATA_HOME XDG_STATE_HOME XDG_CACHE_HOME`.split(/\s+/));
const HOST_NAMES = /^(?:CLAUDE_CODE_(?:.*(?:MANAGED|POLICY|HOST_AUTH|HOST_CREDS|REMOTE_SETTINGS|MOCK_REMOTE|PROCESS_WRAPPER|FEDERATION_CACHE|PROVIDER_MANAGED|FORCE_WINDOWS_CREDMAN).*|SDK_HAS_HOST_AUTH_REFRESH|ENVIRONMENT_KIND|PROJECT_DIR_NAME|COWORK.*|REMOTE|RESTRICTED|SAFE_MODE|BARE|SKIP_PROMPT_HISTORY)|CLAUDE_BG_.*|CLAUDE_SESSION_INGRESS_TOKEN_FILE|SELF_HOSTED_.*|USE_(?:LOCAL|STAGING)_OAUTH|CLAUDE_LOCAL_OAUTH_.*|_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL)$/;
const SAFE_NATIVE_ENV = new Set(`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC CLAUDE_CODE_GIT_BASH_PATH
  CLAUDE_CODE_MAX_OUTPUT_TOKENS CLAUDE_CODE_DISABLE_TERMINAL_TITLE CLAUDE_CODE_ENABLE_TELEMETRY
  CLAUDE_CODE_TMPDIR CLAUDE_CODE_EFFORT_LEVEL CLAUDE_CODE_DISABLE_AUTO_MEMORY
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`.split(/\s+/));
const DROP_PARENT = /^(?:CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SDK_.*|CLAUDE_AGENT_SDK_.*|CLAUDE_BRIDGE_.*|AGENT_PROXY_.*|OPENAI_.*|CODEX_.*|ANTHROPIC_.*|CLAUDE_CODE_(?:CLIENT_CERT|CLIENT_KEY|CLIENT_KEY_PASSPHRASE|OAUTH_.*)|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|NODE_USE_ENV_PROXY|BUN_OPTIONS|AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|BEARER_TOKEN_BEDROCK|PROFILE|CONFIG_FILE|SHARED_CREDENTIALS_FILE|ENDPOINT_URL.*)|GOOGLE_APPLICATION_CREDENTIALS)$/;

function envEntries(env) {
  if (!object(env)) throw error('NATIVE_INPUT');
  const result = {};
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\(x86\))?$/i.test(key) || typeof value !== 'string' || value.includes('\0')) throw error('NATIVE_INPUT');
    const name = key.toUpperCase();
    if (Object.hasOwn(result, name) && result[name] !== value) throw error('NATIVE_INPUT');
    result[name] = value;
  }
  return result;
}

function prohibitedEnv(name) {
  return ROOT_NAMES.has(name) || HOST_NAMES.test(name) || PIN_NAMES.has(name) || DROP_PARENT.test(name)
    || /^(?:ANTHROPIC_|CLAUDE_|_CLAUDE_|AGENT_PROXY_|AWS_ENDPOINT_URL)/.test(name) && !SAFE_NATIVE_ENV.has(name);
}

// A versioned allowlist, not an assertion that unknown keys cannot affect routing.
const ORDINARY_FIELDS = new Set(`$schema model permissions env hooks disableAllHooks apiKeyHelper
  fallbackModel switchModelsOnFlag modelOverrides
  attribution includeCoAuthoredBy includeGitInstructions cleanupPeriodDays language outputStyle
  alwaysThinkingEnabled effortLevel autoCompactEnabled autoCompactWindow autoMemoryEnabled autoMemoryDirectory
  plansDirectory respectGitignore sandbox statusLine fileSuggestion companyAnnouncements
  spinnerTipsEnabled spinnerTipsOverride spinnerVerbs showTurnDuration showThinkingSummaries
  promptSuggestionEnabled feedbackSurveyRate autoUpdatesChannel editorMode preferredNotifChannel
  enabledPlugins extraKnownMarketplaces enabledMcpjsonServers disabledMcpjsonServers enableAllProjectMcpServers
  allowAllClaudeAiMcps allowedMcpServers deniedMcpServers allowManagedMcpServersOnly
  allowManagedHooksOnly allowManagedPermissionRulesOnly disableBundledSkills skillOverrides
  skillListingBudgetFraction skillListingMaxDescChars disableSkillShellExecution
  claudeMd claudeMdExcludes fileCheckpointingEnabled disableClaudeAiConnectors
  autoConnectIde autoInstallIdeExtension externalEditorContext defaultShell
  disableRemoteControl disableWorkflows disableCommandPluginSources disableAutoMode
  fastMode fastModePerSessionOptIn diffTool keybindingFlavor axScreenReader prefersReducedMotion
  emojiCompletionEnabled autoScrollEnabled showClearContextOnPlanAccept
  modelSettings tui theme skipDangerousModePermissionPrompt skipAutoPermissionPrompt agentPushNotifEnabled mcpServers`.split(/\s+/));
const MANAGED_FIELDS = new Set(`$schema permissions sandbox disableAllHooks allowedMcpServers deniedMcpServers
  allowManagedMcpServersOnly allowManagedHooksOnly allowManagedPermissionRulesOnly`.split(/\s+/));
const PERMISSION_FIELDS = new Set(`allow deny ask defaultMode additionalDirectories disableBypassPermissionsMode
  blockReadsOutsideWorkingDirectories`.split(/\s+/));

function validateSettings(value, { managed = false } = {}) {
  if (!object(value)) throw error('NATIVE_SOURCE');
  for (const [key, val] of Object.entries(value)) {
    if (!(managed ? MANAGED_FIELDS : ORDINARY_FIELDS).has(key)) throw error('NATIVE_CONFLICT');
    if (key === 'env') {
      for (const name of Object.keys(envEntries(val))) if (prohibitedEnv(name)) throw error('NATIVE_CONFLICT');
    }
    if (key === 'apiKeyHelper' && val !== '') throw error('NATIVE_CONFLICT');
    if (key === 'fallbackModel' && (!Array.isArray(val) || val.length)) throw error('NATIVE_CONFLICT');
    if (key === 'switchModelsOnFlag' && val !== false) throw error('NATIVE_CONFLICT');
    if (key === 'modelOverrides' && (!object(val) || Object.keys(val).length)) throw error('NATIVE_CONFLICT');
    // Per-model effort preferences do not select a provider or replace a model.
    // Keep the nested allowlist explicit: future routing fields must not slip in.
    if (key === 'modelSettings') {
      if (!object(val)) throw error('NATIVE_SOURCE');
      for (const preferences of Object.values(val)) {
        if (!object(preferences)) throw error('NATIVE_SOURCE');
        for (const [field, preference] of Object.entries(preferences)) {
          if (field !== 'effortLevel') throw error('NATIVE_CONFLICT');
          if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(preference)) throw error('NATIVE_SOURCE');
        }
      }
    }
    if (key === 'tui' && !['default', 'fullscreen'].includes(val)) throw error('NATIVE_SOURCE');
    if (key === 'theme' && typeof val !== 'string') throw error('NATIVE_SOURCE');
    if (['skipDangerousModePermissionPrompt', 'skipAutoPermissionPrompt', 'agentPushNotifEnabled'].includes(key)
        && typeof val !== 'boolean') throw error('NATIVE_SOURCE');
    // Native --strict-mcp-config selects only our explicit empty MCP config.
    // These saved definitions are preserved but never started by this runtime.
    if (key === 'mcpServers' && !object(val)) throw error('NATIVE_SOURCE');
    // A personal preferred model is preserved, but --model is authoritative. Managed
    // model preferences/allowlists are deliberately NOT overridden by this adapter.
    if (key === 'model' && (typeof val !== 'string' || !val.trim() || val.includes('\0'))) throw error('NATIVE_SOURCE');
    if (key === 'disableAllHooks' && (typeof val !== 'boolean' || managed && !val)) throw error('NATIVE_CONFLICT');
    if (['allowManagedMcpServersOnly', 'allowManagedHooksOnly', 'allowManagedPermissionRulesOnly'].includes(key) && typeof val !== 'boolean') throw error('NATIVE_SOURCE');
    if (key === '$schema' && typeof val !== 'string') throw error('NATIVE_SOURCE');
    if (key === 'permissions') {
      if (!object(val) || Object.keys(val).some(k => !PERMISSION_FIELDS.has(k))) throw error('NATIVE_SOURCE');
      if (val.defaultMode !== undefined && !['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'].includes(val.defaultMode)) throw error('NATIVE_SOURCE');
      if (val.disableBypassPermissionsMode !== undefined && val.disableBypassPermissionsMode !== 'disable') throw error('NATIVE_SOURCE');
      if (val.blockReadsOutsideWorkingDirectories !== undefined && typeof val.blockReadsOutsideWorkingDirectories !== 'boolean') throw error('NATIVE_SOURCE');
      for (const k of ['allow', 'deny', 'ask', 'additionalDirectories']) {
        if (val[k] !== undefined && (!Array.isArray(val[k]) || val[k].some(v => typeof v !== 'string'))) throw error('NATIVE_SOURCE');
      }
    }
  }
  return true;
}

// Personal accounts also cache feature availability. Presence alone does not mean
// organization policy. Admit only understood data, preserve it for native to enforce,
// and still require native doctor to establish personal-account eligibility.
function validatePersonalCache(value, kind) {
  if (!object(value)) throw error('NATIVE_SOURCE');
  if (kind === 'remote-settings.json') {
    const { channelsEnabled, ...managed } = value;
    if (channelsEnabled !== undefined && typeof channelsEnabled !== 'boolean') throw error('NATIVE_CONFLICT');
    validateSettings(managed, { managed: true });
    if (!Object.keys(value).length) throw error('NATIVE_CONFLICT');
    return;
  }
  if (Object.keys(value).some(k => !['restrictions', 'compliance_taints', 'monitoring_notice', 'defaults'].includes(k))
      || !object(value.restrictions) || !object(value.defaults)
      || !Array.isArray(value.compliance_taints) || value.compliance_taints.length
      || value.monitoring_notice !== null) throw error('NATIVE_CONFLICT');
  for (const [key, restriction] of Object.entries(value.restrictions)) {
    if (!['allow_quick_web_setup', 'enforce_web_search_mcp_isolation'].includes(key)
        || !object(restriction) || Object.keys(restriction).length !== 1
        || typeof restriction.allowed !== 'boolean') throw error('NATIVE_CONFLICT');
  }
  if (Object.keys(value.defaults).some(k => k !== 'remote_control_at_startup')
      || (value.defaults.remote_control_at_startup !== undefined && value.defaults.remote_control_at_startup !== false)) throw error('NATIVE_CONFLICT');
}

function parseSettings(text, managed, mcp = false, cache) {
  try {
    if (Buffer.byteLength(text) > LIMIT) throw error('NATIVE_SOURCE');
    const value = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (cache) { validatePersonalCache(value, cache); return; }
    if (mcp) {
      if (!object(value) || !object(value.mcpServers) || Object.keys(value).some(k => k !== 'mcpServers')) throw error('NATIVE_SOURCE');
      return;
    }
    validateSettings(value, { managed });
  } catch (e) { throw error(e.code === 'NATIVE_CONFLICT' ? e.code : 'NATIVE_SOURCE'); }
}

function statStamp(s) { return [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':'); }
function cacheStamp(s) { return [s.dev, s.ino, s.mode, s.size].join(':'); }

// Both registry views and both hives are inspected, including lower-priority values:
// native merges env from admin sources even when another source wins the policy tier.
async function registrySettings(env, execute) {
  const script = `$ErrorActionPreference='Stop'; $rows=@(); foreach($h in @('LocalMachine','CurrentUser')) { foreach($v in @('Registry64','Registry32')) { $b=$null; $k=$null; try { $b=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::$h,[Microsoft.Win32.RegistryView]::$v); $k=$b.OpenSubKey('SOFTWARE\\Policies\\ClaudeCode'); $item=@{hive=$h;view=$v;present=$false}; if($k -and ($k.GetValueNames() -contains 'Settings')) { $item.present=$true; $item.kind=$k.GetValueKind('Settings').ToString(); $item.raw=$k.GetValue('Settings',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); $item.value=$k.GetValue('Settings') }; $rows+=$item } finally { if($k){$k.Dispose()}; if($b){$b.Dispose()} } } }; ConvertTo-Json -InputObject $rows -Compress`;
  const command = path.join(env.SYSTEMROOT || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const r = await execute(command, ['-NoProfile', '-NonInteractive', '-Command', script], { cwd: env.SYSTEMROOT || 'C:\\Windows', env });
  try { return JSON.parse(r.stdout); } catch { throw error('NATIVE_SOURCE'); }
}

// No raw diagnostic output escapes this internal runner. No prompt is accepted here.
// Diagnostics cannot start task tools: helpers were rejected, hooks/MCP are disabled.
async function diagnostic(command, args, { cwd, env }) {
  if (process.platform === 'win32') {
    // Reuse the bridge's kill-on-owner-exit Job supervisor, including for metadata
    // helpers. Honor the host PowerShell execution policy; never request a bypass.
    const launch = Buffer.from(JSON.stringify({ command, args, cwd, parentPid: process.pid })).toString('base64');
    command = path.join(env.SYSTEMROOT || env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    args = ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'windows-job-runner.ps1'), '-LaunchBase64', launch];
  }
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { reject(error('NATIVE_DIAGNOSTIC')); return; }
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    let stdout = '', stderr = '', bytes = 0, failed = false;
    const stop = () => { failed = true; child.kill(); };
    const timer = setTimeout(stop, 18000);
    const collect = (out, b) => {
      bytes += Buffer.byteLength(b, 'utf8');
      if (bytes > LIMIT) { stdout = ''; stderr = ''; stop(); return; }
      if (!failed) { if (out) stdout += b; else stderr += b; }
    };
    child.stdout.on('data', b => collect(true, b)); child.stderr.on('data', b => collect(false, b));
    child.on('error', () => { failed = true; });
    child.on('close', code => {
      clearTimeout(timer);
      if (failed || code !== 0) reject(error('NATIVE_DIAGNOSTIC'));
      else resolve({ stdout, stderr });
    });
  });
}

const production = { fs, syncFs, platform: process.platform, homedir: os.homedir, execute: diagnostic,
  registry: registrySettings, endpoint: FIRST_PARTY, systemRoots: env => {
    const drive = path.parse(env.SYSTEMROOT || 'C:\\Windows').root;
    return [...new Set([path.resolve('C:/Program Files/ClaudeCode'), path.join(drive, 'Program Files/ClaudeCode'),
      ...['PROGRAMW6432', 'PROGRAMFILES', 'PROGRAMFILES(X86)'].filter(k => env[k]).map(k => path.join(env[k], 'ClaudeCode'))])];
  } };

// Record observations as sources are inspected, then check them without yielding.
// Ancestor identity (not timestamps) detects directory/junction substitution without
// treating normal native cache creation in a profile directory as policy drift.
function createSourceLedger(deps) {
  const sources = new Map(), ancestors = new Map(), inventories = new Map(), touchedCaches = new Set();
  const stamp = (s, file) => {
    if (!s) return 'absent';
    if (!touchedCaches.has(file)) return [s.mode, s.isSymbolicLink(), statStamp(s)].join(':');
    // Native refreshes this cache's timestamps on every successful HTTP 304.
    // Keep identity, type, mode, size AND bytes exact while permitting that touch.
    if (!s.isFile() || s.isSymbolicLink() || s.size > LIMIT) throw error('NATIVE_SOURCE');
    let bytes;
    try { bytes = deps.syncFs.readFileSync(file); } catch { throw error('NATIVE_SOURCE'); }
    if (bytes.length > LIMIT) throw error('NATIVE_SOURCE');
    return [s.mode, cacheStamp(s), hash(bytes)].join(':');
  };
  const directoryStamp = s => {
    if (!s) return 'absent';
    if (!s.isDirectory() || s.isSymbolicLink()) throw error('NATIVE_SOURCE');
    return [s.dev, s.ino, s.mode].join(':');
  };
  function stat(file) {
    try { return deps.syncFs.lstatSync(file); }
    catch (e) { if (e.code === 'ENOENT') return null; throw error('NATIVE_SOURCE'); }
  }
  return {
    parents(file) {
      for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
        if (ancestors.has(dir)) break;
        ancestors.set(dir, directoryStamp(stat(dir)));
        if (dir === path.dirname(dir)) break;
      }
    },
    record(file, value, nativeTouch = false) {
      if (nativeTouch) touchedCaches.add(file);
      const current = stamp(value, file);
      if (sources.has(file) && sources.get(file) !== current) throw error('NATIVE_DRIFT');
      sources.set(file, current);
    },
    inventory(dir, names) { inventories.set(dir, JSON.stringify(names)); },
    revalidate() {
      // No credential/global-config contents are read, here or in the async scan.
      for (const [dir, expected] of ancestors) {
        if (directoryStamp(stat(dir)) !== expected) throw error('NATIVE_DRIFT');
      }
      for (const [file, expected] of sources) {
        if (stamp(stat(file), file) !== expected) throw error('NATIVE_DRIFT');
      }
      for (const [dir, expected] of inventories) {
        let names;
        try { names = deps.syncFs.readdirSync(dir).sort(); } catch { throw error('NATIVE_SOURCE'); }
        if (JSON.stringify(names) !== expected) throw error('NATIVE_DRIFT');
      }
    },
  };
}

async function inspectSources(context, deps, { includeGlobal = true, ledger = createSourceLedger(deps) } = {}) {
  const { cwd, configRoot, home, appdata, environment, command } = context;
  const entries = [];
  async function stat(file, nativeTouch = false) {
    ledger.parents(file);
    let value;
    try { value = await deps.fs.lstat(file); }
    catch (e) { if (e.code !== 'ENOENT') throw error('NATIVE_SOURCE'); value = null; }
    ledger.record(file, value, nativeTouch);
    return value;
  }
  async function regular(file, { managed = false, mcp = false, presenceOnly = false, stampOnly = false, cache } = {}) {
    const nativeTouch = cache === 'policy-limits.json';
    const s = await stat(file, nativeTouch);
    if (!s) {
      if (context.teamPolicy && cache) throw error('NATIVE_POLICY');
      entries.push([file, 'absent']); return;
    }
    if (s.isSymbolicLink() || !s.isFile()) throw error('NATIVE_SOURCE');
    if (presenceOnly) throw error('NATIVE_CONFLICT');
    if (stampOnly) { entries.push([file, statStamp(s)]); return; }
    if (s.size > LIMIT) throw error('NATIVE_SOURCE');
    let text;
    try { text = await deps.fs.readFile(file, 'utf8'); } catch { throw error('NATIVE_SOURCE'); }
    parseSettings(text, managed, mcp, cache);
    const after = await stat(file, nativeTouch);
    const sourceStamp = nativeTouch ? cacheStamp : statStamp;
    if (!after || sourceStamp(s) !== sourceStamp(after)) throw error('NATIVE_DRIFT');
    entries.push([file, sourceStamp(s), hash(text)]);
  }
  async function directory(dir, rejectPresence = false) {
    const s = await stat(dir);
    if (!s) { entries.push([dir, 'absent']); return []; }
    if (rejectPresence || !s.isDirectory() || s.isSymbolicLink()) throw error(rejectPresence ? 'NATIVE_CONFLICT' : 'NATIVE_SOURCE');
    try {
      const names = (await deps.fs.readdir(dir)).sort();
      ledger.inventory(dir, names);
      entries.push([dir, hash(JSON.stringify(names))]); return names;
    }
    catch { throw error('NATIVE_SOURCE'); }
  }
  // Never read .credentials.json, .claude.json, or profile-store contents. Native auth
  // metadata selects the account/gateway. Credential-file stat catches launch-gap edits.
  if (includeGlobal) await regular(path.join(context.configRootMode === 'default' ? home : configRoot, '.claude.json'), { stampOnly: true });
  await regular(path.join(configRoot, '.credentials.json'), { stampOnly: true });
  for (const name of ['remote-settings.json', 'policy-limits.json']) await regular(path.join(configRoot, name), { cache: name });
  await directory(path.join(appdata, 'Anthropic'), true);
  await directory(path.join(home, '.config/anthropic'), true);
  await regular(path.join(configRoot, 'settings.json'));
  await regular(path.join(configRoot, 'settings.local.json'));
  // The legacy global config can contain credentials; unsupported rather than parsed.
  await regular(path.join(configRoot, '.config.json'), { presenceOnly: true });
  const visited = new Set();
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    if (visited.has(dir)) throw error('NATIVE_SOURCE');
    visited.add(dir);
    for (const name of ['settings.json', 'settings.local.json']) await regular(path.join(dir, '.claude', name));
    await regular(path.join(dir, '.mcp.json'), { mcp: true });
    if (dir === (deps.ancestorBoundary || path.parse(dir).root)) break;
  }
  for (const root of deps.systemRoots(environment)) {
    await regular(path.join(root, 'managed-settings.json'), { managed: true });
    const dropins = path.join(root, 'managed-settings.d');
    for (const name of await directory(dropins)) {
      if (/\.json$/i.test(name)) await regular(path.join(dropins, name), { managed: true });
    }
    await regular(path.join(root, 'managed-mcp.json'), { mcp: true });
  }
  // Native's inherited-descriptor fallback files are fixed absolute paths, even on Windows.
  for (const name of ['.oauth_token', '.api_key', '.session_ingress_token']) {
    await regular(path.join(deps.descriptorRoot || path.resolve(path.parse(cwd).root, 'home/claude/.claude/remote'), name), { presenceOnly: true });
  }
  let rows;
  try { rows = await deps.registry(environment, deps.execute); } catch { throw error('NATIVE_SOURCE'); }
  const expected = new Set(['LocalMachine/Registry64', 'LocalMachine/Registry32', 'CurrentUser/Registry64', 'CurrentUser/Registry32']);
  if (!Array.isArray(rows) || rows.length !== 4) throw error('NATIVE_SOURCE');
  for (const row of rows) {
    const id = `${row.hive}/${row.view}`;
    if (!expected.delete(id) || typeof row.present !== 'boolean') throw error('NATIVE_SOURCE');
    if (row.present) {
      if (!['String', 'ExpandString'].includes(row.kind) || typeof row.raw !== 'string' || typeof row.value !== 'string') throw error('NATIVE_SOURCE');
      parseSettings(row.raw, true); parseSettings(row.value, true);
    }
    entries.push([id, row.present ? hash(JSON.stringify([row.kind, row.raw, row.value])) : 'absent']);
  }
  await regular(command, { stampOnly: true });
  ledger.revalidate();
  return hash(JSON.stringify(entries));
}

function preparedEnvironment(parent, context, deps, canonicalModel, metadataOnly = false) {
  const env = {};
  for (const [name, value] of Object.entries(parent)) {
    if (HOST_NAMES.test(name) && value !== '') throw error('NATIVE_CONFLICT');
    if (PIN_NAMES.has(name) || DROP_PARENT.test(name)) continue;
    if (/^(?:CLAUDE_|_CLAUDE_)/.test(name) && !SAFE_NATIVE_ENV.has(name) && !ROOT_NAMES.has(name)) throw error('NATIVE_CONFLICT');
    env[name] = value;
  }
  const pins = Object.fromEntries(EMPTY_PINS.map(k => [k, '']));
  // Explicit FALSE, not the host-managed-provider mode (which disables saved login).
  // This prevents an ordinary hot-reloaded env from enabling that mode.
  for (const name of FALSE_PINS) pins[name] = '0';
  for (const p of PROVIDERS) { pins[`CLAUDE_CODE_USE_${p}`] = '0'; pins[`CLAUDE_CODE_SKIP_${p}_AUTH`] = '0'; }
  for (const name of MODEL_PINS) pins[name] = canonicalModel;
  // 2.1.263 auth/doctor startup migrates user model "opus" to "opus[1m]".
  // This verified native gate prevents that preference write during metadata only.
  // Never put it in taskPrepared: inference must retain the canonical 1M context.
  // The source guards remain byte/identity-exact, including other native writes.
  if (metadataOnly) pins.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1';
  pins.ANTHROPIC_BASE_URL = deps.endpoint;
  pins.ANTHROPIC_CONFIG_DIR = path.join(context.appdata, 'Anthropic');
  pins.CLAUDE_SECURESTORAGE_CONFIG_DIR = context.configRootMode === 'default' ? '' : context.nativeConfigRoot;
  // Do NOT set CLAUDE_CONFIG_DIR to ~/.claude for default mode: that moves .claude.json
  // from the user's home into ~/.claude, changing native login/trust/config identity.
  if (context.configRootMode === 'explicit') pins.CLAUDE_CONFIG_DIR = context.nativeConfigRoot;
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SYSTEMROOT', 'WINDIR', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432']) if (parent[name]) pins[name] = parent[name];
  Object.assign(env, pins, { CLAUDE_BRIDGE_CHILD: '1' });
  // Private injected proxy is only used by disposable native tests. There is no env/MCP switch.
  if (deps.transportEnv) Object.assign(env, deps.transportEnv);
  // 2.1.263 latches the global .claude.json path BEFORE applying --settings.env.
  // In default mode the process env MUST remain unset, but this later settings-only
  // pin keeps session/storage paths from moving on ordinary env edits. Native tests
  // prove both original home .claude.json selection and absence of a new config file.
  const guard = { disableAllHooks: true, apiKeyHelper: '', fallbackModel: [], switchModelsOnFlag: false,
    modelOverrides: { [canonicalModel.replace('[1m]', '')]: canonicalModel.replace('[1m]', '') },
    env: { ...pins, ...(context.configRootMode === 'default' ? { CLAUDE_CONFIG_DIR: context.configRoot } : {}), ...(deps.transportEnv || {}) } };
  return freeze({ env, guard });
}

function accountFingerprint(value, context) {
  if (!object(value) || value.loggedIn !== true || value.authMethod !== 'claude.ai'
      || value.apiProvider !== 'firstParty' || !['pro', 'max', 'team'].includes(value.subscriptionType)) throw error('NATIVE_AUTH');
  if (value.subscriptionType === 'team' && (typeof value.orgId !== 'string' || !value.orgId)) throw error('NATIVE_AUTH');
  // Native account metadata only. No credentials/global-config parsing, no token hash.
  const account = [value.accountUuid ?? null, value.email ?? null, value.orgId ?? null];
  if (!account.some(v => typeof v === 'string' && v.length)) throw error('NATIVE_AUTH');
  if (account.some(v => v !== null && typeof v !== 'string')) throw error('NATIVE_AUTH');
  return hash(JSON.stringify([context.configRootMode, context.nativeConfigRoot, context.configRoot, context.home, account, value.subscriptionType]));
}

// Doctor's human-readable status is captured before its organization-policy wait.
// A pending remote line is therefore retryable, but neither a failed fetch nor
// source drift is. A loaded line alone is insufficient: a 200 response may be
// applied in memory without being persisted. Require native's distinct HTTP 304
// and cache-adoption markers for BOTH caches, observed in the same invocation.
// This attests a fresh snapshot, not an atomic lock against later server updates.
function teamPolicyStatus(result) {
  const lines = (result.stdout + '\n' + result.stderr).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').split(/\r?\n/).map(s => s.trim());
  const remote = lines.filter(s => s.startsWith('Managed settings (remote):'));
  const organization = lines.filter(s => s.startsWith('Organization policy:'));
  const debug = result.stderr.split(/\r?\n/).map(s => s.match(/^(?:\d{4}-\d\d-\d\dT[\d:.]+Z )?\[DEBUG\] (.*)$/)?.[1]).filter(Boolean);
  const policyDebug = debug.filter(s => /^(?:Remote settings|Policy limits): /.test(s));
  if (remote.length !== 1 || organization.length !== 1
      || organization[0] !== 'Organization policy: Loaded from api.anthropic.com'
      || lines.some(s => /settings.*(?:error|invalid|failed)|(?:error|invalid|failed).*settings/i.test(s))
      || policyDebug.some(s => /fetched|failed|failure|deferred|superseded|reset|refreshed|lossy|invalid|unrestricted|timed out|stale|no settings found|applied|rejected|unexpected|unauthorized|error|newer/i.test(s))) throw error('NATIVE_POLICY');
  const pending = remote[0] === 'Managed settings (remote): checking… (fetch in progress; re-run in a moment)';
  if (!pending && remote[0] !== 'Managed settings (remote): loaded') throw error('NATIVE_POLICY');
  for (const marker of ['Remote settings: Using cached settings (304)', 'Remote settings: Cache still valid (304 Not Modified)',
    'Policy limits: Using cached restrictions (304)', 'Policy limits: Cache still valid (304 Not Modified)']) {
    if (policyDebug.filter(s => s === marker).length !== 1) throw error('NATIVE_POLICY');
  }
  return pending ? 'pending' : 'confirmed';
}

function validateIdentity(identity) {
  if (!object(identity) || ![RUNTIME_CONTRACT, TEAM_RUNTIME_CONTRACT].includes(identity.contract) || !isSupportedVersion(identity.version)
      || resolveModel(identity.model) !== identity.model || !['default', 'explicit'].includes(identity.configRootMode)
      || !['executable', 'configRoot', 'home', 'cwd'].every(k => typeof identity[k] === 'string' && path.isAbsolute(identity[k]))
      || (identity.configRootMode === 'default' ? identity.nativeConfigRoot !== null : typeof identity.nativeConfigRoot !== 'string' || !path.isAbsolute(identity.nativeConfigRoot))
      || !['accountFingerprint', 'executableFingerprint'].every(k => typeof identity[k] === 'string' && /^[a-f0-9]{64}$/.test(identity[k]))) throw error('NATIVE_INPUT');
  return true;
}

// Dependency injection stays lexical/private. Tests compile this module in a private
// fixture; production exports do not expose an endpoint, runner, fs or registry override.
function createRuntime(options, deps) {
  if (!object(options) || Object.keys(options).some(k => !['executable', 'configRoot', 'parentEnv', 'model'].includes(k))) throw error('NATIVE_INPUT');
  if (deps.platform !== 'win32') throw error('NATIVE_PLATFORM');
  const parent = envEntries(options.parentEnv === undefined ? process.env : options.parentEnv);
  if (['ANTHROPIC_PROFILE', 'ANTHROPIC_FEDERATION_RULE_ID'].some(k => parent[k])) throw error('NATIVE_CONFLICT');
  const configuredModel = options.model;
  resolveModel(undefined, configuredModel);
  if (typeof options.executable !== 'string' || !path.isAbsolute(options.executable) || !/\.exe$/i.test(options.executable)) throw error('NATIVE_INPUT');
  const executable = options.executable;
  const explicitRoot = options.configRoot;
  if (explicitRoot === undefined && Object.hasOwn(parent, 'CLAUDE_CONFIG_DIR')) throw error('NATIVE_ROOT');
  if (['CLAUDE_SECURESTORAGE_CONFIG_DIR', 'ANTHROPIC_CONFIG_DIR', 'XDG_CONFIG_HOME'].some(k => parent[k] !== undefined)) throw error('NATIVE_ROOT');
  const home = parent.USERPROFILE || parent.HOME || deps.homedir();
  const appdata = parent.APPDATA || path.join(home, 'AppData/Roaming');
  const configRoot = explicitRoot === undefined ? path.join(home, '.claude') : explicitRoot;
  if (![home, appdata, configRoot].every(p => typeof p === 'string' && path.isAbsolute(p))) throw error('NATIVE_ROOT');
  if (parent.HOME && parent.USERPROFILE && path.resolve(parent.HOME) !== path.resolve(parent.USERPROFILE)) throw error('NATIVE_ROOT');

  return Object.freeze({
    async preflight(input) {
      if (!object(input) || Object.keys(input).some(k => !['cwd', 'model', 'expectedIdentity'].includes(k))
          || typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd)) throw error('NATIVE_INPUT');
      const cwd = input.cwd;
      const model = resolveModel(input.model, configuredModel);
      const expected = input.expectedIdentity === undefined ? undefined : JSON.parse(JSON.stringify(input.expectedIdentity));
      if (expected) validateIdentity(expected);
      let context;
      try {
        for (const dir of [home, configRoot, cwd]) if (!(await deps.fs.stat(dir)).isDirectory()) throw error('NATIVE_ROOT');
        context = { command: await deps.fs.realpath(executable), configRoot: await deps.fs.realpath(configRoot),
          home: await deps.fs.realpath(home), appdata: path.resolve(appdata), cwd: await deps.fs.realpath(cwd),
          configRootMode: explicitRoot === undefined ? 'default' : 'explicit',
          // Native Credential Manager namespaces hash the explicit string, not its
          // realpath. Preserve spelling/slashes as well as default-vs-explicit mode.
          nativeConfigRoot: explicitRoot === undefined ? null : explicitRoot };
        // 2.1.263 normalizes filesystem settings paths to NFC but selects saved
        // account metadata using the exact profile string. A non-NFC directory
        // can therefore select another profile's permissions, even with exact env
        // pins. Fail closed; never fix that split by changing the auth namespace.
        if (context.configRoot !== context.configRoot.normalize('NFC')) throw error('NATIVE_ROOT');
        // Do not silently canonicalize a symlinked profile into a different native identity.
        if (path.resolve(configRoot).toLowerCase() !== context.configRoot.toLowerCase()) throw error('NATIVE_ROOT');
        const globalConfig = await deps.fs.lstat(path.join(context.configRootMode === 'default' ? context.home : context.configRoot, '.claude.json'));
        if (!globalConfig.isFile() || globalConfig.isSymbolicLink()) throw error('NATIVE_ROOT');
        context.executableFingerprint = hash(statStamp(await deps.fs.stat(context.command)));
      } catch { throw error('NATIVE_ROOT'); }
      const prepared = preparedEnvironment(parent, context, { ...deps, endpoint: FIRST_PARTY }, model, true);
      const taskPrepared = preparedEnvironment(parent, context, deps, model);
      context.environment = prepared.env;
      const args = freeze(['--model', model, '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--settings', JSON.stringify(prepared.guard)]);
      const execute = async suffix => {
        try {
          const r = await deps.execute(context.command, [...args, ...suffix], { cwd: context.cwd, env: { ...prepared.env } });
          if (!object(r) || typeof r.stdout !== 'string' || typeof r.stderr !== 'string'
              || Buffer.byteLength(r.stdout) + Buffer.byteLength(r.stderr) > LIMIT) throw error('NATIVE_DIAGNOSTIC');
          return r;
        } catch { throw error('NATIVE_DIAGNOSTIC'); }
      };
      const initialSources = await inspectSources(context, deps, { includeGlobal: false });
      const version = parseVersionOutput((await execute(['--version'])).stdout);
      if (!version) throw error('NATIVE_COMPATIBILITY');
      const help = await execute(['--help']);
      const flags = new Set(help.stdout.split(/\s+/));
      if (!FLAGS.every(f => flags.has(f))) throw error('NATIVE_COMPATIBILITY');
      async function auth() {
        const r = await execute(['auth', 'status', '--json']);
        let value;
        try { value = JSON.parse(r.stdout); } catch { throw error('NATIVE_AUTH'); }
        const fingerprint = accountFingerprint(value, context);
        context.teamPolicy = value.subscriptionType === 'team';
        return fingerprint;
      }
      const fingerprint = await auth();
      async function policy() {
        if (context.teamPolicy) {
          // Validate and baseline existing cache bytes before each metadata child;
          // no missing-cache warmup or mutation retry is silently authorized.
          for (let attempt = 0; attempt < 3; attempt++) {
            const before = await inspectSources(context, deps, { includeGlobal: false });
            const result = await execute(['--debug-to-stderr', 'doctor']);
            if (await inspectSources(context, deps, { includeGlobal: false }) !== before) throw error('NATIVE_DRIFT');
            if (teamPolicyStatus(result) === 'confirmed') return;
          }
          throw error('NATIVE_POLICY');
        }
        const doctor = await execute(['doctor']);
        const lines = (doctor.stdout + '\n' + doctor.stderr).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').split(/\r?\n/).map(s => s.trim());
        if (!lines.includes(REMOTE_PERSONAL) || !lines.includes(ORG_PERSONAL)
            || lines.some(s => /settings.*(?:error|invalid|failed)|(?:error|invalid|failed).*settings/i.test(s))) throw error('NATIVE_POLICY');
      }
      await policy();
      if (await inspectSources(context, deps, { includeGlobal: false }) !== initialSources) throw error('NATIVE_DRIFT');
      // The first native metadata startup may migrate its own .claude.json. We must
      // not parse this credential-bearing file to distinguish those writes. Instead,
      // establish a full stat baseline, then require a second, stable metadata pass.
      let launchLedger = createSourceLedger(deps);
      let launchSources = await inspectSources(context, deps, { ledger: launchLedger });
      if (await auth() !== fingerprint || await inspectSources(context, deps) !== launchSources) throw error('NATIVE_DRIFT');
      const identity = freeze({ contract: context.teamPolicy ? TEAM_RUNTIME_CONTRACT : RUNTIME_CONTRACT, version, executable: context.command,
        model, configRoot: context.configRoot, configRootMode: context.configRootMode, nativeConfigRoot: context.nativeConfigRoot,
        home: context.home, cwd: context.cwd, executableFingerprint: context.executableFingerprint, accountFingerprint: fingerprint });
      if (expected && Object.keys(identity).some(k => identity[k] !== expected[k])) throw error('NATIVE_DRIFT');
      async function recheck() {
        if (await inspectSources(context, deps) !== launchSources) throw error('NATIVE_DRIFT');
        if (await auth() !== fingerprint) throw error('NATIVE_DRIFT');
        if (context.teamPolicy) {
          if (await inspectSources(context, deps) !== launchSources) throw error('NATIVE_DRIFT');
          await policy();
          // Doctor updates its own global metadata even on a 304. Apply the same
          // bounded global-config migration rule as initial preflight: every
          // nonglobal source must retain the original snapshot, then establish a
          // new global baseline and require a second stable native auth pass.
          // Never read credential-bearing .claude.json to classify its contents.
          if (await inspectSources(context, deps, { includeGlobal: false }) !== initialSources) throw error('NATIVE_DRIFT');
          const refreshedLedger = createSourceLedger(deps);
          const refreshedSources = await inspectSources(context, deps, { ledger: refreshedLedger });
          if (await auth() !== fingerprint || await inspectSources(context, deps) !== refreshedSources) throw error('NATIVE_DRIFT');
          if (await inspectSources(context, deps, { includeGlobal: false }) !== initialSources) throw error('NATIVE_DRIFT');
          refreshedLedger.revalidate();
          launchLedger = refreshedLedger;
          launchSources = refreshedSources;
        }
        if (await inspectSources(context, deps) !== launchSources) throw error('NATIVE_DRIFT');
        launchLedger.revalidate();
        return identity;
      }
      // Only the nonsecret identity is enumerable/serializable. The backend receives
      // frozen launch material at a synchronous callback immediately after recheck.
      const result = { identity };
      Object.defineProperties(result, {
        recheck: { value: recheck },
        launch: { value: async submit => {
          if (typeof submit !== 'function') throw error('NATIVE_INPUT');
          await recheck();
          const launchArgs = [...args];
          launchArgs[launchArgs.indexOf('--settings') + 1] = JSON.stringify(taskPrepared.guard);
          const descriptor = freeze({ command: context.command, args: launchArgs, cwd: context.cwd,
            env: { ...taskPrepared.env }, shell: false, windowsHide: true });
          // Recheck observations made before all async source/registry/auth work,
          // including the await above. No later await/yield before submission.
          // This closes completed pre-callback edits, not concurrent OS/admin writes.
          launchLedger.revalidate();
          return submit(descriptor);
        } },
      });
      return Object.freeze(result);
    },
  });
}

function createNativeRuntime(options) { return createRuntime(options, production); }
module.exports = { RUNTIME_CONTRACT, MODEL_CATALOG, resolveModel, validateSettings, validateIdentity, createNativeRuntime };
