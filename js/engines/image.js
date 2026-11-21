import { loadScript, loadModule, canvasToBlob, extOf, baseOf, MIME, UserError } from '../util.js';
import { canonical } from '../formats.js';

let libheifPromise;
async function decodeHeic(file) {
  libheifPromise ||= loadModule('libheif.mjs').then(async ({ default: factory }) => {
    const m = factory();
    return typeof m?.then === 'function' ? await m : m;
  });
  const libheif = await libheifPromise;
  const decoder = new libheif.HeifDecoder();
  const images = decoder.decode(new Uint8Array(await file.arrayBuffer()));
  if (!images?.length) throw new UserError("This HEIC photo couldn't be read. It may be damaged.");
  const image = images[0]; // the primary photo; later entries are thumbnails or depth maps
  const width = image.get_width(); const height = image.get_height();
  const data = new ImageData(width, height);
  await new Promise((resolve, reject) => {
    image.display({ data: data.data, width, height }, (out) => (out ? resolve() : reject(new UserError("This HEIC photo couldn't be decoded."))));
  });
  images.forEach((img) => img.free?.());
  return createImageBitmap(data);
}

/** Decode any supported image into something drawable. */
export async function decodeImage(file) {
  const ext = canonical(extOf(file.name));

  if (ext === 'heic') {
    try {
      return await createImageBitmap(file); // Safari decodes HEIC natively
    } catch {
      return decodeHeic(file);
    }
  }

  if (ext === 'tiff') {
    const fflate = await loadModule('fflate.mjs');
    globalThis.pako ||= { inflate: (d) => fflate.unzlibSync(d) };
    const UTIF = await loadScript('utif.js', 'UTIF');
    const buf = await file.arrayBuffer();
    const ifds = UTIF.decode(buf);
    const page = ifds.find((i) => i.t256) || ifds[0];
    UTIF.decodeImage(buf, page, ifds);
    const rgba = UTIF.toRGBA8(page);
    const data = new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, page.width * page.height * 4), page.width, page.height);
    return createImageBitmap(data);
  }

  if (ext === 'svg') {
    // SVGs are drawn through <img>, which never runs scripts inside them.
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new UserError("This SVG couldn't be read. It may be malformed."));
        i.src = url;
      });
      let w = img.naturalWidth || 1024;
      let h = img.naturalHeight || 1024;
      // Vector art: render small SVGs at a useful size instead of 24×24.
      const scale = Math.max(1, 2048 / Math.max(w, h));
      w = Math.round(w * scale); h = Math.round(h * scale);
      const c = new OffscreenCanvas(w, h);
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      return c.transferToImageBitmap();
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new UserError(`This browser can't open ${ext.toUpperCase()} images like this one.`);
  }
}

/** Draw a bitmap to a canvas, shrinking so the longest side is at most maxSide. */
export function toCanvas(bitmap, { maxSide = 0, background = null } = {}) {
  let { width: w, height: h } = bitmap;
  if (maxSide && Math.max(w, h) > maxSide) {
    const s = maxSide / Math.max(w, h);
    w = Math.max(1, Math.round(w * s)); h = Math.max(1, Math.round(h * s));
  }
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, w, h); }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  return c;
}

export const hasAlpha = (canvas) => {
  const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return true;
  return false;
};

function encodeBMP(canvas) {
  const { width: w, height: h } = canvas;
  const px = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const row = Math.ceil((w * 3) / 4) * 4;
  const size = 54 + row * h;
  const buf = new ArrayBuffer(size);
  const v = new DataView(buf);
  v.setUint16(0, 0x4d42, true); v.setUint32(2, size, true); v.setUint32(10, 54, true);
  v.setUint32(14, 40, true); v.setInt32(18, w, true); v.setInt32(22, h, true);
  v.setUint16(26, 1, true); v.setUint16(28, 24, true); v.setUint32(34, row * h, true);
  v.setInt32(38, 2835, true); v.setInt32(42, 2835, true);
  const out = new Uint8Array(buf);
  for (let y = 0; y < h; y++) {
    let o = 54 + (h - 1 - y) * row;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = px[i + 3] / 255; // flatten onto white
      out[o++] = px[i + 2] * a + 255 * (1 - a);
      out[o++] = px[i + 1] * a + 255 * (1 - a);
      out[o++] = px[i] * a + 255 * (1 - a);
    }
  }
  return new Blob([buf], { type: MIME.bmp });
}

