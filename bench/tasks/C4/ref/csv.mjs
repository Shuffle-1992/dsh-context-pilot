import fs from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function scanRows(text) {
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const rows = [];
  let row = [];
  while (i < n) {
    let value = '';
    if (text[i] === '"') {
      i += 1;
      let closed = false;
      while (i < n) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            value += '"';
            i += 2;
            continue;
          }
          i += 1;
          closed = true;
          break;
        }
        value += text[i];
        i += 1;
      }
      if (!closed) throw err('E_UNTERMINATED_QUOTE', 'unterminated quoted field');
    } else {
      while (i < n) {
        const ch = text[i];
        if (ch === ',' || ch === '\n') break;
        if (ch === '\r' && text[i + 1] === '\n') break;
        value += ch;
        i += 1;
      }
    }
    row.push(value);
    if (text[i] === ',') {
      i += 1;
      continue;
    }
    const crlf = text[i] === '\r' && text[i + 1] === '\n';
    if (text[i] === '\n' || crlf) {
      i += crlf ? 2 : 1;
      rows.push(row);
      row = [];
      continue;
    }
    rows.push(row);
    break;
  }
  return rows;
}

export function parseCSV(text) {
  if (typeof text !== 'string') throw err('E_INVALID_INPUT', 'text must be a string');
  if (text === '') return [];
  return scanRows(text);
}

function fieldText(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  const type = typeof value;
  if (type === 'number' || type === 'bigint' || type === 'boolean') return String(value);
  throw err('E_INVALID_VALUE', `unsupported field type: ${type}`);
}

function needsQuote(text) {
  if (text === '') return false;
  if (/[",\r\n]/.test(text)) return true;
  return /^[ \t]/.test(text) || /[ \t]$/.test(text);
}

export function toCSV(rows) {
  if (!Array.isArray(rows)) throw err('E_INVALID_ROW', 'rows must be an array');
  let out = '';
  for (const row of rows) {
    if (!Array.isArray(row)) throw err('E_INVALID_ROW', 'every row must be an array');
    const parts = row.map((value) => {
      const text = fieldText(value);
      return needsQuote(text) ? `"${text.replace(/"/g, '""')}"` : text;
    });
    out += `${parts.join(',')}\r\n`;
  }
  return out;
}

export function parseRecords(text) {
  const rows = parseCSV(text);
  if (rows.length === 0) return [];
  const header = rows[0];
  const seen = new Set();
  for (const name of header) {
    if (seen.has(name)) {
      throw err('E_DUPLICATE_HEADER', `duplicate header: ${JSON.stringify(name)}`);
    }
    seen.add(name);
  }
  const records = [];
  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r];
    if (row.length !== header.length) {
      throw err('E_RAGGED_ROW', `row ${r + 1} has ${row.length} fields, expected ${header.length}`);
    }
    const record = {};
    for (let c = 0; c < header.length; c += 1) record[header[c]] = row[c];
    records.push(record);
  }
  return records;
}

const USAGE = 'usage: node csv.mjs <file> [--out <path>] [--dry-run]';

function parseArgs(argv) {
  const parsed = { file: null, outPath: null, dryRun: false, error: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') parsed.dryRun = true;
    else if (a === '--out') {
      parsed.outPath = argv[i + 1];
      i += 1;
    } else if (a.startsWith('--')) parsed.error = { kind: 'E_BAD_ARG', detail: a };
    else if (parsed.file === null) parsed.file = a;
  }
  if (!parsed.error && parsed.file === null) parsed.error = { kind: 'usage' };
  return parsed;
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    const line = parsed.error.kind === 'usage'
      ? `${USAGE}\n`
      : `E_BAD_ARG: ${parsed.error.detail}\n`;
    process.stderr.write(line);
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

  let rows;
  try {
    rows = parseCSV(text);
  } catch (e) {
    process.stderr.write(`${String(e.code || 'E_PARSE')}\n`);
    process.exit(4);
  }

  const cols = rows.length > 0 ? rows[0].length : 0;
  for (const row of rows) {
    if (row.length !== cols) {
      process.stderr.write('E_RAGGED_ROW\n');
      process.exit(3);
    }
  }

  if (parsed.outPath !== null) {
    fs.writeFileSync(parsed.outPath, toCSV(rows), 'utf8');
    return;
  }
  process.stdout.write(`${JSON.stringify({ rows: rows.length, cols })}\n`);
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
