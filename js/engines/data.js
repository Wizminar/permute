// Spreadsheets and structured data: CSV, TSV, Excel, ODS, JSON, YAML, XML.
import { loadScript, loadModule, baseOf, extOf, textBlob, escapeHtml, MIME, UserError } from '../util.js';
import { canonical } from '../formats.js';

const TREE = new Set(['json', 'yaml', 'xml']);

/** Generated HTML files can't run scripts, embed frames or submit forms, wherever they're opened. */
export const OUTPUT_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'">`;

// ── XML <-> plain objects ───────────────────────────────────────────────────

function xmlToObject(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new UserError("This XML isn't well-formed, so it can't be converted.");
  const walk = (el) => {
    const obj = {};
    for (const a of el.attributes) obj[`@${a.name}`] = a.value;
    const kids = [...el.children];
    if (!kids.length) {
      const t = el.textContent.trim();
      return Object.keys(obj).length ? (t ? { ...obj, '#text': t } : obj) : t;
    }
    for (const k of kids) {
      const v = walk(k);
      if (k.tagName in obj) obj[k.tagName] = [].concat(obj[k.tagName], [v]);
      else obj[k.tagName] = v;
    }
    return obj;
  };
  return { [doc.documentElement.tagName]: walk(doc.documentElement) };
}

const xmlName = (k) => {
  const n = String(k).replace(/[^\w.-]/g, '_');
  return /^[A-Za-z_]/.test(n) ? n : `_${n}`;
};
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function objectToXml(value) {
  const node = (name, v, pad) => {
    if (Array.isArray(v)) return v.map((x) => node(name, x, pad)).join('');
    if (v === null || v === undefined) return `${pad}<${name}/>\n`;
    if (typeof v !== 'object') return `${pad}<${name}>${xmlEsc(v)}</${name}>\n`;
    const attrs = Object.entries(v).filter(([k]) => k.startsWith('@')).map(([k, x]) => ` ${xmlName(k.slice(1))}="${xmlEsc(x)}"`).join('');
    const text = v['#text'] !== undefined ? xmlEsc(v['#text']) : '';
    const kids = Object.entries(v).filter(([k]) => !k.startsWith('@') && k !== '#text');
    if (!kids.length) return `${pad}<${name}${attrs}>${text}</${name}>\n`;
    return `${pad}<${name}${attrs}>${text}\n${kids.map(([k, x]) => node(xmlName(k), x, `${pad}  `)).join('')}${pad}</${name}>\n`;
  };
  let root = value;
  if (Array.isArray(value)) root = { rows: { row: value } };
  else if (typeof value !== 'object' || value === null || Object.keys(value).length !== 1) root = { root: value };
  // XML allows one root element: {"users": [..]} becomes <users><item>..</item></users>
  const [[rootName, rootValue]] = Object.entries(root);
  if (Array.isArray(rootValue)) root = { [rootName]: { item: rootValue } };
  const [[name, inner]] = Object.entries(root);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${node(xmlName(name), inner, '')}`;
}

// ── Tree <-> table ──────────────────────────────────────────────────────────

/** Find the most table-like array inside parsed JSON/YAML/XML. */
function findRows(v) {
  const isObj = (x) => x && typeof x === 'object';
  if (Array.isArray(v)) return v.map((x) => (isObj(x) && !Array.isArray(x) ? x : { value: x }));
  if (isObj(v)) {
    const vals = Object.values(v);
    const tables = vals.filter((a) => Array.isArray(a) && a.some(isObj));
    if (tables.length === 1) return findRows(tables[0]);
    if (vals.length === 1 && isObj(vals[0]) && !Array.isArray(vals[0])) return findRows(vals[0]);
    return [v];
  }
  return [{ value: v }];
}

/** CSV cells are text; turn plain numbers back into numbers (but keep 007 or +91… as text). */
const NUMERIC = /^-?(0|[1-9]\d{0,14})(\.\d+)?$/;
function typeNumbers(XLSX, wb) {
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    for (const addr of Object.keys(ws)) {
      if (addr[0] === '!') continue;
      const c = ws[addr];
      if (c.t === 's' && NUMERIC.test(c.v)) { c.t = 'n'; c.v = Number(c.v); delete c.w; }
    }
  }
}

function flatten(obj, prefix = '', out = {}) {
  if (obj === null || typeof obj !== 'object') { out[prefix || 'value'] = obj; return out; }
  if (Array.isArray(obj) && obj.every((x) => x === null || typeof x !== 'object')) { out[prefix || 'value'] = obj.join(', '); return out; }
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

async function parseTree(file, ext) {
  const text = await file.text();
  if (ext === 'json') {
    try { return JSON.parse(text.replace(/^\uFEFF/, '')); } catch (e) { throw new UserError(`This JSON has a syntax error: ${e.message}`); }
  }
  if (ext === 'yaml') {
    const yaml = await loadModule('js-yaml.min.mjs');
    let value;
    try { value = yaml.load(text, { schema: yaml.JSON_SCHEMA, maxAliases: 1000 }); } catch (e) { throw new UserError(`This YAML has a syntax error: ${e.reason || e.message}`); }
    assertReasonableSize(value);
    return value;
  }
  return xmlToObject(text);
}

/**
 * YAML aliases can make a few bytes expand into billions of values ("billion laughs").
 * Count nodes as they'd be written out, following shared references, and stop early.
 */
const MAX_NODES = 2_000_000;
function assertReasonableSize(root) {
  let count = 0;
  const stack = [root];
  while (stack.length) {
    const v = stack.pop();
    if (++count > MAX_NODES) throw new UserError('This file expands into far too much data to convert safely (it may be a YAML alias bomb).');
    if (v && typeof v === 'object') for (const k in v) stack.push(v[k]);
  }
}

/**
 * Spreadsheet apps run cells that start with = + - @ (or tab/CR) as formulas, so a CSV
 * made from untrusted data could execute =HYPERLINK(...) or DDE payloads when opened.
 * Prefix those text cells with ' (OWASP's advice). Plain numbers like -5 are left alone.
 */
const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?(\d+([.,]\d+)*|\d*\.\d+)([eE][+-]?\d+)?%?$/;
const neutralise = (v) => (FORMULA_START.test(v) && !PLAIN_NUMBER.test(v) ? `'${v}` : v);

function sheetToDelimited(XLSX, ws, sep) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: false });
  const quote = (v) => (v.includes(sep) || v.includes('"') || v.includes('\n') || v.includes('\r') ? `"${v.replace(/"/g, '""')}"` : v);
  return rows.map((r) => r.map((c) => {
    const v = neutralise(String(c ?? ''));
    return sep === '\t' ? v.replace(/[\t\r\n]+/g, ' ') : quote(v);
  }).join(sep)).join('\n');
}

