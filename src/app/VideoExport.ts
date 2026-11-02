// A finished film of the performance: every frame drawn at its exact time
// (offline, so a slow machine only takes longer, never drops a frame) at the
// chosen size, the piano rendered offline too, both encoded in the browser
// (WebCodecs: H.264 video, AAC audio or else Opus) into an MP4. The interface
// is HTML over the canvas, so it never appears in the frames.
import { Muxer, StreamTarget } from 'mp4-muxer';
import type { App } from './App';

export interface ExportOptions {
  /** width / height */
  aspect: number;
  /** length of the longer side, px */
  longSide: number;
  fps: number;
  t0: number;
  t1: number;
}

export interface ExportProgress {
  stage: 'sound' | 'frames' | 'finishing';
  frame: number;
  frames: number;
  /** seconds left, once known */
  eta: number | null;
}

/** even pixel dimensions for an aspect and long side */
export function exportSize(aspect: number, longSide: number): { width: number; height: number } {
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
  return aspect >= 1 ? { width: even(longSide), height: even(longSide / aspect) } : { width: even(longSide * aspect), height: even(longSide) };
}

/** a generous bitrate for the size: the film is meant to be kept, not streamed */
function bitrateFor(width: number, height: number, fps: number) {
  return Math.round(width * height * fps * 0.35);
}

const AVC = ['avc1.640034', 'avc1.640033', 'avc1.640032', 'avc1.64002A', 'avc1.4D0034', 'avc1.42003E'];

async function videoConfig(width: number, height: number, fps: number): Promise<VideoEncoderConfig | null> {
  if (typeof VideoEncoder === 'undefined') return null;
  for (const codec of AVC) {
    for (const hardwareAcceleration of ['prefer-hardware', 'prefer-software'] as const) {
      const c: VideoEncoderConfig = { codec, width, height, framerate: fps, bitrate: bitrateFor(width, height, fps), latencyMode: 'quality', hardwareAcceleration, avc: { format: 'avc' } };
      try {
        if ((await VideoEncoder.isConfigSupported(c)).supported) return c;
      } catch {
        /* try the next */
      }
    }
  }
  return null;
}

async function audioConfig(): Promise<{ config: AudioEncoderConfig; muxCodec: 'aac' | 'opus' } | null> {
  if (typeof AudioEncoder === 'undefined') return null;
  for (const [codec, muxCodec] of [['mp4a.40.2', 'aac'], ['opus', 'opus']] as const) {
    const c: AudioEncoderConfig = { codec, sampleRate: 48000, numberOfChannels: 2, bitrate: codec === 'opus' ? 256000 : 320000 };
    try {
      if ((await AudioEncoder.isConfigSupported(c)).supported) return { config: c, muxCodec };
    } catch {
      /* try the next */
    }
  }
  return null;
}

/** whether this browser can make the film at this size (and with sound) */
export async function exportSupport(width: number, height: number, fps: number) {
  return { video: !!(await videoConfig(width, height, fps)), audio: !!(await audioConfig()) };
}

/**
 * The file as it is written: all but the first 64 KiB arrive in order, so
 * they go straight into Blob parts (which the browser can keep out of the
 * page's memory); the head, which the muxer revisits to fill in sizes, stays
 * an editable buffer.
 */
class FileSink {
  private head = new Uint8Array(1 << 16);
  private parts: Blob[] = [];
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private end = 0;
  write(data: Uint8Array, pos: number) {
    const H = this.head.length;
    let d = data;
    let p = pos;
    if (p < H) {
      const n = Math.min(d.length, H - p);
      this.head.set(d.subarray(0, n), p);
      d = d.subarray(n);
      p += n;
      this.end = Math.max(this.end, p);
      if (!d.length) return;
    }
    if (p !== Math.max(this.end, H)) throw new Error('unexpected write position in the film');
    this.pending.push(d.slice());
    this.pendingBytes += d.length;
    this.end = p + d.length;
    if (this.pendingBytes > 32 << 20) this.flush();
  }
  private flush() {
    if (this.pending.length) this.parts.push(new Blob(this.pending as BlobPart[]));
    this.pending = [];
    this.pendingBytes = 0;
  }
  blob(): Blob {
    this.flush();
    return new Blob([this.head.slice(0, Math.min(this.head.length, this.end)), ...this.parts], { type: 'video/mp4' });
  }
}

