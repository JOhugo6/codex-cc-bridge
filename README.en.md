[Česky](README.md) | **English**

# codex-cc-bridge

A shared **external Claude Code peer** for Claude Code / Claudex and optionally
Codex: the `claude-peer` skill tells the parent how to use the `claude_bridge`
stdio MCP server, which exposes `claude_turn` and `claude_status`. Each conversation
owns a persistent native Claude session. This is **not** the parent's native
Agent tool, `spawn_agent`, or Agent Teams; changing a parent provider does not
turn its native agents into Anthropic agents.

The path is parent → skill/MCP tool → local Node server → supervised native
`claude.exe` → saved first-party login. The child receives task text on
UTF-8 stdin and uses `--session-id` first and `--resume` afterward. Tasks use full
native tools, configured MCP servers and hooks with `bypassPermissions`.
Parent-only Codex MCP settings are not automatically imported.

**Release limitation:** historical intermittent `NATIVE_DRIFT` prelaunch refusals
remain unexplained (reliability item 47). Later passing runs did not establish a
root cause. Final release requires an explicit disposition and independent final
review/testing. See [the runbook](docs/runbook.md#reliability-47).

## Supported prerequisites

- Windows; Node.js **20+** (test matrix: **20.20.0 / 24.12.0**).
- Installer: Windows PowerShell **5.1** or PowerShell **7**. The native supervisor
  requires Windows PowerShell 5.1; the complete test suite requires **both** shells
  and the .NET Framework C# compiler.
- Actual native **Claude Code > 2.1.263**, `claude.exe` on PATH for installation.
  Versions are compared numerically; older versions, 2.1.263 and prereleases are rejected.
  Newer versions must also pass CLI, saved-login, and account-policy checks. Shell shims
  and non-Windows native inference are unsupported.
- An existing **saved Pro, Max, or Team first-party claude.ai login** on this PC.
  Team uses the existing Claude login and must pass organization-policy checks.
  Gateway, Enterprise, unknown account types, API-key and environment-OAuth
  routing are unsupported. The bridge does not copy credentials or read `.credentials.json`.
  It internally compares protected contents of the global `.claude.json`, allowing
  established operational updates from other sessions without exposing its contents or digest.
- Codex CLI only for registration with `-Target Codex` or `-Target Both`.
  `-Target Claude` and `-SkipRegister` do not require Codex.

Authentication metadata does **not** establish that a token still works or that
an account can use Opus. No login, refresh, real-user installation or live smoke
is performed merely by running tests or the default doctor.

## Install on each PC

Run only when you intend to change that PC's user-scope registration and skill.
The installer downloads locked npm dependencies; inspect local permission policy
before choosing editing/command grants.

```powershell
git clone https://github.com/JOhugo6/codex-cc-bridge.git
cd codex-cc-bridge
.\install.ps1 -Target Claude
```

This installs **one shared parent registration** named `claude_bridge` using native
`claude mcp add-json ... --scope user`. Claude/Claudex discover it in `.claude.json`,
**not** `settings.json`; they must use the same parent config/discovery roots.
The shared skill goes to `~/.claude/skills/claude-peer`, or the parent's
`CLAUDE_CONFIG_DIR/skills`. `-ClaudeSkillRoot` overrides that discovery directory.
Restart the parent, then ask it to use **claude-peer** for a bounded task. Do not
fall back to recursive shell/bridge invocation if the tool is unavailable.

`-Target Codex` remains the default; `-Target Both` adds Codex's registration and
an identical skill in `~/.agents/skills/claude-peer` (`-SkillRoot` overrides it).
Identical skill destinations are deduplicated. Server/state locations remain
`~/.codex/bridges/claude-bridge` and `~/.codex/state/claude-bridge`, even for
Claude-only; `CODEX_HOME` / `-CodexRoot` select a different root.

```powershell
# Optional, existing absolute NFC child profile; preserve its exact spelling.
.\install.ps1 -Target Claude -NativeConfigRoot 'D:/Native Claude Profile'
# Optional Codex integration, explicit child editing/command grants:
.\install.ps1 -Target Both -PermissionMode acceptEdits -AllowedTools 'Bash(npm test)'
```

Omitting `-NativeConfigRoot` uses the child's standard `~/.claude` root, **not the
parent's `CLAUDE_CONFIG_DIR`**. An explicit root is stored in
`CLAUDE_BRIDGE_CONFIG_DIR`, preserving its accepted string and auth namespace.
Non-NFC filesystem profiles and unsupported root indirections reject. Do not
copy credentials, native sessions or absolute MCP registrations between PCs;
install locally and establish the native login separately on each PC.

`-SkipRegister` still copies server/skills, runs npm and the non-inference doctor;
it is **not a dry run**. Updates protect owned files/registrations and retain
narrow backups. Collisions refuse; incomplete rollback preserves concurrent
writes and a recovery backup. Do not restore a whole old config over current data.

## Model, permissions and continuity

Public default **`opus` → `claude-opus-5[1m]`** (structured/wire base ID
`claude-opus-5`). The frozen catalogue accepts only `opus`, `opus[1m]`,
`claude-opus-5`, `claude-opus-5[1m]`. Explicit tool `model` takes precedence over
`CLAUDE_BRIDGE_MODEL` for a new conversation; there is no inherited alias,
provider/model fallback, or silent replacement session.

Version 2 state pins canonical model, runtime/account/executable identity, exact
profile selection and working directory. Existing conversations retain their model. **Version 1 is status and
exact completed replay only** (`LEGACY_SESSION` for a new turn); no migration.

Tasks use `bypassPermissions`, full native tools, configured MCP servers and hooks.
Legacy bridge permission/tool settings are validated but no longer restrict tasks.
New v2 turns normalize stored access policy to `bypassPermissions`,
`allowedTools=[]`, `disableTools=false`; completed replay stays historical.
The pending write records the new policy; pre-submission failure restores the
original ready snapshot. Native managed/OS constraints and explicit deny rules
still apply. Inspect `permission_denials`.

Only metadata diagnostics disable MCP and hooks. Native task launches do not pass
`--tools`, `--allowedTools`, or an empty MCP configuration. Recursive delegation has no extra bridge denial; existing session/profile concurrency locks remain. Provider/model/account
identity checks remain in place. This is not an operating-system sandbox.

```json
{
  "conversation_id": "project-review-01",
  "request_id": "turn-01",
  "working_dir": "C:/Projects/My App",
  "message": "Review authentication. Report concrete findings; do not edit files."
}
```

Keep the conversation ID stable; use a new request ID for each message. Repeating
a completed ID with the same message returns the exact cached result (apart from
`replayed: true`), without native preflight or inference. Results include `reply`,
`session_id`, `turn`, `model`, `runtime`, `model_evidence`, usage/cost and denials.
Empty `model_evidence` is not proof of the model; self-description is never proof.

Preflight occurs **before** durable `pending`; the final recheck immediately
precedes supervised spawn. A demonstrably pre-submission refusal restores the
prior `ready` snapshot (or leaves conservative `pending` if restoration fails).
A failure after the submission callback is `uncertain`. Use `claude_status`;
never automatically retry, delete state or create a replacement conversation.
Bridge state and native local transcripts are both needed for continuity and may
contain sensitive task/results. Default timeout is 900 s; Codex gets 60 s extra.
Windows Job supervision handles child/descendant cleanup on timeout/disconnect.

## Diagnostics and tests

```powershell
npm.cmd --prefix bridge ci --ignore-scripts --no-audit --no-fund
npm.cmd --prefix bridge run doctor
# Explicit metadata/preflight, not inference; may contact native ancillary services:
npm.cmd --prefix bridge run doctor -- --native --cwd 'C:/Projects/My App' --model opus
# Actual pinned executable; only synthetic profiles + loopback/ancillary deny proxy:
$env:NATIVE_CONTRACT_CLAUDE_EXE = (Get-Command claude.exe -CommandType Application | Select-Object -First 1).Source
npm.cmd --prefix bridge test
```

Default doctor checks the MCP handshake and expected **public tool schemas** with
bounded requests, no native CLI/auth/model call. `--native` reuses frozen runtime
validation and emits sanitized compatibility/profile metadata, not token or
entitlement certification. Errors/help never dump native auth JSON or environment.

`npm test` explicitly enumerates every maintained offline suite, including native
characterization/integration and installer tests; no shell globs or live smoke.
`test:unit`, `test:native`, `test:installer` expose subsets. Missing native/Windows/
PowerShell prerequisites are failures, not successful skips. Synthetic transport
proof is neither live entitlement proof nor an OS sandbox. Suite files run
sequentially; intentional concurrency cases remain in the suites.

**Historical Node20 installer blocker:** the earlier fixture hardlinked its running
Node 20.20.0 executable and failed cleanup with `EPERM`; that aggregate was not
PASS. Package B4 owns the repair and its independent checks. Until the final
current-source aggregate verifies it, do not infer full Node20 compatibility from
C2's non-installer tests. This is separate from unresolved reliability item 47.

CI has Windows Node20/24 jobs and real pinned native provisioning. The CI-only
`bridge/ci/provision-native.js` downloads official Windows x64 **2.1.268**, checks
its fixed size/SHA256 before publishing the executable, then CI checks the native
version/flags in a disposable synthetic profile. HTTPS only, no redirects, latest,
repository-variable binary or login. PRs use the **trusted base commit's** helper,
not fork/head provisioning code; that helper must first exist on the base branch.
Missing artifact/network/base helper fails the gate, not a successful skip.
[Provenance, checksum and setup](docs/runbook.md#native-ci-provisioning).
No hosted workflow run is implied by local tests or workflow authoring.

`npm.cmd --prefix bridge run smoke -- --live` (or `CLAUDE_BRIDGE_LIVE=1`) is a usable,
**explicitly opt-in** live check, not part of any offline test or CI job. Without
opt-in it returns `SMOKE_OPT_IN_REQUIRED` before creating files or starting MCP.
With consent it uses Opus, `bypassPermissions`, full tools, native MCP and hooks,
and a tiny temporary cwd outside the repository. It sends two synthetic messages
across an MCP process restart and checks exact cached replay, stable v2 session/
runtime identity and nonempty structured model evidence, not self-description.

**This consumes real usage, may cost money and retains native transcripts in the
selected existing profile. Global native instructions may still apply.** The
script does not log in, refresh, retry or fall back. Success cleans only its own
temporary cwd/bridge state; failure preserves that directory for inspection. It
never deletes a native profile/transcript. Offline actual-native no-tools/normal-
tool controls are not live entitlement proof. The live path has not been run as
part of this implementation; obtain separate consent before running it.

[Recovery/configuration runbook (Czech)](docs/runbook.md).
References: [Codex MCP](https://developers.openai.com/codex/mcp),
[Claude programmatic usage](https://code.claude.com/docs/en/headless).
Apache-2.0; see [NOTICE](NOTICE) for the Windows supervisor attribution.
