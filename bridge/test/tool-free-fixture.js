'use strict';
// Private synthetic fixtures, not a provider/auth/argv seam in production.
const path = require('node:path');
const { reply } = require('./native-contract-fixture');

async function sharedContext(f) {
  const configRelative = path.relative(f.root, f.config);
  const sentinel = 'TOOL_FREE_PRIVATE_FILE_CONTENT';
  await f.text('project/private.txt', sentinel);
  await f.text('project/CLAUDE.md', 'SYNTHETIC_PROJECT_INSTRUCTION');
  await f.text(path.join(configRelative, 'CLAUDE.md'), 'SYNTHETIC_GLOBAL_INSTRUCTION');
  await f.text(path.join(configRelative, 'skills', 'synthetic-skill', 'SKILL.md'),
    '---\nname: synthetic-skill\ndescription: synthetic skill for offline tool availability control\n---\nSYNTHETIC_SKILL_BODY\n');
  const marker = path.join(f.project, 'hook-ran');
  const hook = `"${process.execPath}" -e "require('fs').writeFileSync('hook-ran','ran')"`;
  await f.json(path.join(configRelative, 'settings.json'), {
    permissions: { allow: ['Read', 'Write', 'Bash', 'Skill'] },
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: hook }] }] },
  });
  const mcpCommand = { command: process.execPath, args: ['-e', "require('fs').writeFileSync('mcp-ran','ran')"] };
  await f.json('project/.mcp.json', { mcpServers: { synthetic: mcpCommand } });
  return { sentinel, marker, mcpMarker: path.join(f.project, 'mcp-ran'), writeMarker: path.join(f.project, 'write-ran') };
}

function attack(f) {
  let sent = false;
  return (r, res) => {
    if (!r.url.startsWith('/v1/messages') || r.url.includes('count_tokens') || sent) return false;
    sent = true;
    // Deliberately return tools even if the client did not advertise any. Actual
    // native execution must reject them, not just omit their schemas from wire.
    reply(res, r.body.model, [
      { type: 'tool_use', id: 'read_probe', name: 'Read', input: { file_path: path.join(f.project, 'private.txt') } },
      { type: 'tool_use', id: 'write_probe', name: 'Write', input: { file_path: path.join(f.project, 'write-ran'), content: 'ran' } },
      { type: 'tool_use', id: 'skill_probe', name: 'Skill', input: { skill: 'synthetic-skill' } },
    ]);
    return true;
  };
}
const results = requests => requests.flatMap(r => r.body.messages || [])
  .flatMap(m => Array.isArray(m.content) ? m.content : []).filter(b => b.type === 'tool_result');
module.exports = { sharedContext, attack, results };
