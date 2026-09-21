---
name: claude-peer
description: Delegate a bounded task, review, analysis, or follow-up to native Anthropic Claude Code through the claude_bridge MCP server, from Claude Code, Claudex, or Codex. Use when the user requests an independent Claude peer or second opinion.
---

Use `claude_turn` on the `claude_bridge` MCP server to obtain the peer's actual response. Claude Code and Claudex share one user-scope registration and this same skill; Codex can discover an identical copy. This skill does not select a native Agent or change the host's model, provider, permissions, or authentication.

- First check that the MCP tool is available. If it is absent or disabled, report that limitation and ask the user to check their installation. Do not fall back to a shell-launched Claude, another bridge, or recursive delegation. The child loads MCP servers and hooks from its native Claude profile; parent-only Codex MCP configuration is not automatically imported. The bridge does not impose a recursive delegation ban; ordinary session/profile concurrency checks still apply.
- Give the peer a bounded task, relevant context, required result, and explicit file ownership when edits are involved. It has a separate context but shares the target filesystem. Explain concurrent work and require it to leave other authors' files alone. Independent author, reviewer, and tester work needs distinct conversations; do not treat the author's own checks as independent review or QA.
- Choose a stable, project-specific `conversation_id`. Supply the absolute project path as `working_dir` on the first turn; reuse that conversation ID for follow-ups, including after a host restart. Subsequent calls may omit the directory. Sessions are local to that PC, not portable between machines.
- Supply a unique `request_id` for each intended turn. For an exact replay of a completed request after a transport interruption, reuse the same conversation ID, request ID, message, and any originally supplied options. Never recycle a request ID for different work.
- Normally omit `model`. The public default is `opus`, resolved by the verified native catalogue to a pinned Anthropic Opus model. An explicitly configured bridge default takes precedence over the built-in default; an explicit supported `model` on the first turn takes precedence over both. Only verified catalogue selections are accepted (for example `opus` or `opus[1m]`); unsupported aliases, provider/gateway names, `inherit`, `default`, and `opusplan` are rejected. Do not guess other choices or promise automatic model/provider fallback. The chosen canonical model, directory, native profile, and account identity are pinned to the conversation. New turns normalize legacy bridge access policy to unrestricted task access.
- Report the returned `reply` as the peer's result and inspect `permission_denials`; denied work may be incomplete. Review edits and run appropriate checks before integrating them. A successful offline handshake or installation is not proof of native authentication, entitlement, or a successful live model call.
- After a timeout or disconnection, inspect `claude_status`. A pending or uncertain turn must not be automatically repeated, cleared, or replaced with a new conversation: the peer may already have changed files. Explain the status and inspect the affected work first. A completed cached request can be replayed without launching the native CLI; status also does not launch it.
- Legacy v1 conversations support status and exact replay of previously completed requests only. A new turn is rejected because their previous provider identity is unproven. Do not migrate or delete their state, silently reset the session, or invent a replacement ID to bypass that rejection. Explain the limitation and seek an explicit decision about starting genuinely new work.

Example tool arguments:

```json
{
  "conversation_id": "my-project-review-01",
  "request_id": "turn-01",
  "working_dir": "C:/Projects/My App",
  "message": "Review the authentication code for bugs. Return concrete findings with file paths and line numbers. Do not edit files."
}
```

The bridge launches tasks with `bypassPermissions`, full native tools, and configured native MCP servers and hooks. Legacy bridge access settings and persisted v2 access policy are normalized on the next new turn; completed replay remains unchanged. Native user/project context and external managed/OS constraints still apply. It is not an operating-system sandbox. If work is denied, report the limitation without changing permissions, escalating, or retrying through a different mechanism. Native compatibility, unsupported routing/settings, profile drift, authentication, or model-availability errors must be reported, not bypassed. Native login is a separate user action on each PC; never request, copy, or inject credentials on the user's behalf.
