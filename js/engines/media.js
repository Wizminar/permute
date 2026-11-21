// Audio and video, using the browser's own encoders (WebCodecs) through mediabunny.
// MP3 is encoded with a bundled WebAssembly encoder because browsers don't ship one.
import { loadModule, baseOf, MIME, UserError } from '../util.js';

let mp3Ready = null;
async function mediabunny(needMp3) {
  const mb = await loadModule('mediabunny.min.mjs');
  if (needMp3) {
    mp3Ready ||= (async () => {
      if (!(await mb.canEncodeAudio('mp3'))) {
        const { registerMp3Encoder } = await loadModule('mp3-encoder.min.mjs');
        registerMp3Encoder();
      }
    })();
    await mp3Ready;
  }
  return mb;
}

const AUDIO_ONLY = new Set(['mp3', 'wav', 'm4a', 'ogg', 'flac']);

function outputFormat(mb, target) {
  switch (target) {
    case 'mp4': case 'm4a': return new mb.Mp4OutputFormat({ fastStart: 'in-memory' });
    case 'mov': return new mb.MovOutputFormat({ fastStart: 'in-memory' });
    case 'webm': return new mb.WebMOutputFormat();
    case 'mkv': return new mb.MkvOutputFormat();
    case 'mp3': return new mb.Mp3OutputFormat();
    case 'wav': return new mb.WavOutputFormat();
    case 'ogg': return new mb.OggOutputFormat();
    case 'flac': return new mb.FlacOutputFormat();
    default: throw new UserError(`Can't make ${target} files.`);
  }
}

const REASONS = {
  undecodable_source_codec: "this browser can't decode it",
  unknown_source_codec: 'its codec is unknown',
  no_encodable_target_codec: "this browser can't encode a codec that fits the new format",
};

function openInput(mb, file) {
  return new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
}

/**
 * opts.height: 0 keeps the original; otherwise the video is scaled down to that height.
 * opts.bitrate: audio kbps for lossy audio.
 */
export async function convertMedia(file, target, opts, progress, signal) {
  const mb = await mediabunny(target === 'mp3');
  const input = openInput(mb, file);
  try {
    const audioOnly = AUDIO_ONLY.has(target);
    const vTrack = await input.getPrimaryVideoTrack().catch(() => null);
    const aTrack = await input.getPrimaryAudioTrack().catch(() => null);
    if (!vTrack && !aTrack) throw new UserError("This file couldn't be read as audio or video.");
    if (audioOnly && !aTrack) throw new UserError('This video has no sound to extract.');

    const output = new mb.Output({ format: outputFormat(mb, target), target: new mb.BufferTarget() });
    const video = audioOnly ? { discard: true } : {};
    if (!audioOnly && vTrack && opts.height && vTrack.displayHeight > opts.height) {
      video.height = opts.height - (opts.height % 2);
    }
    const audio = {};
    if (['mp3', 'm4a', 'ogg'].includes(target) && opts.bitrate) audio.bitrate = opts.bitrate * 1000;
    // MP4/MOV should play everywhere (QuickTime, iPhone, TVs): that means H.264 + AAC,
    // even if the source codec (say VP9 from a WebM) could technically be copied in.
    if (target === 'mp4' || target === 'mov') {
      if (vTrack && vTrack.codec !== 'avc' && (await mb.canEncodeVideo('avc'))) video.codec = 'avc';
      if (aTrack && aTrack.codec !== 'aac' && (await mb.canEncodeAudio('aac'))) audio.codec = 'aac';
    }
    if (target === 'm4a' && aTrack?.codec !== 'aac') audio.codec = 'aac';

    const conversion = await mb.Conversion.init({ input, output, video, audio, tracks: 'primary' });
    if (!conversion.isValid) {
      const why = conversion.discardedTracks
        .filter((d) => d.reason !== 'discarded_by_user')
        .map((d) => `${d.track.type} track skipped because ${REASONS[d.reason] || d.reason.replace(/_/g, ' ')}`);
      throw new UserError(`Can't convert this file: ${why.join('; ') || 'no usable tracks'}. Try another format.`);
    }
    conversion.onProgress = (p) => progress(p);
    signal?.addEventListener('abort', () => conversion.cancel(), { once: true });
    await conversion.execute();

    const ext = target;
    return [{ blob: new Blob([output.target.buffer], { type: MIME[ext] }), name: `${baseOf(file.name)}.${ext}` }];
  } catch (e) {
    if (e instanceof UserError) throw e;
    if (e?.name === 'ConversionCanceledError') throw new UserError('Stopped.');
    throw new UserError(/unsupported|not supported|unknown format/i.test(e?.message || '')
      ? "This browser can't read this file's format."
      : `Conversion failed: ${e?.message || e}`);
  } finally {
    input.dispose?.();
  }
}

/** Short animated GIF from the start of a video. opts.gifWidth, opts.gifSeconds. */
export async function videoToGif(file, opts, progress) {
  const mb = await mediabunny(false);
  const { GIFEncoder, quantize, applyPalette } = await loadModule('gifenc.mjs');
  const input = openInput(mb, file);
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new UserError('This file has no video.');
    if (!(await track.canDecode())) throw new UserError("This browser can't decode this video.");
    const duration = await track.computeDuration();
    const start = await track.getFirstTimestamp();
    const length = Math.min(duration - start, opts.gifSeconds || 10);
    const fps = 12;
    const width = Math.min(opts.gifWidth || 480, track.displayWidth);
    const height = Math.round((track.displayHeight / track.displayWidth) * width / 2) * 2;
    const sink = new mb.CanvasSink(track, { width, height, fit: 'fill' });
    const times = Array.from({ length: Math.max(1, Math.floor(length * fps)) }, (_, i) => start + i / fps);

    const gif = GIFEncoder();
    let palette = null; let i = 0;
    for await (const wrapped of sink.canvasesAtTimestamps(times)) {
      i++;
      if (!wrapped) continue;
      const ctx = wrapped.canvas.getContext('2d', { willReadFrequently: true });
      const { data } = ctx.getImageData(0, 0, width, height);
      // Re-quantize every 12 frames so colour shifts in the clip are kept without a palette per frame.
      if (!palette || i % 12 === 1) palette = quantize(data, 256);
      gif.writeFrame(applyPalette(data, palette), width, height, { palette, delay: Math.round(1000 / fps) });
      progress(i / times.length);
    }
    gif.finish();
    return [{ blob: new Blob([gif.bytes()], { type: MIME.gif }), name: `${baseOf(file.name)}.gif` }];
  } finally {
    input.dispose?.();
  }
}
