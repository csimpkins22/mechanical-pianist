// Planning a performance is heavy (a long piece takes many seconds). The
// library's pieces are planned at build time (tools/plan-library.cjs) and
// fetched ready-made; anything else is planned in a worker, and the result is
// kept in this browser (IndexedDB), so a piece opened before opens at once.
// Both arrive as plain data; the few classes in it (the timeline, its key
// mechanics, the motion signals) get their prototypes back here. Results are
// deterministic, so a stored plan is exactly the plan that would be computed
// again; both carry a hash of the planner's own source, so any change to it
// starts afresh.
import { Signal } from '../core/math';
import type { Override, Performance } from '../core/types';
import { KeyMechanics } from '../performance/KeyMechanics';
import { PerformanceTimeline } from '../performance/PerformanceTimeline';
import { decodePlan } from './planCodec';

declare const __PLAN_VERSION__: string;
export const PLAN_VERSION = __PLAN_VERSION__;

export interface PlanRequest {
  bytes: Uint8Array;
  name: string;
  tracks: number[];
  overrides: Map<number, Override>;
  /** where a plan prepared at build time for exactly this request can be fetched */
  prebuilt?: string;
}

export interface Planned {
  perf: Performance;
  timeline: PerformanceTimeline;
}

export type Progress = (fraction: number, label: string) => void;

// ------------------------------------------------------------- the cache
const DB = 'mechanical-pianist';

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('plans')) db.createObjectStore('plans');
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

let dbp: Promise<IDBDatabase | null> | null = null;
export const db = () => (dbp ??= openDb());

