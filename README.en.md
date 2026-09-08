[Česky](README.md) | **English**

# codex-cc-bridge

Use **Claude Code CLI as an external subagent from Codex**, via the
`claude_bridge` stdio MCP server and the `claude-peer` skill. This reverses the
direction of `cc-codex-bridge` and `cc-copilot-bridge`.

## Install and use

Requires Windows, Node.js 20+, PowerShell 5.1/7, Codex CLI and an authenticated
native `claude.exe` on PATH.

```powershell
git clone https://github.com/JOhugo6/codex-cc-bridge.git
cd codex-cc-bridge
.\install.ps1
```

The installer copies the server to `~/.codex/bridges/claude-bridge`, installs
locked dependencies, verifies the MCP handshake, installs the skill in
`~/.agents/skills/claude-peer`, backs up existing Codex configuration and
registers `claude_bridge`. It respects `CODEX_HOME`; use `-CodexRoot` and
`-SkillRoot` to override destinations. Restart Codex, then ask:

```text
$claude-peer Ask Claude to review authentication in this project.
Return concrete findings with file paths and line numbers; do not edit files.
```

The default Claude permission mode is `dontAsk`: operations requiring approval
are denied instead of waiting for input. Existing Claude permission rules still
apply, so this is neither a sandbox nor a read-only guarantee. For implementation:

```powershell
.\install.ps1 -PermissionMode acceptEdits -AllowedTools 'Bash(npm test)'
```

The model defaults to Claude's configuration. Optionally pass `-Model` or the
`model` tool argument on the first turn. Bridge permissions, model and working
directory are pinned per conversation; use a new ID for changed settings.
Hooks and inherited MCP servers are disabled in the child CLI. Claude still
loads project instructions and its normal settings and permission rules.

## Tool contract

Call `claude_turn` with:

```json
{
  "conversation_id": "project-review-01",
  "request_id": "turn-01",
  "working_dir": "C:/Projects/My App",
  "message": "Review authentication for bugs. Do not edit files."
}
```

Keep `conversation_id` stable for follow-ups. `working_dir` must be absolute on
the first call and can be omitted thereafter. `request_id` is optional but
recommended: replaying a completed request with the same ID and message returns
the cached response without calling Claude again. IDs are case sensitive.

The result includes `reply`, `session_id`, `turn`, `working_dir`, `replayed`,
`permission_denials`, `usage`, and `total_cost_usd`. Check permission denials for
incomplete work. `claude_status` reads persisted status and the last result.

Sessions use `--session-id` initially and `--resume` afterward. The bridge stores
identity and results under `~/.codex/state/claude-bridge`; Claude stores its own
transcripts. Both are needed for continuity. Failed resumes never create a new
session automatically. Pending/uncertain turns block new sends because an
interrupted CLI may already have edited files. Concurrent calls to the same
conversation return `CONVERSATION_BUSY`.

Prompts travel over UTF-8 stdin without shell interpolation or Windows argv
length limits. On Windows, Job Objects terminate Claude and descendants on
timeout, cancellation or bridge death. The CLI timeout defaults to 900 seconds;
the installer sets Codex's MCP timeout 60 seconds higher. The POSIX backend
branch is unverified; installation and descendant cleanup guarantees target Windows.

## Validate

```powershell
npm.cmd --prefix bridge ci
npm.cmd --prefix bridge test
npm.cmd --prefix bridge run doctor
$env:CLAUDE_BRIDGE_LIVE = '1'
npm.cmd --prefix bridge run smoke
```

Tests use deterministic subprocess fixtures; the opt-in smoke makes two real
Claude calls across MCP restarts and checks remembered context and replay.
If the API reports an expired OAuth token, run `claude auth login` and retry.

See the [Czech runbook](docs/runbook.md) for recovery and configuration.
Protocol references: [Codex MCP](https://developers.openai.com/codex/mcp),
[Claude programmatic usage](https://code.claude.com/docs/en/headless).
Apache-2.0; see [NOTICE](NOTICE) for the adapted Windows supervisor.
