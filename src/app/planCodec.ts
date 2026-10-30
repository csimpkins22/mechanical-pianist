// A compact file format for a planned performance, so the library's plans
// can be computed once at build time and shipped with the app
// (tools/plan-library.cjs). It holds the same plain data a structured clone
// would (own enumerable properties, maps, sets, typed arrays, shared
// references), without prototypes: planner.ts gives the classes back.
//
// Layout: "MPPL", u32 format, u32 JSON length, the JSON (the object graph,
// with typed arrays as references into the blob), padding to 8 bytes, then
// the typed arrays' bytes, each 8-byte aligned so they can be viewed in place.

const MAGIC = 0x4c50504d; // "MPPL"
const FORMAT = 1;

type TypedArray = Float32Array | Float64Array | Int8Array | Int16Array | Int32Array | Uint8Array | Uint16Array | Uint32Array | Uint8ClampedArray;
const TYPED: Record<string, new (b: ArrayBuffer, o: number, n: number) => TypedArray> = {
  Float32Array,
  Float64Array,
  Int8Array,
  Int16Array,
  Int32Array,
  Uint8Array,
  Uint16Array,
  Uint32Array,
  Uint8ClampedArray,
};

const isObj = (v: unknown): v is object => typeof v === 'object' && v !== null;

export function encodePlan(root: unknown): Uint8Array {
  // shared (or cyclic) objects are written once and referred to afterwards
  const seen = new Map<object, number>();
  const count = (v: unknown) => {
    if (!isObj(v)) return;
    const n = seen.get(v);
    seen.set(v, (n ?? 0) + 1);
    if (n !== undefined || ArrayBuffer.isView(v)) return;
    if (v instanceof Map) for (const [k, x] of v) (count(k), count(x));
    else if (v instanceof Set) for (const x of v) count(x);
    else if (Array.isArray(v)) for (const x of v) count(x);
    else for (const k of Object.keys(v)) count((v as Record<string, unknown>)[k]);
  };
  count(root);

  const chunks: { arr: TypedArray; offset: number }[] = [];
  let blob = 0;
  const ids = new Map<object, number>();
  const enc = (v: unknown): unknown => {
    if (v === undefined) return { $$u: 1 };
    if (typeof v === 'number') return Number.isFinite(v) ? v : { $$n: String(v) };
    if (typeof v === 'bigint' || typeof v === 'function' || typeof v === 'symbol') throw new Error(`cannot store a ${typeof v}`);
    if (!isObj(v)) return v;
    const id = ids.get(v);
    if (id !== undefined) return { $$ref: id };
    const shared = (seen.get(v) ?? 0) > 1;
    let me = -1;
    if (shared) ids.set(v, (me = ids.size));
    let out: unknown;
    if (ArrayBuffer.isView(v)) {
      const arr = v as TypedArray;
      const type = arr.constructor.name;
      if (!TYPED[type]) throw new Error(`cannot store a ${type}`);
      blob = Math.ceil(blob / 8) * 8;
      chunks.push({ arr, offset: blob });
      out = { $$ta: type, o: blob, n: arr.length };
      blob += arr.byteLength;
    } else if (v instanceof Map) out = { $$map: [...v].map(([k, x]) => [enc(k), enc(x)]) };
    else if (v instanceof Set) out = { $$set: [...v].map(enc) };
    else if (Array.isArray(v)) out = v.map(enc);
    else {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(v)) o[k.startsWith('$$') ? `$$${k}` : k] = enc((v as Record<string, unknown>)[k]);
      out = o;
    }
    return shared ? { $$def: me, v: out } : out;
  };
  const json = new TextEncoder().encode(JSON.stringify(enc(root)));
  const head = 12;
  const start = Math.ceil((head + json.length) / 8) * 8;
  const bytes = new Uint8Array(start + blob);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, FORMAT, true);
  dv.setUint32(8, json.length, true);
  bytes.set(json, head);
  for (const { arr, offset } of chunks) bytes.set(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), start + offset);
  return bytes;
}

export function decodePlan(buf: ArrayBuffer): unknown {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== MAGIC || dv.getUint32(4, true) !== FORMAT) throw new Error('not a plan file');
  const len = dv.getUint32(8, true);
  const tree = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, len)));
  const start = Math.ceil((12 + len) / 8) * 8;
  const defs: unknown[] = [];
  const dec = (v: unknown): unknown => {
    if (!isObj(v)) return v;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) v[i] = dec(v[i]);
      return v;
    }
    const o = v as Record<string, unknown>;
    if ('$$ref' in o) return defs[o.$$ref as number];
    if ('$$u' in o) return undefined;
    if ('$$n' in o) return Number(o.$$n);
    if ('$$def' in o) return fill(o.v, o.$$def as number);
    return fill(o, -1);
  };
  // make the container first (registered, for cycles), then its contents
  const fill = (v: unknown, id: number): unknown => {
    if (!isObj(v)) return v;
    const o = v as Record<string, unknown>;
    if (Array.isArray(v)) {
      if (id >= 0) defs[id] = v;
      return dec(v);
    }
    if ('$$ta' in o) {
      const T = TYPED[o.$$ta as string];
      const arr = new T(buf, start + (o.o as number), o.n as number);
      if (id >= 0) defs[id] = arr;
      return arr;
    }
    if ('$$map' in o) {
      const m = new Map();
      if (id >= 0) defs[id] = m;
      for (const [k, x] of o.$$map as [unknown, unknown][]) m.set(dec(k), dec(x));
      return m;
    }
    if ('$$set' in o) {
      const s = new Set();
      if (id >= 0) defs[id] = s;
      for (const x of o.$$set as unknown[]) s.add(dec(x));
      return s;
    }
    const out: Record<string, unknown> = {};
    if (id >= 0) defs[id] = out;
    for (const k of Object.keys(o)) out[k.startsWith('$$$$') ? k.slice(2) : k] = dec(o[k]);
    return out;
  };
  return dec(tree);
}

/** a short fingerprint of a file's bytes (FNV-1a and length) */
export function fingerprint(bytes: Uint8Array): string {
  let x = 2166136261 >>> 0;
  for (let i = 0; i < bytes.length; i++) x = Math.imul(x ^ bytes[i], 16777619) >>> 0;
  return `${x.toString(16).padStart(8, '0')}${bytes.length.toString(16)}`;
}