async function encodeGIF(canvas) {
  const { GIFEncoder, quantize, applyPalette } = await loadModule('gifenc.mjs');
  const { width: w, height: h } = canvas;
  const { data } = canvas.getContext('2d').getImageData(0, 0, w, h);
  const palette = quantize(data, 256, { format: 'rgba4444', oneBitAlpha: true });
  const index = applyPalette(data, palette, 'rgba4444');
  const transparentIndex = palette.findIndex((c) => c[3] === 0);
  const gif = GIFEncoder();
  gif.writeFrame(index, w, h, { palette, transparent: transparentIndex >= 0, transparentIndex: Math.max(0, transparentIndex) });
  gif.finish();
  return new Blob([gif.bytes()], { type: MIME.gif });
}

async function encodeTIFF(canvas) {
  const UTIF = await loadScript('utif.js', 'UTIF');
  const { width: w, height: h } = canvas;
  const { data } = canvas.getContext('2d').getImageData(0, 0, w, h);
  return new Blob([UTIF.encodeImage(data.buffer, w, h)], { type: MIME.tiff });
}

async function encodeICO(bitmap) {
  const sizes = [16, 32, 48, 64, 128, 256];
  const pngs = [];
  for (const s of sizes) {
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    const k = Math.min(s / bitmap.width, s / bitmap.height);
    const w = bitmap.width * k; const h = bitmap.height * k;
    ctx.drawImage(bitmap, (s - w) / 2, (s - h) / 2, w, h);
    pngs.push(new Uint8Array(await (await canvasToBlob(c, 'image/png')).arrayBuffer()));
  }
  const header = 6 + 16 * sizes.length;
  const total = header + pngs.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint16(2, 1, true); v.setUint16(4, sizes.length, true);
  let offset = header;
  sizes.forEach((s, i) => {
    const e = 6 + i * 16;
    out[e] = s === 256 ? 0 : s; out[e + 1] = s === 256 ? 0 : s;
    v.setUint16(e + 4, 1, true); v.setUint16(e + 6, 32, true);
    v.setUint32(e + 8, pngs[i].length, true); v.setUint32(e + 12, offset, true);
    out.set(pngs[i], offset); offset += pngs[i].length;
  });
  return new Blob([out], { type: MIME.ico });
}

/**
 * opts.quality 0–1 (lossy formats), opts.maxSide (0 = original size).
 */
export async function convertImage(file, target, opts) {
  const bitmap = await decodeImage(file);
  try {
    let blob;
    if (target === 'ico') {
      blob = await encodeICO(bitmap);
    } else {
      const flatten = target === 'jpg' || target === 'bmp';
      const canvas = toCanvas(bitmap, { maxSide: opts.maxSide, background: flatten ? '#ffffff' : null });
      if (target === 'bmp') blob = encodeBMP(canvas);
      else if (target === 'gif') blob = await encodeGIF(canvas);
      else if (target === 'tiff') blob = await encodeTIFF(canvas);
      else {
        blob = await canvasToBlob(canvas, MIME[target], opts.quality);
        if (blob.type !== MIME[target]) throw new UserError(`This browser can't save ${target.toUpperCase()} files. Try Chrome or pick another format.`);
      }
    }
    return [{ blob, name: `${baseOf(file.name)}.${target}` }];
  } finally {
    bitmap.close?.();
  }
}
