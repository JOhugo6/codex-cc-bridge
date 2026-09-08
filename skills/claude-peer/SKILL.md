---
name: claude-peer
description: Delegate a coding task, review, analysis, or follow-up to Claude Code CLI from Codex through the claude_bridge MCP server. Use when the user wants Claude as a subagent or a second opinion from Claude.
---

Call `claude_turn` on the `claude_bridge` MCP server to obtain Claude's actual response.

- Give Claude a bounded task, relevant context, required result, and file ownership when edits are involved. It has a separate context and shares the target filesystem. Tell it about concurrent edits when relevant.
- Choose a stable, project-specific `conversation_id`. Supply the absolute project path as `working_dir` on the first turn; subsequent calls may omit it. Reuse the conversation ID for follow-ups.
- Supply a unique `request_id` for each intended turn. Reuse the same request ID and message only when retrieving a completed call after a transport interruption.
- Omit `model` unless the user specifies one. The model and working directory cannot change within a conversation.
- Report the returned `reply` as Claude's result and inspect `permission_denials`; denied work may be incomplete. Review changes and run appropriate checks before integrating them.
- After a timeout or disconnection, inspect `claude_status`. A pending or uncertain turn must not be automatically repeated, cleared, or replaced: Claude may already have changed files. Explain the status and inspect the affected work first.

Example tool arguments:

```json
{
  "conversation_id": "my-project-review-01",
  "request_id": "turn-01",
  "working_dir": "C:/Projects/My App",
  "message": "Review the authentication code for bugs. Return concrete findings with file paths and line numbers. Do not edit files."
}
```

The bridge defaults to Claude's `dontAsk` permission mode and inherits existing permission rules. It does not provide an operating-system sandbox. Edit permissions can be configured through the bridge installer. If a tool is denied, report the limitation without changing permissions yourself.
