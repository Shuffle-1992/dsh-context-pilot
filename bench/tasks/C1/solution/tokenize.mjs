import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

export const TOKEN_VERSION = '1';
export const E_INVALID_INPUT = 'E_INVALID_INPUT';

// 空白：U+0020 / U+0009 / U+000A / U+000D / U+000C / U+000B，不产生 token。
const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d, 0x0c, 0x0b]);

// CJK 闭区间，命中即单码点 1 token 并计入 cjk。
const CJK_RANGES = [
  [0x4e00, 0x9fff],
  [0x3400, 0x4dbf],
  [0x3040, 0x30ff],
  [0xf900, 0xfaff],
];

const RE_LATIN = /^[A-Za-z]$/;
const RE_DIGIT = /^[0-9]$/;

function isCjk(cp) {
  for (const [lo, hi] of CJK_RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function invalidInput(value) {
  const err = new Error(`E_INVALID_INPUT: expected string, got ${describe(value)}`);
  err.code = E_INVALID_INPUT;
  return err;
}

export function stats(text) {
  if (typeof text !== 'string') throw invalidInput(text);
  const cps = Array.from(text);
  let tokens = 0;
  let cjk = 0;
  let latin = 0;
  let i = 0;
  while (i < cps.length) {
    const ch = cps[i];
    const cp = ch.codePointAt(0);
    if (WHITESPACE.has(cp)) {
      i += 1;
      continue;
    }
    if (isCjk(cp)) {
      tokens += 1;
      cjk += 1;
      i += 1;
      continue;
    }
    if (RE_LATIN.test(ch)) {
      while (i < cps.length && RE_LATIN.test(cps[i])) i += 1;
      tokens += 1;
      latin += 1;
      continue;
    }
    if (RE_DIGIT.test(ch)) {
      while (i < cps.length && RE_DIGIT.test(cps[i])) i += 1;
      tokens += 1;
      continue;
    }
    tokens += 1;
    i += 1;
  }
  const out = { chars: cps.length, tokens, cjk, latin };
  return out;
}

export function countTokens(text) {
  return stats(text).tokens;
}

function parseArgs(argv) {
  const opts = { file: null, json: false, dryRun: false, outPath: null, error: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--out') {
      i += 1;
      if (i >= argv.length) {
        opts.error = 'E_BAD_ARG: --out needs a path argument';
        return opts;
      }
      opts.outPath = argv[i];
    } else if (arg.startsWith('--')) {
      opts.error = `E_BAD_ARG: unknown flag ${arg}`;
      return opts;
    } else if (opts.file === null) {
      opts.file = arg;
    } else {
      opts.error = `E_BAD_ARG: unexpected argument ${arg}`;
      return opts;
    }
  }
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.error !== null) {
    process.stderr.write(`${opts.error}\n`);
    process.exitCode = 1;
    return;
  }
  if (opts.file === null) {
    process.stderr.write('usage: tokenize.mjs <file> [--json] [--out <path>] [--dry-run]\n');
    process.exitCode = 1;
    return;
  }
  let text;
  try {
    text = fs.readFileSync(opts.file, 'utf8');
  } catch (err) {
    process.stderr.write(`E_NOENT: cannot read ${opts.file}\n`);
    process.exitCode = 2;
    return;
  }
  const st = stats(text);
  const jsonText = JSON.stringify(st);
  const report = opts.json ? `${jsonText}\n` : `tokens=${st.tokens}\n`;
  if (opts.dryRun) {
    const label = opts.outPath === null ? 'stdout' : opts.outPath;
    process.stdout.write(`DRY-RUN ${label}\n`);
    process.stdout.write(report);
    process.exitCode = 0;
    return;
  }
  process.stdout.write(report);
  if (opts.outPath !== null) fs.writeFileSync(opts.outPath, jsonText, 'utf8');
}

const entry = process.argv[1]
  ? url.pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (import.meta.url === entry) main(process.argv.slice(2));
