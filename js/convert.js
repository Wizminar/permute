// Routes a file + target to the right engine.
import { kindOf, outputExt } from './formats.js';
import { loadModule, baseOf, MIME, UserError } from './util.js';

const engine = {
  image: () => import('./engines/image.js'),
  pdf: () => import('./engines/pdf.js'),
  document: () => import('./engines/document.js'),
  data: () => import('./engines/data.js'),
  media: () => import('./engines/media.js'),
};

/** Convert one file. Returns [{ blob, name, note? }]. */
export async function convertOne(file, target, opts, progress, signal) {
  const kind = kindOf(file.name);
  if (target === 'zip') return zipFiles([file], `${baseOf(file.name)}.zip`, progress);

  switch (kind) {
    case 'image': {
      if (target === 'pdf') return (await engine.pdf()).combineToPdf([file], opts, progress);
      return (await engine.image()).convertImage(file, target, opts);
    }
    case 'pdf': {
      const pdf = await engine.pdf();
      if (target === 'jpg' || target === 'png') return pdf.pdfToImages(file, target, opts, progress);
      if (target === 'pdf-pages') return pdf.splitPdf(file, progress);
      if (target === 'pdf') return pdf.combineToPdf([file], opts, progress);
      const pages = await pdf.pdfToParagraphs(file, (p) => progress(p * 0.7));
      const doc = await engine.document();
      const { blob } = await doc.writeBlocks(doc.paragraphsToBlocks(pages), target === 'docx-text' ? 'docx' : 'txt', baseOf(file.name), opts);
      return [{ blob, name: `${baseOf(file.name)}.${outputExt(target)}`, note: target === 'docx-text' ? 'Text only: layout, images and fonts aren’t kept.' : '' }];
    }
    case 'document': return (await engine.document()).convertDocument(file, target, opts, progress);
    case 'data': return (await engine.data()).convertData(file, target, opts, progress);
    case 'audio':
    case 'video': {
      const media = await engine.media();
      if (target === 'gif-anim') return media.videoToGif(file, opts, progress);
      return media.convertMedia(file, target, opts, progress, signal);
    }
    case 'archive': return unzip(file, progress);
    default: throw new UserError('This kind of file isn’t supported yet.');
  }
}

/** Several files into one output: a PDF or a ZIP. */
export async function convertCombined(files, target, opts, progress) {
  if (target === 'zip') return zipFiles(files, 'permute-files.zip', progress);
  if (target === 'pdf') return (await engine.pdf()).combineToPdf(files, opts, progress);
  throw new UserError(`Files can't be combined into ${target}.`);
}

// ── ZIP ─────────────────────────────────────────────────────────────────────

const STORED = /\.(jpe?g|png|webp|avif|gif|heic|mp[34]|m4a|mov|webm|mkv|ogg|zip|docx|xlsx|pptx|ods|pdf|woff2?)$/i;

/** Names must be unique inside a ZIP: photo.jpg, photo (2).jpg … */
export function uniqueNames(names) {
  const seen = new Map();
  return names.map((n) => {
    const key = n.toLowerCase();
    const count = seen.get(key) || 0;
    seen.set(key, count + 1);
    if (!count) return n;
    const m = /^(.*?)(\.[^.]*)?$/.exec(n);
    return `${m[1]} (${count + 1})${m[2] || ''}`;
  });
}

export async function zipBlobs(entries, name, progress = () => {}) {
  const { zip } = await loadModule('fflate.mjs');
  const names = uniqueNames(entries.map((e) => e.name));
  const data = {};
  for (let i = 0; i < entries.length; i++) {
    data[names[i]] = [new Uint8Array(await entries[i].blob.arrayBuffer()), { level: STORED.test(names[i]) ? 0 : 6 }];
    progress(((i + 1) / entries.length) * 0.5);
  }
  const bytes = await new Promise((res, rej) => zip(data, (err, out) => (err ? rej(err) : res(out))));
  progress(1);
  return { blob: new Blob([bytes], { type: MIME.zip }), name };
}

async function zipFiles(files, name, progress) {
  return [await zipBlobs(files.map((f) => ({ blob: f, name: f.name })), name, progress)];
}

const UNZIP_MAX_BYTES = 1024 ** 3; // 1 GB unpacked
const UNZIP_MAX_FILES = 10_000;

async function unzip(file, progress) {
  const { unzip: fflateUnzip } = await loadModule('fflate.mjs');
  const buf = new Uint8Array(await file.arrayBuffer());
  // Read the sizes the ZIP declares before inflating anything, so a ZIP bomb is refused
  // instead of exhausting memory. fflate inflates into a buffer of exactly the declared
  // size, so an entry can't secretly grow past it.
  let total = 0; let count = 0;
  await new Promise((res, rej) => fflateUnzip(buf, { filter: (f) => { total += f.originalSize; count++; return false; } }, (err) => (err ? rej(new UserError("This ZIP couldn't be opened. It may be damaged or encrypted.")) : res())));
  if (total > UNZIP_MAX_BYTES || count > UNZIP_MAX_FILES) {
    throw new UserError(`This ZIP unpacks to ${count} ${count === 1 ? "file" : "files"} and ${(total / 1024 ** 3).toFixed(1)} GB, which is more than a browser tab can safely hold.`);
  }
  const entries = await new Promise((res, rej) => fflateUnzip(buf, (err, out) => (err ? rej(new UserError("This ZIP couldn't be opened. It may be damaged or encrypted.")) : res(out))));
  const out = Object.entries(entries)
    .filter(([path, bytes]) => !path.endsWith('/') && !/(^|\/)(__MACOSX|\.DS_Store)/.test(path) && bytes.length)
    .map(([path, bytes]) => ({ blob: new Blob([bytes]), name: path.split('/').pop(), path }));
  progress(1);
  if (!out.length) throw new UserError('This ZIP is empty.');
  return out;
}
