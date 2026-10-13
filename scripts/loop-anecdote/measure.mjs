// Sums a Claude Code session transcript: tokens per assistant turn and tool
// calls by name, optionally only from a timestamp (the moment the edit was
// done and verification began). Usage:
//   node scripts/loop-anecdote/measure.mjs ~/.claude/projects/<dir>/<session>.jsonl [--from 2026-10-12T20:15:00Z]
//   node scripts/loop-anecdote/measure.mjs --prompts      (both arms' launch lines and prompts)
//   node scripts/loop-anecdote/measure.mjs --self-check   (synthetic transcript, asserts the totals)
// Transcript lines are JSON; assistant lines carry message.usage. Claude
// Code writes one line per content block, and every line of one message
// repeats the same usage and message.id (checked on a real transcript,
// 2026-10-13: 7 lines for 3 ids), so usage is summed once per id while tool
// calls are collected from every line.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ARMS } from './arms.mjs';

/** @returns {{ totals: object, tools: Map<string, number>, imageReads: string[] }} */
export function measure(text, from = -Infinity) {
  const totals = { turns: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  const counted = new Set();
  const tools = new Map();
  const imageReads = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type !== 'assistant' || !o.message) continue;
    if (Date.parse(o.timestamp) < from) continue;
    for (const c of o.message.content ?? []) {
      if (c.type !== 'tool_use') continue;
      tools.set(c.name, (tools.get(c.name) ?? 0) + 1);
      const p = c.input?.file_path ?? '';
      if (/\.(webp|png)$/i.test(p)) imageReads.push(p);
    }
    const u = o.message.usage;
    const id = o.message.id ?? o.uuid;
    if (!u || counted.has(id)) continue;
    counted.add(id);
    totals.turns++;
    totals.input += u.input_tokens ?? 0;
    totals.cacheWrite += u.cache_creation_input_tokens ?? 0;
    totals.cacheRead += u.cache_read_input_tokens ?? 0;
    totals.output += u.output_tokens ?? 0;
  }
  return { totals, tools, imageReads };
}

function selfCheck() {
  const line = (id, ts, usage, content) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: ts,
      message: { id, usage, content },
    });
  const use = (name, file_path) => ({ type: 'tool_use', name, input: { file_path } });
  const u1 = {
    input_tokens: 10,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 0,
    output_tokens: 5,
  };
  const u2 = {
    input_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 100,
    output_tokens: 7,
  };
  const u3 = {
    input_tokens: 30,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 120,
    output_tokens: 9,
  };
  const lines = [
    line('msg_1', '2026-10-13T10:00:00Z', u1, [{ type: 'text', text: 'hi' }]),
    line('msg_1', '2026-10-13T10:00:01Z', u1, [use('Edit', '/p/page.html')]),
    line('msg_2', '2026-10-13T10:00:05Z', u2, [use('Read', '/p/a.webp')]),
    line('msg_2', '2026-10-13T10:00:06Z', u2, [use('Read', '/p/b.webp')]),
    line('msg_2', '2026-10-13T10:00:07Z', u2, [use('Bash', undefined)]),
    line('msg_3', '2026-10-13T10:00:10Z', u3, [{ type: 'text', text: 'done' }]),
    JSON.stringify({ type: 'user', message: { content: 'ignored' } }),
  ];
  const dir = mkdtempSync(path.join(tmpdir(), 'measure-'));
  try {
    const f = path.join(dir, 't.jsonl');
    writeFileSync(f, lines.join('\n') + '\n');
    const { totals: t, tools, imageReads } = measure(readFileSync(f, 'utf8'));
    const eq = (a, b, what) => {
      if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(
          `self-check: ${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`,
        );
    };
    eq(
      t,
      { turns: 3, input: 60, cacheWrite: 100, cacheRead: 220, output: 21 },
      'totals once per id',
    );
    eq(
      [...tools].sort(),
      [
        ['Bash', 1],
        ['Edit', 1],
        ['Read', 2],
      ],
      'tool calls from every line',
    );
    eq(imageReads, ['/p/a.webp', '/p/b.webp'], 'image reads');
    const cut = measure(readFileSync(f, 'utf8'), Date.parse('2026-10-13T10:00:05Z'));
    eq(cut.totals.turns, 2, '--from cut');
    console.log('self-check ok: 7 lines, 3 ids -> 3 turns, usage summed once per id');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main ?? import.meta.url === `file://${process.argv[1]}`) main();

function main() {
  const [file, ...rest] = process.argv.slice(2);
  if (file === '--self-check') {
    selfCheck();
    return;
  }
  if (!file || file === '--prompts') {
    for (const [name, arm] of Object.entries(ARMS))
      console.log(`## ${name}\n\n${arm.launch}\n\n${arm.prompt}\n`);
    if (!file) console.log('usage: measure.mjs <transcript.jsonl> [--from <ISO>]');
    process.exit(file ? 0 : 2);
  }
  let text;
  try {
    if (!existsSync(file)) throw new Error('missing');
    text = readFileSync(file, 'utf8');
  } catch {
    console.error(`measure.mjs: no readable transcript at ${file}`);
    process.exit(2);
  }
  const from = rest[0] === '--from' ? Date.parse(rest[1]) : -Infinity;
  const { totals, tools, imageReads } = measure(text, from);
  if (totals.turns === 0) {
    console.error(
      `measure.mjs: no assistant turns with usage found in ${file}${from > -Infinity ? ' after --from' : ''}`,
    );
    process.exit(1);
  }
  const context = totals.input + totals.cacheWrite + totals.cacheRead;
  console.log('| measure | value |');
  console.log('| --- | ---: |');
  console.log(`| assistant turns | ${totals.turns} |`);
  console.log(
    `| context tokens (input + cache write + cache read, summed over turns) | ${context} |`,
  );
  console.log(`| output tokens | ${totals.output} |`);
  for (const [name, n] of [...tools].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
    console.log(`| tool: ${name} | ${n} |`);
  console.log(`| image files read | ${imageReads.length} |`);
  for (const p of imageReads) console.log(`|   ${p} | |`);
}
