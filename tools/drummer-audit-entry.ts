// One groove's frame audit (tests/drummerMotionAudit.ts) as a summary, for tools/drummer-audit.cjs.
import { audit, loadGroove, report } from '../tests/drummerMotionAudit';

/** the hand, stick and arm capsules: a contact between two of them is between the arms, not with the kit */
const BODY = /^(stick|hand|forearm|upper arm) [RL]$/;

export function measure(name: string, fps: number) {
  const t0 = Date.now();
  const g = loadGroove(name);
  const a = audit(g, 0, Infinity, fps);
  let deepest = 0;
  let deepestWhat = '';
  let deepestKit = 0;
  let deepestKitWhat = '';
  for (const [k, v] of a.contacts) {
    const d = -v.worst;
    if (d > deepest) [deepest, deepestWhat] = [d, k];
    if (!BODY.test(k.split(' / ')[1]) && d > deepestKit) [deepestKit, deepestKitWhat] = [d, k];
  }
  let limitFrames = 0;
  let limitWorst = 0;
  for (const v of a.limits.values()) {
    limitFrames += v.n;
    limitWorst = Math.max(limitWorst, (-v.worst * 180) / Math.PI);
  }
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return {
    name,
    fps,
    seconds: Math.round((Date.now() - t0) / 1000),
    duration: r1(g.perf.duration),
    frames: a.samples,
    contactFrames: a.contactFrames,
    contactPct: Math.round((10000 * a.contactFrames) / a.samples) / 100,
    deepestMm: r1(deepest * 1000),
    deepestWhat,
    deepestKitMm: r1(deepestKit * 1000),
    deepestKitWhat,
    limitFrames,
    limitWorstDeg: r1(limitWorst),
    handOver: a.handOver,
    accelOver: a.accelOver,
    tipOver: a.tipOver,
    maxHand: Math.round(a.maxHand * 100) / 100,
    nan: a.nan,
    feetMm: Math.round(a.feet * 1e5) / 100,
    board: a.board,
    dropped: g.sticking.dropped.length,
    // as tests/drummerMotionAudit.ts records what is known: contacts and limits [frames, depth in mm or degrees]
    known: {
      contacts: Object.fromEntries([...a.contacts].sort((x, y) => x[1].worst - y[1].worst).map(([k, v]) => [k, [v.n, Math.ceil(-v.worst * 10000) / 10]])),
      limits: Object.fromEntries([...a.limits].map(([k, v]) => [k, [v.n, Math.ceil((-v.worst * 1800) / Math.PI) / 10]])),
      handOver: a.handOver,
      accelOver: a.accelOver,
      tipOver: a.tipOver,
      dropped: g.sticking.dropped.length,
    },
    report: report(name, a, fps),
  };
}
