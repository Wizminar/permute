// Documents: Word, Markdown, HTML, plain text <-> PDF, Word, HTML, Markdown, text.
// Every input is turned into sanitised HTML, then into a list of simple blocks
// (headings, paragraphs, list items, tables, images) that each writer lays out.
import { loadScript, loadModule, baseOf, extOf, escapeHtml, textBlob, MIME, UserError, canvasToBlob } from '../util.js';
import { canonical } from '../formats.js';

// ── Reading ─────────────────────────────────────────────────────────────────

async function sourceHtml(file) {
  const ext = canonical(extOf(file.name));
  if (ext === 'docx') {
    const mammoth = await loadScript('mammoth.min.js', 'mammoth');
    try {
      const { value } = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
      return value;
    } catch {
      throw new UserError("This Word file couldn't be opened. Old .doc files aren't supported; save it as .docx first.");
    }
  }
  const text = await file.text();
  if (ext === 'md') {
    const { marked } = await loadModule('marked.mjs');
    return marked.parse(text, { gfm: true, breaks: false });
  }
  if (ext === 'html') return text;
  return textToHtml(text);
}

const textToHtml = (text) => text
  .replace(/\r\n?/g, '\n')
  .split(/\n{2,}/)
  .filter((p) => p.trim())
  .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
  .join('\n');

/** Sanitised, inert DOM body for the file. Scripts, styles and event handlers are removed. */
async function sourceBody(file) {
  const { default: DOMPurify } = await loadModule('purify.mjs');
  const clean = DOMPurify.sanitize(await sourceHtml(file), {
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'select', 'textarea', 'iframe', 'object', 'embed', 'video', 'audio'],
    FORBID_ATTR: ['style', 'class', 'id'],
  });
  return new DOMParser().parseFromString(`<body>${clean}</body>`, 'text/html').body;
}

// ── Blocks ──────────────────────────────────────────────────────────────────

const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'PRE', 'BLOCKQUOTE', 'HR', 'TABLE',
  'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'NAV', 'ASIDE', 'FIGURE', 'FIGCAPTION', 'DL', 'DT', 'DD',
  'ADDRESS', 'DETAILS', 'SUMMARY', 'CENTER']);

function collectInline(node, style, runs, images) {
  if (node.nodeType === 3) {
    const text = node.nodeValue.replace(/\s+/g, ' ');
    if (text) runs.push({ text, ...style });
    return;
  }
  if (node.nodeType !== 1) return;
  const tag = node.tagName;
  if (tag === 'BR') { runs.push({ text: '\n', ...style }); return; }
  if (tag === 'IMG') { if (node.getAttribute('src')?.startsWith('data:image/')) images.push(node.getAttribute('src')); return; }
  const next = { ...style };
  if (tag === 'STRONG' || tag === 'B' || tag === 'TH') next.bold = true;
  if (tag === 'EM' || tag === 'I' || tag === 'CITE') next.italic = true;
  if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP') next.code = true;
  if (tag === 'A' && node.getAttribute('href') && /^(https?:|mailto:)/i.test(node.getAttribute('href'))) next.link = node.getAttribute('href');
  for (const c of node.childNodes) collectInline(c, next, runs, images);
}

function trimRuns(runs) {
  const out = runs.filter((r) => r.text);
  // collapse spaces across run boundaries and at line breaks
  for (let i = 0; i < out.length; i++) {
    const prev = out[i - 1];
    if ((!prev || prev.text.endsWith(' ') || prev.text === '\n') && out[i].text.startsWith(' ')) out[i].text = out[i].text.slice(1);
  }
  while (out.length && !out[out.length - 1].text.trim()) out.pop();
  if (out.length) out[out.length - 1].text = out[out.length - 1].text.replace(/\s+$/, '');
  return out.filter((r) => r.text);
}

const runsText = (runs) => runs.map((r) => r.text).join('');

