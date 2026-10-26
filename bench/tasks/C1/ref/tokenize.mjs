import fs from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const TOKEN_VERSION = '1';
export const E_INVALID_INPUT = 'E_INVALID_INPUT';

const WS = new Set([' ', '\t', '\n', '\r', '\f', '\v']);

function isCjkPoint(p) {
  return (p >= 0x4e00 && p <= 0x9fff)
    || (p >= 0x3400 && p <= 0x4dbf)
    || (p >= 0x3040 && p <= 0x30ff)
    || (p >= 0xf900 && p <= 0xfaff);
}

const isLatinPoint = (p) => (p >= 0x41 && p <= 0x5a) || (p >= 0x61 && p <= 0x7a);
const isDigitPoint = (p) => p >= 0x30 && p <= 0x39;

function invalid(what) {
  const err = new TypeError(`${what} must be a string`);
  err.code = E_INVALID_INPUT;
  return err;
}

function tally(text) {
  if (typeof text !== 'string') throw invalid('text');
  const cps = Array.from(text);
  let tokens = 0;
  let cjk = 0;
  let latin = 0;
  for (let i = 0; i < cps.length; i += 1) {
    const ch = cps[i];
    if (WS.has(ch)) continue;
    const p = ch.codePointAt(0);
    if (isCjkPoint(p)) {
      tokens += 1;
      cjk += 1;
    } else if (isLatinPoint(p)) {
      let j = i;
      while (j < cps.length && isLatinPoint(cps[j].codePointAt(0))) j += 1;
      tokens += 1;
      latin += 1;
      i = j - 1;
    } else if (isDigitPoint(p)) {
      let j = i;
      while (j < cps.length && isDigitPoint(cps[j].codePointAt(0))) j += 1;
      tokens += 1;
      i = j - 1;
    } else {
      tokens += 1;
    }
  }
  return { chars: cps.length, tokens, cjk, latin };
}

export function stats(text) {
  return tally(text);
}

export function countTokens(text) {
  return tally(text).tokens;
}

const USAGE = 'usage: node tokenize.mjs <file> [--json] [--out <path>] [--dry-run]';

function parseArgs(argv) {
  const out = { json: false, dryRun: false, file: null, outPath: null, error: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--out') {
      out.outPath = argv[i + 1];
      i += 1;
    } else if (a.startsWith('--')) out.error = { kind: 'E_BAD_ARG', detail: a };
    else if (out.file === null) out.file = a;
  }
  if (!out.error && out.file === null) out.error = { kind: 'usage' };
  return out;
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    if (parsed.error.kind === 'usage') process.stderr.write(`${USAGE}\n`);
    else process.stderr.write(`E_BAD_ARG: ${parsed.error.detail}\n`);
    process.exit(1);
  }

  if (parsed.dryRun) {
    process.stdout.write(`DRY-RUN ${parsed.outPath === null ? 'stdout' : parsed.outPath}\n`);
    return;
  }

  let text;
  try {
    text = fs.readFileSync(parsed.file, 'utf8');
  } catch {
    process.stderr.write(`E_NOENT: ${parsed.file}\n`);
    process.exit(2);
  }

  const json = JSON.stringify(stats(text));
  if (parsed.outPath !== null) {
    fs.writeFileSync(parsed.outPath, json, 'utf8');
    return;
  }
  if (parsed.json) process.stdout.write(`${json}\n`);
  else process.stdout.write(`tokens=${JSON.parse(json).tokens}\n`);
}

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
