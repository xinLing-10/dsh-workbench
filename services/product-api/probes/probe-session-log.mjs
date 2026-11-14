/**
 * P0 evidence probe: reads existing DSH session logs (read-only) and reports
 * whether approvals, user questions and token usage actually appear in real
 * runs of this installation.
 *
 *   node probes/probe-session-log.mjs [--max-sessions 40]
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const root = join(process.env.DSH_HOME || join(process.env.HOME, '.dsh'), 'sessions');
const argMax = process.argv.indexOf('--max-sessions');
const maxSessions = argMax > 0 ? Number(process.argv[argMax + 1]) || 40 : 40;
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** @returns every JSON event of a concatenated zstd-frame log. */
function decode(buffer) {
  const starts = [];
  for (let i = 0; i + 4 <= buffer.length; i += 1) {
    if (buffer.compare(magic, 0, 4, i, i + 4) === 0) starts.push(i);
  }
  const events = [];
  for (let i = 0; i < starts.length; i += 1) {
    try {
      const text = zstdDecompressSync(buffer.subarray(starts[i], starts[i + 1] ?? buffer.length)).toString('utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { events.push(JSON.parse(line)); } catch {}
      }
    } catch {}
  }
  return events;
}

const stats = { sessions: 0, events: 0, approvals: 0, decided: 0, questions: 0, usageChunks: 0, turns: 0 };
let approvalSample = null;
let questionSample = null;
let usageSample = null;

let dirs = [];
try { dirs = await readdir(root); } catch {
  console.error(`no session directory at ${root}`);
  process.exit(2);
}
for (const dir of dirs.slice(0, maxSessions)) {
  let subs = [];
  try { subs = await readdir(join(root, dir)); } catch { continue; }
  for (const sub of subs) {
    let files = [];
    try { files = (await readdir(join(root, dir, sub))).filter((name) => name.endsWith('.zstd')); } catch { continue; }
    for (const name of files) {
      stats.sessions += 1;
      for (const event of decode(await readFile(join(root, dir, sub, name)))) {
        stats.events += 1;
        const data = event.data || {};
        if (event.type === 'approval/asked') { stats.approvals += 1; approvalSample = approvalSample || data; }
        if (event.type === 'approval/decided') stats.decided += 1;
        if (event.type === 'tool/call' && data.name === 'ask_user_question') { stats.questions += 1; questionSample = questionSample || data; }
        if (event.type === 'turn/end') stats.turns += 1;
        const chunk = data.chunk || data;
        if (chunk && chunk.type === 'usage' && chunk.usage) { stats.usageChunks += 1; usageSample = usageSample || chunk.usage; }
      }
    }
  }
}

const lines = [
  ['session logs', `${stats.sessions} files, ${stats.events} events, ${stats.turns} turns`],
  ['approvals', `${stats.approvals} asked / ${stats.decided} decided`],
  ['user questions', `${stats.questions} ask_user_question calls`],
  ['token usage', `${stats.usageChunks} usage chunks`],
];
for (const [name, detail] of lines) console.log(`${name.padEnd(15)} ${detail}`);
if (approvalSample) console.log('approval sample ', JSON.stringify({ id: approvalSample.id, toolName: approvalSample.toolName, callId: approvalSample.callId, reason: String(approvalSample.reason || '').slice(0, 60) }));
if (questionSample) console.log('question sample ', String(questionSample.arguments || '').slice(0, 160));
if (usageSample) console.log('usage sample    ', JSON.stringify(usageSample));

const ok = stats.approvals > 0 && stats.decided > 0 && stats.questions > 0 && stats.usageChunks > 0;
console.log(ok ? '\nPASS: all three seams appear in real logs' : '\nPARTIAL: some seams have no real evidence in this sample');
process.exit(ok ? 0 : 1);