async function writeTree(value, target) {
  if (target === 'json') return JSON.stringify(value, null, 2) + '\n';
  if (target === 'yaml') {
    const yaml = await loadModule('js-yaml.min.mjs');
    return yaml.dump(value, { lineWidth: 100, noRefs: true });
  }
  return objectToXml(value);
}

// ── Main ────────────────────────────────────────────────────────────────────

export async function convertData(file, target, opts, progress) {
  const src = canonical(extOf(file.name));
  const name = baseOf(file.name);

  // JSON/YAML/XML to each other keeps nesting intact.
  if (TREE.has(src) && TREE.has(target)) {
    const tree = await parseTree(file, src);
    return [{ blob: textBlob(await writeTree(tree, target), target), name: `${name}.${target}` }];
  }

  const XLSX = await loadScript('xlsx.full.min.js', 'XLSX');
  let wb;
  if (TREE.has(src)) {
    const rows = findRows(await parseTree(file, src)).map((r) => flatten(r));
    wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Sheet1');
  } else {
    try {
      if (src === 'csv' || src === 'tsv') {
        // Read as text so UTF-8 (accents, emoji, Hindi…) survives; keep values as typed.
        wb = XLSX.read((await file.text()).replace(/^\uFEFF/, ''), { type: 'string', FS: src === 'tsv' ? '\t' : undefined, raw: true });
        typeNumbers(XLSX, wb);
      } else {
        wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true, dense: true });
      }
    } catch {
      throw new UserError("This spreadsheet couldn't be opened. It may be damaged or password-protected.");
    }
  }
  progress(0.5);

  const sheets = wb.SheetNames.filter((n) => wb.Sheets[n]);
  const outName = (sheet) => (sheets.length > 1 ? `${name}-${sheet.replace(/[\\/:*?"<>|]/g, '_')}` : name);

  if (target === 'xlsx' || target === 'ods') {
    const bytes = XLSX.write(wb, { bookType: target, type: 'array', compression: true });
    return [{ blob: new Blob([bytes], { type: MIME[target] }), name: `${name}.${target}` }];
  }

  const out = [];
  for (const s of sheets) {
    const ws = wb.Sheets[s];
    let text;
    if (target === 'csv') text = `\uFEFF${sheetToDelimited(XLSX, ws, ',')}`; // BOM so Excel reads UTF-8
    else if (target === 'tsv') text = sheetToDelimited(XLSX, ws, '\t');
    else if (target === 'html') {
      const table = XLSX.utils.sheet_to_html(ws, { header: '', footer: '' });
      text = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">${OUTPUT_CSP}<title>${escapeHtml(s)}</title><style>body{font:14px system-ui,sans-serif;margin:2rem}table{border-collapse:collapse}td{border:1px solid #ccc;padding:.35rem .6rem}tr:first-child td{font-weight:600;background:#f3f3f3}</style></head><body>${table}</body></html>\n`;
    } else {
      const rows = XLSX.utils.sheet_to_json(ws, { defval: null, raw: true });
      text = await writeTree(target === 'xml' ? { rows: { row: rows } } : rows, target);
    }
    out.push({ blob: textBlob(text, target), name: `${outName(s)}.${target}` });
  }
  if (!out.length) throw new UserError('This file has no sheets with data.');
  return out;
}
