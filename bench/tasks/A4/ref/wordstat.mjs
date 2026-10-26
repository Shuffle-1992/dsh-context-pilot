import fs from 'node:fs';
import process from 'node:process';

const USAGE = 'usage: node <wordstat.mjs> [--json] <file> [<file>...]';

function computeStats(buf) {
  const bytes = buf.length;
  if (bytes === 0) return { lines: 0, words: 0, bytes };
  const segments = buf.toString('utf8').split('\n');
  if (segments[segments.length - 1] === '') segments.pop();
  let words = 0;
  for (const segment of segments) {
    const line = segment.endsWith('\r') ? segment.slice(0, -1) : segment;
    for (const piece of line.split(/[ \t]+/)) {
      if (piece !== '') words += 1;
    }
  }
  return { lines: segments.length, words, bytes };
}

function parseArgs(argv) {
  const files = [];
  let json = false;
  for (const arg of argv) {
    if (arg === '--json') json = true;
    else if (arg.startsWith('--')) return { error: { code: 'E_BAD_ARG', detail: arg, exit: 1 } };
    else files.push(arg);
  }
  if (files.length === 0) return { error: { usage: true, exit: 1 } };
  return { json, files: [...new Set(files)] };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    if (parsed.error.usage) process.stderr.write(`${USAGE}\n`);
    else process.stderr.write(`E_BAD_ARG: ${parsed.error.detail}\n`);
    process.exit(parsed.error.exit);
  }

  const entries = [];
  for (const file of parsed.files) {
    let buf;
    try {
      buf = fs.readFileSync(file);
    } catch {
      process.stderr.write(`E_NOENT: ${file}\n`);
      process.exit(2);
    }
    const s = computeStats(buf);
    entries.push({ path: file, lines: s.lines, words: s.words, bytes: s.bytes });
  }

  const totals = entries.reduce(
    (acc, e) => ({ files: acc.files + 1, lines: acc.lines + e.lines, words: acc.words + e.words, bytes: acc.bytes + e.bytes }),
    { files: 0, lines: 0, words: 0, bytes: 0 }
  );

  if (parsed.json) {
    process.stdout.write(`${JSON.stringify({ files: entries, totals })}\n`);
    return;
  }
  let out = '';
  for (const e of entries) out += `${e.path}\tlines=${e.lines}\twords=${e.words}\tbytes=${e.bytes}\n`;
  out += `TOTAL\tlines=${totals.lines}\twords=${totals.words}\tbytes=${totals.bytes}\n`;
  process.stdout.write(out);
}

main();
