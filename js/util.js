// Small shared helpers. No network calls happen anywhere in this app except
// loading its own files (scripts, fonts, wasm) from the same origin.

export const vendor = (file) => new URL(`../vendor/${file}`, import.meta.url).href;

const scriptCache = new Map();
/** Load a classic (non-module) vendor script once and return its global. */
export function loadScript(file, globalName) {
  if (!scriptCache.has(file)) {
    scriptCache.set(file, new Promise((resolve, reject) => {
      if (globalThis[globalName]) return resolve(globalThis[globalName]);
      const s = document.createElement('script');
      s.src = vendor(file);
      s.onload = () => resolve(globalThis[globalName]);
      s.onerror = () => {
        scriptCache.delete(file);
        reject(new Error(`Couldn't load ${file}. Reload the page and try again.`));
      };
      document.head.appendChild(s);
    }));
  }
  return scriptCache.get(file);
}

const moduleCache = new Map();
export function loadModule(file) {
  if (!moduleCache.has(file)) {
    const p = import(vendor(file));
    p.catch(() => moduleCache.delete(file));
    moduleCache.set(file, p);
  }
  return moduleCache.get(file);
}

export const extOf = (name) => {
  const m = /\.([^./\\]+)$/.exec(name);
  return m ? m[1].toLowerCase() : '';
};
export const baseOf = (name) => name.replace(/\.[^./\\]+$/, '') || name;

export function formatBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(b < 10240 ? 1 : 0)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

export const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const MIME = {
  jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif',
  gif: 'image/gif', bmp: 'image/bmp', tiff: 'image/tiff', ico: 'image/x-icon',
  svg: 'image/svg+xml', pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  html: 'text/html', md: 'text/markdown', txt: 'text/plain', csv: 'text/csv',
  tsv: 'text/tab-separated-values', json: 'application/json', yaml: 'application/yaml',
  xml: 'application/xml', zip: 'application/zip',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
};

export const textBlob = (text, ext) =>
  new Blob([text], { type: `${MIME[ext] || 'text/plain'};charset=utf-8` });

export function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The browser could not encode this image.'))), type, quality);
  });
}

/** Thrown for problems the person can act on; message is shown verbatim. */
export class UserError extends Error {}

/** Yield to the event loop so progress bars can paint during long loops. */
export const tick = () => new Promise((r) => setTimeout(r, 0));
