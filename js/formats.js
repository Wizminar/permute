// What Permute can read, and what each kind of file can become.
import { extOf } from './util.js';

export const KINDS = {
  image: ['jpg', 'jpeg', 'jfif', 'png', 'webp', 'avif', 'gif', 'bmp', 'svg', 'ico', 'tif', 'tiff', 'heic', 'heif'],
  pdf: ['pdf'],
  document: ['docx', 'md', 'markdown', 'txt', 'html', 'htm'],
  data: ['csv', 'tsv', 'xlsx', 'xls', 'ods', 'json', 'yaml', 'yml', 'xml'],
  audio: ['mp3', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'flac', 'weba'],
  video: ['mp4', 'm4v', 'mov', 'webm', 'mkv'],
  archive: ['zip'],
};

const EXT_TO_KIND = Object.fromEntries(
  Object.entries(KINDS).flatMap(([kind, exts]) => exts.map((e) => [e, kind])),
);

// Normalise aliases so "jpeg" and "jpg" are treated as the same thing.
const ALIAS = { jpeg: 'jpg', jfif: 'jpg', tif: 'tiff', heif: 'heic', htm: 'html', markdown: 'md', yml: 'yaml', oga: 'ogg', m4v: 'mp4' };
export const canonical = (ext) => ALIAS[ext] || ext;

/** Formats a person might not recognise by extension get a plain-language name. */
export const LABEL = {
  jpg: 'JPG', png: 'PNG', webp: 'WebP', avif: 'AVIF', gif: 'GIF', bmp: 'BMP', tiff: 'TIFF', ico: 'ICO',
  svg: 'SVG', heic: 'HEIC', pdf: 'PDF', docx: 'Word', md: 'Markdown', txt: 'plain text', html: 'HTML',
  csv: 'CSV', tsv: 'TSV', xlsx: 'Excel', xls: 'Excel 97', ods: 'OpenDocument sheet', json: 'JSON',
  yaml: 'YAML', xml: 'XML', mp3: 'MP3', wav: 'WAV', ogg: 'Ogg', opus: 'Opus', m4a: 'M4A', aac: 'AAC',
  flac: 'FLAC', weba: 'WebM audio', mp4: 'MP4', mov: 'MOV', webm: 'WebM', mkv: 'MKV', zip: 'ZIP',
  'pdf-pages': 'separate PDF pages', unzip: 'separate files', 'gif-anim': 'animated GIF', 'docx-text': 'Word (text only)',
};

/**
 * Targets per kind, in the order shown. `combine: true` means several inputs
 * can be joined into one output (images or PDFs into one PDF, anything into a ZIP).
 */
const TARGETS = {
  image: ['jpg', 'png', 'webp', 'avif', 'pdf', 'gif', 'tiff', 'bmp', 'ico', 'zip'],
  pdf: ['jpg', 'png', 'docx-text', 'txt', 'pdf-pages', 'pdf', 'zip'],
  document: ['pdf', 'docx', 'html', 'md', 'txt', 'zip'],
  data: ['xlsx', 'csv', 'json', 'tsv', 'ods', 'yaml', 'xml', 'html', 'zip'],
  audio: ['mp3', 'wav', 'm4a', 'ogg', 'flac', 'zip'],
  video: ['mp4', 'webm', 'mov', 'mkv', 'gif-anim', 'mp3', 'wav', 'm4a', 'zip'],
  archive: ['unzip'],
};

export const COMBINABLE = new Set(['pdf', 'zip']);

/** Preferred output when a file is first added. */
const DEFAULT_TARGET = {
  jpg: 'png', png: 'jpg', webp: 'jpg', avif: 'jpg', gif: 'png', bmp: 'png', svg: 'png', ico: 'png',
  tiff: 'jpg', heic: 'jpg', pdf: 'jpg', docx: 'pdf', md: 'html', txt: 'pdf', html: 'md',
  csv: 'xlsx', tsv: 'xlsx', xlsx: 'csv', xls: 'xlsx', ods: 'xlsx', json: 'csv', yaml: 'json', xml: 'json',
  mp3: 'wav', wav: 'mp3', ogg: 'mp3', opus: 'mp3', m4a: 'mp3', aac: 'mp3', flac: 'mp3', weba: 'mp3',
  mp4: 'mp3', mov: 'mp4', webm: 'mp4', mkv: 'mp4', zip: 'unzip',
};

// Filled in by detectCapabilities(): targets this browser can't produce.
const unsupported = new Set();

export function kindOf(name) {
  return EXT_TO_KIND[extOf(name)] || null;
}

export function targetsFor(name) {
  const kind = kindOf(name);
  if (!kind) return [];
  const src = canonical(extOf(name));
  return TARGETS[kind].filter((t) => {
    if (unsupported.has(t)) return false;
    // Same format is allowed for images: that's how you resize or compress one.
    if (t === src && !COMBINABLE.has(t) && kind !== 'image') return false;
    if (kind === 'data' && t === src) return false;
    return true;
  });
}

export function defaultTarget(name) {
  const options = targetsFor(name);
  const pref = DEFAULT_TARGET[canonical(extOf(name))];
  return options.includes(pref) ? pref : options.find((t) => t !== 'zip') || options[0] || null;
}

export const outputExt = (target) => ({ 'pdf-pages': 'pdf', 'gif-anim': 'gif', 'docx-text': 'docx' }[target] || target);

export async function detectImageCapabilities() {
  const c = document.createElement('canvas');
  c.width = c.height = 2;
  const probe = (mime) => new Promise((res) => c.toBlob((b) => res(!!b && b.type === mime), mime));
  if (!(await probe('image/webp'))) unsupported.add('webp');
  if (!(await probe('image/avif'))) unsupported.add('avif');
}

let mediaChecked = null;
/** Ask the browser which audio/video encoders it has. Runs once, on first media file. */
export function detectMediaCapabilities() {
  mediaChecked ||= checkMedia();
  return mediaChecked;
}

async function checkMedia() {

  // Audio/video encoders vary a lot between browsers; ask mediabunny lazily
  // only if WebCodecs exists at all, otherwise hide media targets.
  if (typeof globalThis.AudioEncoder === 'undefined' && typeof globalThis.VideoEncoder === 'undefined') {
    ['mp4', 'webm', 'mov', 'mkv', 'gif-anim', 'm4a', 'ogg', 'flac'].forEach((t) => unsupported.add(t));
    return;
  }
  try {
    const { loadModule } = await import('./util.js');
    const mb = await loadModule('mediabunny.min.mjs');
    const [aac, opus, flac, avc, vp9, vp8] = await Promise.all([
      mb.canEncodeAudio('aac'), mb.canEncodeAudio('opus'), mb.canEncodeAudio('flac'),
      mb.canEncodeVideo('avc'), mb.canEncodeVideo('vp9'), mb.canEncodeVideo('vp8'),
    ]);
    if (!aac) unsupported.add('m4a');
    if (!opus) unsupported.add('ogg');
    if (!flac) unsupported.add('flac');
    if (!avc) { unsupported.add('mp4'); unsupported.add('mov'); }
    if (!vp9 && !vp8) unsupported.add('webm');
    if (!avc && !vp9 && !vp8) unsupported.add('mkv');
  } catch {
    // If mediabunny can't load we leave targets visible; conversion will explain.
  }
}