export async function idb<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  const d = await db();
  if (!d) return undefined;
  return new Promise((resolve) => {
    try {
      const r = fn(d.transaction(store, mode).objectStore(store));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

async function keyOf(req: PlanRequest): Promise<string> {
  const ov = [...req.overrides.entries()].sort((a, b) => a[0] - b[0]);
  const extra = new TextEncoder().encode(`${__PLAN_VERSION__}|${req.tracks.join(',')}|${JSON.stringify(ov)}`);
  const all = new Uint8Array(req.bytes.length + extra.length);
  all.set(req.bytes);
  all.set(extra, req.bytes.length);
  try {
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
    return Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    let x = 2166136261 >>> 0;
    for (let i = 0; i < all.length; i++) x = Math.imul(x ^ all[i], 16777619) >>> 0;
    return `fnv${x.toString(16)}-${all.length}`;
  }
}

/** give the plain data its classes back */
function revive(data: { perf: Performance; timeline: PerformanceTimeline }): Planned {
  const tl = data.timeline;
  Object.setPrototypeOf(tl, PerformanceTimeline.prototype);
  Object.setPrototypeOf(tl.keys, KeyMechanics.prototype);
  const seen = new Set<object>();
  const walk = (o: unknown) => {
    if (!o || typeof o !== 'object' || seen.has(o) || ArrayBuffer.isView(o)) return;
    seen.add(o);
    const r = o as Record<string, unknown>;
    if (r.data instanceof Float32Array && typeof r.t0 === 'number' && typeof r.rate === 'number') Object.setPrototypeOf(o, Signal.prototype);
    if (o instanceof Map) {
      for (const v of o.values()) walk(v);
      return;
    }
    for (const k of Object.keys(r)) walk(r[k]);
  };
  walk(tl.plan);
  return { perf: data.perf, timeline: tl };
}

/** a plan prepared at build time: gzipped, as base64 text (see tools/plan-library.cjs and planCodec.ts) */
async function fetchPrebuilt(url: string): Promise<{ perf: Performance; timeline: PerformanceTimeline }> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  const raw = atob((await r.text()).trim());
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  let buf: ArrayBuffer = bytes.buffer;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  return decodePlan(buf) as { perf: Performance; timeline: PerformanceTimeline };
}

// ------------------------------------------------------------- the workers
interface Job {
  key: string;
  worker: Worker | null;
  promise: Promise<Planned>;
  reject: (e: Error) => void;
  listeners: Set<Progress>;
  background: boolean;
  /** started for the viewer (not as preparation): cancelled if they change their mind */
  foreground: boolean;
}

export class Cancelled extends Error {
  constructor() {
    super('superseded');
  }
}

export class Planner {
  private jobs = new Map<string, Job>();
  private fg: Job | null = null;
  private bgQueue: PlanRequest[] = [];
  private bgBusy = false;
  /** last known progress per cache key (for the library's "preparing" marks) */
  readonly status = new Map<string, number>();
  onStatus?: () => void;

  async cached(req: PlanRequest): Promise<boolean> {
    if (req.prebuilt) return true;
    const key = await keyOf(req);
    if (this.status.get(key) === 1) return true;
    const hit = (await idb('plans', 'readonly', (s) => s.count(key))) ?? 0;
    if (hit) this.status.set(key, 1);
    return hit > 0;
  }

  async key(req: PlanRequest) {
    return keyOf(req);
  }

  /**
   * A performance for this request: from the cache, from a job already
   * running for it, or planned now. A new foreground request cancels the
   * previous foreground job (the viewer changed their mind); background jobs
   * (preparing the library) are left to finish.
   */
  async plan(req: PlanRequest, progress?: Progress, background = false): Promise<Planned> {
    const key = await keyOf(req);
    const hit = await idb<{ perf: Performance; timeline: PerformanceTimeline }>('plans', 'readonly', (s) => s.get(key));
    if (hit) {
      this.status.set(key, 1);
      progress?.(1, 'Ready');
      return revive(hit);
    }
    if (req.prebuilt) {
      try {
        progress?.(0.4, 'Fetching the prepared performance');
        const data = await fetchPrebuilt(req.prebuilt);
        this.status.set(key, 1);
        progress?.(1, 'Ready');
        return revive(data);
      } catch (err) {
        console.warn('prepared plan unavailable, planning here instead:', err);
      }
    }
    let job = this.jobs.get(key);
    if (!job) job = this.start(req, key, background);
    else if (!background && job.background) job.background = false; // promote
    if (!background) {
      const prev = this.fg;
      if (prev && prev !== job && this.jobs.get(prev.key) === prev) {
        // the viewer changed their mind: drop what only they wanted, keep preparing the rest
        if (prev.foreground) this.cancel(prev);
        else prev.background = true;
      }
      this.fg = job;
    }
    if (progress) job.listeners.add(progress);
    try {
      return revive(structuredClone(await job.promise) as unknown as { perf: Performance; timeline: PerformanceTimeline });
    } finally {
      if (progress) job.listeners.delete(progress);
    }
  }

  private start(req: PlanRequest, key: string, background: boolean): Job {
    const listeners = new Set<Progress>();
    let resolve!: (p: Planned) => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<Planned>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const job: Job = { key, worker: null, promise, reject, listeners, background, foreground: !background };
    const live = () => this.jobs.get(key) === job;
    const progress = (fraction: number, label: string) => {
      if (!live()) return;
      this.status.set(key, Math.min(0.99, fraction));
      this.onStatus?.();
      for (const l of listeners) l(fraction, label);
    };
    const done = (data: Planned) => {
      job.worker?.terminate();
      if (!live()) return;
      this.jobs.delete(key);
      this.status.set(key, 1);
      this.onStatus?.();
      // keep it for next time (plain data, before any prototypes are set)
      void idb('plans', 'readwrite', (s) => s.put({ perf: data.perf, timeline: data.timeline }, key));
      resolve(data);
    };
    const fail = (message: string) => {
      job.worker?.terminate();
      if (!live()) return;
      this.jobs.delete(key);
      this.status.delete(key);
      this.onStatus?.();
      reject(new Error(message));
    };
    // where workers are unavailable, plan here instead (the page pauses meanwhile)
    let heard = false;
    const inline = async () => {
      job.worker?.terminate();
      job.worker = null;
      try {
        const [{ planChecked }, { buildScore, readMidi }] = await Promise.all([import('./plan'), import('../interpretation/MidiEngine')]);
        await new Promise((r) => setTimeout(r, 30));
        if (!live()) return;
        const res = planChecked(buildScore(readMidi(req.bytes, req.name), req.tracks), req.overrides);
        done({ perf: res.perf, timeline: structuredClone(res.timeline) as unknown as PerformanceTimeline });
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    };
    try {
      const worker = new Worker(new URL('./planner.worker.ts', import.meta.url), { type: 'module' });
      job.worker = worker;
      worker.onmessage = (e: MessageEvent) => {
        heard = true;
        const m = e.data;
        if (m.type === 'progress') progress(m.fraction, m.label);
        else if (m.type === 'done') done({ perf: m.perf, timeline: m.timeline });
        else if (m.type === 'error') fail(m.message);
      };
      worker.onerror = (e) => {
        e.preventDefault();
        if (!heard) void inline(); // it never started (blocked, or no module workers)
        else fail(e.message || 'the planner stopped');
      };
      worker.postMessage({ bytes: req.bytes, name: req.name, tracks: req.tracks, overrides: [...req.overrides.entries()] });
    } catch {
      void inline();
    }
    this.jobs.set(key, job);
    this.status.set(key, 0);
    this.onStatus?.();
    return job;
  }

  private cancel(job: Job) {
    job.worker?.terminate();
    this.jobs.delete(job.key);
    this.status.delete(job.key);
    this.onStatus?.();
    job.reject(new Cancelled());
  }

  /** prepare pieces one by one in the background, so they open at once later */
  prepare(reqs: PlanRequest[]) {
    this.bgQueue.push(...reqs);
    void this.pump();
  }

  private async pump() {
    if (this.bgBusy) return;
    this.bgBusy = true;
    while (this.bgQueue.length) {
      const req = this.bgQueue.shift()!;
      if (await this.cached(req)) continue;
      try {
        await this.plan(req, undefined, true);
      } catch {
        /* a failed preparation is retried when the piece is opened */
      }
    }
    this.bgBusy = false;
  }
}
