import { loadModule, vendor, canvasToBlob, baseOf, extOf, MIME, UserError, tick } from '../util.js';
import { kindOf } from '../formats.js';
import { decodeImage, toCanvas, hasAlpha } from './image.js';

const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] };

let pdfjsPromise;
async function pdfjs() {
  pdfjsPromise ||= loadModule('pdf.min.mjs').then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = vendor('pdf.worker.min.mjs');
    return lib;
  });
  return pdfjsPromise;
}

async function openWithPdfjs(file) {
  const lib = await pdfjs();
  const task = lib.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    isEvalSupported: false, // never compile code from a PDF (CVE-2024-4367 class of bugs)
    enableXfa: false,
  });
  try {
    const doc = await task.promise;
    doc.close = () => task.destroy();
    return doc;
  } catch (e) {
    if (e?.name === 'PasswordException') throw new UserError('This PDF is password-protected. Remove the password first.');
    throw new UserError("This PDF couldn't be read. It may be damaged.");
  }
}

/** Render each page as an image. opts.dpi controls sharpness. */
export async function pdfToImages(file, target, opts, progress) {
  const doc = await openWithPdfjs(file);
  const scale = (opts.dpi || 150) / 72;
  const out = [];
  const pad = String(doc.numPages).length;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp, canvas: c }).promise;
    const blob = await canvasToBlob(c, MIME[target], opts.quality);
    const suffix = doc.numPages > 1 ? `-page-${String(p).padStart(pad, '0')}` : '';
    out.push({ blob, name: `${baseOf(file.name)}${suffix}.${target}` });
    page.cleanup();
    c.width = c.height = 0;
    progress(p / doc.numPages);
  }
  await doc.close();
  return out;
}

/** Pull text out of a PDF, page by page, rebuilding lines and paragraphs. */
export async function pdfToParagraphs(file, progress) {
  const doc = await openWithPdfjs(file);
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const { items } = await page.getTextContent();
    const paras = [];
    let line = ''; let lastY = null; let lastH = 0; let para = [];
    for (const it of items) {
      if (!('str' in it)) continue;
      const y = it.transform[5]; const h = it.height || lastH || 10;
      if (lastY !== null && Math.abs(y - lastY) > h * 0.5) {
        para.push(line.trim()); line = '';
        if (Math.abs(y - lastY) > h * 1.8) { if (para.join('')) paras.push(para.join(' ')); para = []; }
      }
      line += it.str + (it.hasEOL ? ' ' : '');
      lastY = y; lastH = h;
    }
    para.push(line.trim());
    if (para.join('')) paras.push(para.join(' ').replace(/\s+/g, ' '));
    pages.push(paras);
    progress(p / doc.numPages);
  }
  await doc.close();
  if (!pages.flat().join('').trim()) {
    throw new UserError('This PDF has no selectable text. It is probably scanned images, so try converting it to JPG instead.');
  }
  return pages;
}

/** Split into one PDF per page. */
export async function splitPdf(file, progress) {
  const { PDFDocument } = await loadModule('pdf-lib.min.mjs');
  const src = await loadPdfLib(PDFDocument, file);
  const n = src.getPageCount();
  const pad = String(n).length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const doc = await PDFDocument.create();
    const [page] = await doc.copyPages(src, [i]);
    doc.addPage(page);
    out.push({ blob: new Blob([await doc.save()], { type: MIME.pdf }), name: `${baseOf(file.name)}-page-${String(i + 1).padStart(pad, '0')}.pdf` });
    progress((i + 1) / n);
    await tick();
  }
  return out;
}

async function loadPdfLib(PDFDocument, file) {
  try {
    return await PDFDocument.load(await file.arrayBuffer(), { updateMetadata: false });
  } catch (e) {
    if (/encrypt/i.test(e.message)) throw new UserError('This PDF is password-protected. Remove the password first.');
    throw new UserError("This PDF couldn't be read. It may be damaged.");
  }
}

async function addImagePage(doc, file, opts) {
  const bitmap = await decodeImage(file);
  const canvas = toCanvas(bitmap, { maxSide: opts.maxSide || 0 });
  bitmap.close?.();
  const alpha = hasAlpha(canvas);
  const bytes = new Uint8Array(await (await canvasToBlob(canvas, alpha ? 'image/png' : 'image/jpeg', opts.quality ?? 0.92)).arrayBuffer());
  const img = alpha ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  const iw = canvas.width; const ih = canvas.height;
  canvas.width = canvas.height = 0;

  if (opts.page === 'fit' || !PAGE_SIZES[opts.page]) {
    // Page is the picture, at 96 dpi so it opens at a natural size.
    const w = iw * 0.75; const h = ih * 0.75;
    doc.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
    return;
  }
  let [pw, ph] = PAGE_SIZES[opts.page];
  if (iw > ih) [pw, ph] = [ph, pw]; // landscape photos get landscape pages
  const m = 28;
  const s = Math.min((pw - m * 2) / iw, (ph - m * 2) / ih);
  const w = iw * s; const h = ih * s;
  doc.addPage([pw, ph]).drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
}

/** Join images and PDFs, in order, into one PDF. Also used for a single image → PDF. */
export async function combineToPdf(files, opts, progress, name) {
  const { PDFDocument } = await loadModule('pdf-lib.min.mjs');
  const doc = await PDFDocument.create();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (kindOf(f.name) === 'pdf') {
      const src = await loadPdfLib(PDFDocument, f);
      const pages = await doc.copyPages(src, src.getPageIndices());
      pages.forEach((p) => doc.addPage(p));
    } else if (kindOf(f.name) === 'image') {
      await addImagePage(doc, f, opts);
    } else {
      throw new UserError(`${f.name} can't go into a PDF with these files. Convert it to PDF on its own first.`);
    }
    progress((i + 1) / files.length);
    await tick();
  }
  const outName = name || (files.length === 1 ? `${baseOf(files[0].name)}.pdf` : `${baseOf(files[0].name)}-combined.pdf`);
  return [{ blob: new Blob([await doc.save()], { type: MIME.pdf }), name: outName }];
}

export const isPdf = (f) => extOf(f.name) === 'pdf';
