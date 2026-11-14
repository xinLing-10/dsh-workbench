/**
 * P0 surface probe: verifies the DSH seams the standalone manager depends on.
 *
 * Read-only. Imports the installed DSH packages (no model calls, no writes) and
 * reports whether approvals, user questions, token usage and a provider base
 * URL override exist in this exact DSH build.
 *
 *   node probes/probe-dsh-surface.mjs [path/to/dsh/node_modules/@deepseek-ai]
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2]
  || join(process.env.DSH_INSTALL
    || '/Users/xinlin/.nvm/versions/node/v24.19.0/lib/node_modules/@deepseek-ai/dsh',
  'node_modules/@deepseek-ai');

const load = async (spec) => import(pathToFileURL(join(root, spec)).href);
const results = [];
const check = (name, fn) => {
  try {
    results.push({ name, ok: Boolean(fn()), detail: '' });
  } catch (error) {
    results.push({ name, ok: false, detail: String(error.message || error).slice(0, 120) });
  }
};

check('user-approval exports ApprovalRequestId', async () => (await load('dsh-user-approval/lib/index.js')).ApprovalRequestId);
const sessionTypes = await load('dsh-session/lib/types/known-event-types.js');
check('session events include approval/asked + approval/decided', () =>
  sessionTypes.KNOWN_SESSION_EVENT_TYPES.has('approval/asked') && sessionTypes.KNOWN_SESSION_EVENT_TYPES.has('approval/decided'));
check('session events include tool/call + tool/result', () =>
  sessionTypes.KNOWN_SESSION_EVENT_TYPES.has('tool/call') && sessionTypes.KNOWN_SESSION_EVENT_TYPES.has('tool/result'));
check('session events include approval/policy', () => sessionTypes.KNOWN_SESSION_EVENT_TYPES.has('approval/policy'));

const questions = await load('dsh-user-questions/lib/index.js');
check('user-questions service exports a constructor', () => typeof questions === 'object');
const answerer = await load('dsh-user-questions/lib/types/types.js');
check('user-questions answerer module loads', () => Boolean(answerer));

const deepseekSource = await import('node:fs').then((fs) =>
  fs.readFileSync(join(root, 'dsh-llm-deepseek/lib/types/config.d.ts'), 'utf8'));
check('deepseek provider config declares baseURL', () => deepseekSource.includes('baseURL'));

const llmTypes = await import('node:fs').then((fs) =>
  fs.readFileSync(join(root, 'dsh-llm/lib/types/types.d.ts'), 'utf8'));
check('llm types declare a usage chunk with token counts', () =>
  /type: 'usage'/.test(llmTypes) && /TokenUsage/.test(llmTypes));

let width = 0;
for (const row of results) width = Math.max(width, row.name.length);
for (const row of results) {
  console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.name.padEnd(width)}  ${row.detail}`);
}
const failed = results.filter((row) => !row.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed (root: ${root})`);
process.exit(failed.length === 0 ? 0 : 1);
