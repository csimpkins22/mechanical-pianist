import { describe, expect, it } from 'vitest';
import { decodePlan, encodePlan, fingerprint } from '../src/app/planCodec';

describe('prepared plan files', () => {
  it('round-trip what a structured clone keeps: maps, sets, typed arrays, shared and cyclic references, odd numbers', () => {
    const shared = { x: 1 };
    const sig = { t0: 0.5, rate: 120, data: new Float32Array([1, 2.5, -3]) };
    const root: Record<string, unknown> = {
      a: [shared, shared, undefined, NaN, Infinity, -0.125],
      m: new Map<unknown, unknown>([[3, sig], ['k', shared]]),
      s: new Set([1, 'two']),
      f64: new Float64Array([Math.PI]),
      u8: new Uint8Array([1, 2, 3]).subarray(1),
      $$odd: 'escaped key',
      sig,
    };
    root.self = root;
    const back = decodePlan(encodePlan(root).slice().buffer) as typeof root & { a: unknown[]; m: Map<unknown, unknown>; self: unknown };
    expect(back.self).toBe(back);
    expect(back.a[0]).toBe(back.a[1]);
    expect(back.m.get('k')).toBe(back.a[0]);
    expect(back.m.get(3)).toBe(back.sig);
    expect(back.a[2]).toBeUndefined();
    expect(back.a[3]).toBeNaN();
    expect(back.a[4]).toBe(Infinity);
    expect(back.a[5]).toBe(-0.125);
    expect([...(back.s as Set<unknown>)]).toEqual([1, 'two']);
    expect(Array.from((back.sig as typeof sig).data)).toEqual([1, 2.5, -3]);
    expect((back.sig as typeof sig).data).toBeInstanceOf(Float32Array);
    expect(Array.from(back.f64 as Float64Array)).toEqual([Math.PI]);
    expect(Array.from(back.u8 as Uint8Array)).toEqual([2, 3]);
    expect(back.$$odd).toBe('escaped key');
  });

  it('fingerprints differ when a byte changes', () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    expect(fingerprint(a)).toBe(fingerprint(new Uint8Array([1, 2, 3, 4])));
    expect(fingerprint(a)).not.toBe(fingerprint(new Uint8Array([1, 2, 3, 5])));
  });
});