export async function exportVideo(app: App, o: ExportOptions, onProgress: (p: ExportProgress) => void, signal: AbortSignal): Promise<{ blob: Blob; audio: boolean; width: number; height: number }> {
  const piece = app.piece;
  if (!piece) throw new Error('nothing to export');
  const { width, height } = exportSize(o.aspect, o.longSide);
  const vcfg = await videoConfig(width, height, o.fps);
  if (!vcfg) throw new Error(`this browser cannot encode ${width}×${height} H.264 video; try a smaller size or another browser (Chrome, Edge or Safari)`);
  const acfg = await audioConfig();
  const frames = Math.max(1, Math.round((o.t1 - o.t0) * o.fps));

  // the sound first (fast): the whole stretch, offline
  onProgress({ stage: 'sound', frame: 0, frames, eta: null });
  await app.audio.init();
  const sound = acfg ? await app.audio.renderOffline(piece.timeline, o.t0, o.t0 + frames / o.fps) : null;

  const sink = new FileSink();
  const muxer = new Muxer({
    target: new StreamTarget({ onData: (data, pos) => sink.write(data, pos) }),
    video: { codec: 'avc', width, height, frameRate: o.fps },
    ...(acfg ? { audio: { codec: acfg.muxCodec, sampleRate: 48000, numberOfChannels: 2 } } : {}),
    fastStart: false,
    firstTimestampBehavior: 'offset',
  });
  let failure: unknown = null;
  const venc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => (failure = e) });
  venc.configure(vcfg);
  const aenc = acfg ? new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: (e) => (failure = e) }) : null;
  aenc?.configure(acfg!.config);

  let audioDone = 0; // samples handed to the encoder
  const feedAudio = (until: number) => {
    if (!sound || !aenc) return;
    const end = Math.min(sound.length, Math.round(until * 48000));
    const block = 4800;
    while (audioDone < end) {
      const n = Math.min(block, end - audioDone);
      const data = new Float32Array(n * 2);
      data.set(sound.getChannelData(0).subarray(audioDone, audioDone + n), 0);
      data.set(sound.getChannelData(1).subarray(audioDone, audioDone + n), n);
      const ad = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((audioDone / 48000) * 1e6), data });
      aenc.encode(ad);
      ad.close();
      audioDone += n;
    }
  };

  const restore = app.beginExport(width, height);
  // two frames to settle the new size and quality (shadow maps, shaders) before recording
  app.renderAt(o.t0);
  app.renderAt(o.t0);
  const started = performance.now();
  try {
    const yieldNow = () => new Promise<void>((r) => setTimeout(r, 0));
    for (let i = 0; i < frames; i++) {
      if (signal.aborted) throw new DOMException('cancelled', 'AbortError');
      if (failure) throw failure;
      app.renderAt(o.t0 + i / o.fps);
      const vf = new VideoFrame(app.view.canvas, { timestamp: Math.round((i * 1e6) / o.fps), duration: Math.round(1e6 / o.fps) });
      venc.encode(vf, { keyFrame: i % (o.fps * 2) === 0 });
      vf.close();
      feedAudio((i + 1) / o.fps);
      while (venc.encodeQueueSize > 3) await yieldNow();
      if (i % 2 === 0) {
        const el = (performance.now() - started) / 1000;
        onProgress({ stage: 'frames', frame: i + 1, frames, eta: i > 8 ? (el / (i + 1)) * (frames - i - 1) : null });
        await yieldNow();
      }
    }
    feedAudio(frames / o.fps + 1);
    onProgress({ stage: 'finishing', frame: frames, frames, eta: 0 });
    await venc.flush();
    if (aenc) await aenc.flush();
    if (failure) throw failure;
    muxer.finalize();
    return { blob: sink.blob(), audio: !!sound, width, height };
  } finally {
    try {
      venc.close();
      aenc?.close();
    } catch {
      /* already closed */
    }
    restore();
  }
}