function blocksFrom(root) {
  const out = [];
  let listId = 0;

  const para = (nodes, ctx, extra = {}) => {
    const runs = []; const images = [];
    nodes.forEach((n) => collectInline(n, extra.bold ? { bold: true } : {}, runs, images));
    const r = trimRuns(runs);
    if (runsText(r).trim()) out.push({ t: 'p', runs: r, quote: ctx.quote, ...extra });
    images.forEach((src) => out.push({ t: 'img', src }));
  };

  const list = (el, ctx, depth) => {
    const ordered = el.tagName === 'OL';
    const id = ++listId;
    let n = Number(el.getAttribute('start')) || 1;
    for (const li of el.children) {
      if (li.tagName !== 'LI') continue;
      const inline = []; const nested = [];
      for (const c of li.childNodes) {
        if (c.nodeType === 1 && (c.tagName === 'UL' || c.tagName === 'OL')) nested.push(c);
        else inline.push(c);
      }
      const runs = []; const images = [];
      inline.forEach((c) => collectInline(c, {}, runs, images));
      const r = trimRuns(runs);
      out.push({ t: 'li', runs: r, ordered, n: n++, depth, listId: id, quote: ctx.quote });
      images.forEach((src) => out.push({ t: 'img', src }));
      nested.forEach((nl) => list(nl, ctx, depth + 1));
    }
  };

  const walk = (el, ctx) => {
    let pending = [];
    const flush = () => { if (pending.length) para(pending, ctx); pending = []; };
    for (const n of el.childNodes) {
      if (n.nodeType === 3) { pending.push(n); continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName;
      if (!BLOCK_TAGS.has(tag)) { pending.push(n); continue; }
      flush();
      if (/^H[1-6]$/.test(tag)) {
        const runs = []; const images = [];
        collectInline(n, {}, runs, images);
        const r = trimRuns(runs);
        if (runsText(r).trim()) out.push({ t: 'h', level: Number(tag[1]), runs: r });
      } else if (tag === 'P' || tag === 'DT' || tag === 'SUMMARY' || tag === 'FIGCAPTION') {
        para([...n.childNodes], ctx, tag === 'DT' ? { bold: true } : {});
      } else if (tag === 'UL' || tag === 'OL') {
        list(n, ctx, 0);
      } else if (tag === 'PRE') {
        out.push({ t: 'pre', text: n.textContent.replace(/\n$/, '') });
      } else if (tag === 'BLOCKQUOTE') {
        walk(n, { ...ctx, quote: true });
      } else if (tag === 'HR') {
        out.push({ t: 'hr' });
      } else if (tag === 'TABLE') {
        const rows = [...n.querySelectorAll('tr')].map((tr) => [...tr.children].map((td) => td.textContent.replace(/\s+/g, ' ').trim()));
        const width = Math.max(0, ...rows.map((r) => r.length));
        if (width) out.push({ t: 'table', rows: rows.map((r) => [...r, ...Array(width - r.length).fill('')]), header: !!n.querySelector('tr')?.querySelector('th') });
      } else {
        walk(n, ctx);
      }
    }
    flush();
  };

  walk(root, { quote: false });
  return out;
}

// ── Plain outputs ───────────────────────────────────────────────────────────

function blocksToText(blocks) {
  const parts = blocks.map((b) => {
    switch (b.t) {
      case 'h': return runsText(b.runs);
      case 'li': return `${'  '.repeat(b.depth)}${b.ordered ? `${b.n}.` : '-'} ${runsText(b.runs)}`;
      case 'pre': return b.text;
      case 'hr': return '---';
      case 'table': return b.rows.map((r) => r.join('\t')).join('\n');
      case 'img': return '';
      default: return (b.quote ? '> ' : '') + runsText(b.runs);
    }
  });
  // Blank line between blocks, but list items stay on consecutive lines.
  let out = '';
  parts.forEach((p, i) => {
    if (p === '') return;
    if (out) out += blocks[i].t === 'li' && blocks[i - 1]?.t === 'li' ? '\n' : '\n\n';
    out += p;
  });
  return `${out.replace(/\n{3,}/g, '\n\n')}\n`;
}

const DOC_CSS = `body{font:17px/1.6 Georgia,'Times New Roman',serif;color:#222;max-width:42rem;margin:3rem auto;padding:0 1.25rem}
h1,h2,h3,h4{font-family:system-ui,sans-serif;line-height:1.25}img{max-width:100%}pre,code{font:14px/1.5 ui-monospace,Menlo,monospace;background:#f3f3f3}
pre{padding:1rem;overflow:auto}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:.4rem .6rem;text-align:left}
blockquote{margin:0;padding-left:1rem;border-left:3px solid #ccc;color:#555}`;

// Generated HTML can't run scripts, embed frames or submit forms, wherever it's opened later.
const OUTPUT_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'">`;
const wrapHtml = (body, title) => `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n${OUTPUT_CSP}\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>${escapeHtml(title)}</title>\n<style>${DOC_CSS}</style>\n</head>\n<body>\n${body}\n</body>\n</html>\n`;

async function bodyToMarkdown(body) {
  const { default: TurndownService } = await loadModule('turndown.mjs');
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*' });
  td.addRule('table', {
    filter: 'table',
    replacement: (_, node) => {
      const rows = [...node.querySelectorAll('tr')].map((tr) => [...tr.children].map((c) => c.textContent.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()));
      if (!rows.length) return '';
      const w = Math.max(...rows.map((r) => r.length));
      const line = (r) => `| ${[...r, ...Array(w - r.length).fill('')].join(' | ')} |`;
      return `\n\n${line(rows[0])}\n| ${Array(w).fill('---').join(' | ')} |\n${rows.slice(1).map(line).join('\n')}\n\n`;
    },
  });
  // Embedded images become enormous data URLs in Markdown; keep their alt text instead.
  td.addRule('dataImages', { filter: (n) => n.nodeName === 'IMG' && /^data:/.test(n.getAttribute('src') || ''), replacement: (_, n) => (n.getAttribute('alt') ? `*[image: ${n.getAttribute('alt')}]*` : '') });
  // Escape "<" in text so literal tags in a document don't become live HTML in Markdown viewers.
  const baseEscape = td.escape.bind(td);
  td.escape = (str) => baseEscape(str).replace(/</g, '\\<');
  return `${td.turndown(body.innerHTML).replace(/\n[ \t]+\n/g, '\n\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

// ── Images inside documents ─────────────────────────────────────────────────

async function imageBytes(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  if (blob.type === 'image/png' || blob.type === 'image/jpeg') {
    const bmp = await createImageBitmap(blob);
    const r = { bytes: new Uint8Array(await blob.arrayBuffer()), type: blob.type === 'image/png' ? 'png' : 'jpg', width: bmp.width, height: bmp.height };
    bmp.close();
    return r;
  }
  // Anything else (gif, webp, svg, emf previews) is redrawn as PNG.
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  const png = await canvasToBlob(c, 'image/png');
  const r = { bytes: new Uint8Array(await png.arrayBuffer()), type: 'png', width: bmp.width, height: bmp.height };
  bmp.close();
  return r;
}

// ── PDF writer ──────────────────────────────────────────────────────────────

async function blocksToPdf(blocks, title, opts) {
  const { PDFDocument, StandardFonts, rgb } = await loadModule('pdf-lib.min.mjs');
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setCreator('Permute');
  const F = {
    r: await doc.embedFont(StandardFonts.Helvetica),
    b: await doc.embedFont(StandardFonts.HelveticaBold),
    i: await doc.embedFont(StandardFonts.HelveticaOblique),
    bi: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
    m: await doc.embedFont(StandardFonts.Courier),
  };
  const ink = rgb(0.13, 0.13, 0.15); const grey = rgb(0.42, 0.43, 0.47); const blue = rgb(0.12, 0.25, 0.75);
  const [PW, PH] = opts.page === 'letter' ? [612, 792] : [595.28, 841.89];
  const M = 64; const W = PW - M * 2;
  let page; let y; let replaced = false;

  const newPage = () => { page = doc.addPage([PW, PH]); y = PH - M; };
  const ensure = (h) => { if (y - h < M) newPage(); };
  newPage();

  // The 14 standard PDF fonts only cover Western European characters.
  const okCache = new Map();
  const safe = (text, font) => {
    let s = '';
    for (const ch of text) {
      const key = font.name + ch;
      if (!okCache.has(key)) { try { font.encodeText(ch); okCache.set(key, true); } catch { okCache.set(key, false); } }
      if (okCache.get(key)) s += ch;
      else { s += ch === '\t' ? '    ' : '?'; if (ch !== '\t') replaced = true; }
    }
    return s;
  };

  const fontFor = (r) => (r.code ? F.m : r.bold && r.italic ? F.bi : r.bold ? F.b : r.italic ? F.i : F.r);

  /** Break runs into lines of [{text,font,link}] fitting width. */
  const layout = (runs, size, width, base = {}) => {
    const lines = [[]]; let x = 0;
    const push = (text, font, link) => {
      const w = font.widthOfTextAtSize(text, size);
      lines[lines.length - 1].push({ text, font, link, w });
      x += w;
    };
    for (const run of runs) {
      const font = fontFor({ ...base, ...run });
      for (const part of run.text.split(/(\n| +)/)) {
        if (!part) continue;
        if (part === '\n') { lines.push([]); x = 0; continue; }
        const text = safe(part, font);
        const w = font.widthOfTextAtSize(text, size);
        if (/^ +$/.test(text)) { if (x > 0) push(' ', font, run.link); continue; }
        if (x + w > width && x > 0) {
          const line = lines[lines.length - 1];
          while (line.length && line[line.length - 1].text === ' ') { x -= line.pop().w; }
          lines.push([]); x = 0;
        }
        if (w > width) { // one very long word: hard-break it
          let chunk = '';
          for (const ch of text) {
            if (font.widthOfTextAtSize(chunk + ch, size) > width - x) { push(chunk, font, run.link); lines.push([]); x = 0; chunk = ''; }
            chunk += ch;
          }
          if (chunk) push(chunk, font, run.link);
        } else push(text, font, run.link);
      }
    }
    return lines;
  };

  const drawLines = (lines, { size, lh, indent = 0, color = ink, before }) => {
    lines.forEach((line, idx) => {
      ensure(lh);
      if (idx === 0 && before) before(y);
      let x = M + indent;
      for (const seg of line) {
        if (seg.text !== ' ') page.drawText(seg.text, { x, y: y - size, size, font: seg.font, color: seg.link ? blue : color });
        if (seg.link) page.drawLine({ start: { x, y: y - size - 1.5 }, end: { x: x + seg.w, y: y - size - 1.5 }, thickness: 0.5, color: blue });
        x += seg.w;
      }
      y -= lh;
    });
  };

  const HEAD = { 1: [22, 28, 18], 2: [17, 22, 14], 3: [14, 19, 12], 4: [12, 17, 10], 5: [11, 16, 8], 6: [11, 16, 8] };
  let prev = null;

  for (const b of blocks) {
    if (b.t === 'h') {
      const [size, lh, before] = HEAD[b.level];
      if (prev) y -= before;
      ensure(lh * 2); // keep a heading with at least one following line
      drawLines(layout(b.runs, size, W, { bold: true }), { size, lh });
      y -= 4;
    } else if (b.t === 'p') {
      const indent = b.quote ? 16 : 0;
      const startY = y;
      const lines = layout(b.runs, 11, W - indent, b.bold ? { bold: true } : {});
      drawLines(lines, { size: 11, lh: 16, indent, color: b.quote ? grey : ink });
      if (b.quote && y < startY) page.drawLine({ start: { x: M + 2, y: Math.min(startY, PH - M) }, end: { x: M + 2, y: y + 4 }, thickness: 2, color: rgb(0.8, 0.81, 0.84) });
      y -= 8;
    } else if (b.t === 'li') {
      const indent = 18 + b.depth * 18 + (b.quote ? 16 : 0);
      const marker = b.ordered ? `${b.n}.` : (b.depth % 2 ? '–' : '•');
      drawLines(layout(b.runs.length ? b.runs : [{ text: ' ' }], 11, W - indent), {
        size: 11, lh: 16, indent,
        before: (top) => page.drawText(marker, { x: M + indent - 4 - F.r.widthOfTextAtSize(marker, 11), y: top - 11, size: 11, font: F.r, color: ink }),
      });
      y -= 3;
    } else if (b.t === 'pre') {
      y -= 2;
      for (const raw of b.text.split('\n')) {
        const lines = layout([{ text: raw.replace(/\t/g, '    ') || ' ', code: true }], 9, W - 16);
        for (const line of lines) {
          ensure(13);
          page.drawRectangle({ x: M, y: y - 13, width: W, height: 13, color: rgb(0.95, 0.95, 0.96) });
          let x = M + 8;
          for (const seg of line) { page.drawText(seg.text, { x, y: y - 10, size: 9, font: F.m, color: ink }); x += seg.w; }
          y -= 13;
        }
      }
      y -= 10;
    } else if (b.t === 'hr') {
      ensure(20); y -= 8;
      page.drawLine({ start: { x: M, y }, end: { x: M + W, y }, thickness: 0.6, color: rgb(0.8, 0.81, 0.84) });
      y -= 12;
    } else if (b.t === 'table') {
      const cols = b.rows[0].length; const cw = W / cols; const size = 9; const lh = 12; const pad = 4;
      for (let r = 0; r < b.rows.length; r++) {
        const bold = r === 0 && b.header;
        const cells = b.rows[r].map((c) => layout([{ text: c || ' ', bold }], size, cw - pad * 2));
        const h = Math.max(...cells.map((c) => c.length)) * lh + pad * 2;
        ensure(h);
        cells.forEach((lines, c) => {
          const x0 = M + c * cw;
          if (bold) page.drawRectangle({ x: x0, y: y - h, width: cw, height: h, color: rgb(0.94, 0.94, 0.95) });
          page.drawRectangle({ x: x0, y: y - h, width: cw, height: h, borderColor: rgb(0.78, 0.79, 0.82), borderWidth: 0.5 });
          lines.forEach((line, li) => {
            let x = x0 + pad;
            for (const seg of line) { if (seg.text !== ' ') page.drawText(seg.text, { x, y: y - pad - size - li * lh + 1, size, font: seg.font, color: ink }); x += seg.w; }
          });
        });
        y -= h;
      }
      y -= 12;
    } else if (b.t === 'img') {
      try {
        const im = await imageBytes(b.src);
        const emb = im.type === 'png' ? await doc.embedPng(im.bytes) : await doc.embedJpg(im.bytes);
        const s = Math.min(1, W / (im.width * 0.75), (PH - M * 2) / (im.height * 0.75));
        const w = im.width * 0.75 * s; const h = im.height * 0.75 * s;
        ensure(h + 8);
        page.drawImage(emb, { x: M, y: y - h, width: w, height: h });
        y -= h + 12;
      } catch { /* skip images the browser can't decode */ }
    }
    prev = b;
  }

  const pages = doc.getPages();
  if (pages.length > 1) {
    pages.forEach((p, i) => {
      const label = `${i + 1} / ${pages.length}`;
      p.drawText(label, { x: PW / 2 - F.r.widthOfTextAtSize(label, 8) / 2, y: M / 2 - 4, size: 8, font: F.r, color: grey });
    });
  }
  return { bytes: await doc.save(), replaced };
}

// ── DOCX writer ─────────────────────────────────────────────────────────────

async function blocksToDocx(blocks, title) {
  const d = await loadScript('docx.iife.js', 'docx');
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, ExternalHyperlink, Table, TableRow, TableCell, WidthType, ImageRun, BorderStyle, LevelFormat, AlignmentType } = d;

  const runsOf = (runs, base = {}) => runs.map((r) => {
    if (r.text === '\n') return new TextRun({ break: 1 });
    const tr = new TextRun({ text: r.text, bold: r.bold || base.bold, italics: r.italic || base.italic, font: r.code ? 'Courier New' : undefined, style: r.link ? 'Hyperlink' : undefined, color: base.color });
    return r.link ? new ExternalHyperlink({ link: r.link, children: [tr] }) : tr;
  });

  const children = [];
  const olInstances = new Map();
  for (const b of blocks) {
    if (b.t === 'h') children.push(new Paragraph({ heading: HeadingLevel[`HEADING_${b.level}`], children: runsOf(b.runs) }));
    else if (b.t === 'p') children.push(new Paragraph({ children: runsOf(b.runs, { bold: b.bold, italic: b.quote, color: b.quote ? '555555' : undefined }), indent: b.quote ? { left: 567 } : undefined, spacing: { after: 160 }, pageBreakBefore: !!b.pageBreak }));
    else if (b.t === 'li') {
      if (b.ordered && !olInstances.has(b.listId)) olInstances.set(b.listId, olInstances.size + 1);
      children.push(new Paragraph({
        children: runsOf(b.runs),
        ...(b.ordered
          ? { numbering: { reference: 'ordered', level: Math.min(b.depth, 8), instance: olInstances.get(b.listId) } }
          : { bullet: { level: Math.min(b.depth, 8) } }),
      }));
    } else if (b.t === 'pre') {
      children.push(new Paragraph({ shading: { fill: 'F2F2F4' }, spacing: { after: 160 }, children: b.text.split('\n').map((l, i) => new TextRun({ text: l, font: 'Courier New', size: 18, break: i ? 1 : 0 })) }));
    } else if (b.t === 'hr') {
      children.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC', space: 1 } }, children: [] }));
    } else if (b.t === 'table') {
      children.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: b.rows.map((row, ri) => new TableRow({ tableHeader: ri === 0 && b.header, children: row.map((c) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: c, bold: ri === 0 && b.header })] })] })) })),
      }));
      children.push(new Paragraph({ children: [] }));
    } else if (b.t === 'img') {
      try {
        const im = await imageBytes(b.src);
        const s = Math.min(1, 600 / im.width);
        children.push(new Paragraph({ children: [new ImageRun({ type: im.type, data: im.bytes, transformation: { width: Math.round(im.width * s), height: Math.round(im.height * s) } })] }));
      } catch { /* skip */ }
    }
  }

  const doc = new Document({
    title,
    creator: 'Permute',
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    numbering: {
      config: [{
        reference: 'ordered',
        levels: Array.from({ length: 9 }, (_, level) => ({ level, format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][level % 3], text: `%${level + 1}.`, alignment: AlignmentType.START, style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } } })),
      }],
    },
    sections: [{ children: children.length ? children : [new Paragraph({ children: [] })] }],
  });
  return Packer.toBlob(doc);
}

// ── Public ──────────────────────────────────────────────────────────────────

export async function writeBlocks(blocks, target, title, opts) {
  if (target === 'pdf') {
    const { bytes, replaced } = await blocksToPdf(blocks, title, opts);
    return { blob: new Blob([bytes], { type: MIME.pdf }), note: replaced ? 'Some characters aren’t in the PDF’s built-in font and show as “?”.' : '' };
  }
  if (target === 'docx' || target === 'docx-text') return { blob: await blocksToDocx(blocks, title) };
  if (target === 'txt') return { blob: textBlob(blocksToText(blocks), 'txt') };
  throw new UserError(`Can't write ${target} from here.`);
}

export async function convertDocument(file, target, opts, progress) {
  const title = baseOf(file.name);
  const body = await sourceBody(file);
  progress(0.4);
  let blob; let note = '';
  if (target === 'html') blob = textBlob(wrapHtml(body.innerHTML, title), 'html');
  else if (target === 'md') blob = textBlob(await bodyToMarkdown(body), 'md');
  else {
    const blocks = blocksFrom(body);
    if (!blocks.length) throw new UserError('This file has no text to convert.');
    ({ blob, note } = await writeBlocks(blocks, target, title, opts));
  }
  return [{ blob, name: `${title}.${target}`, note }];
}

/** PDF pages (arrays of paragraph strings) → blocks, with a page break between pages. */
export const paragraphsToBlocks = (pages) => pages.flatMap((paras, pi) =>
  paras.map((text, i) => ({ t: 'p', runs: [{ text }], pageBreak: pi > 0 && i === 0 })));
