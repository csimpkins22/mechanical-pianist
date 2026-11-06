// How the robot drummer holds its arms, measured as the reference footage was (scratchpad stage "posture": the
// user's clips 1 and 10 run through MediaPipe Pose and Hands): the elbow out from the body and its bend, the
// forearm's slope, the hand against the forearm seen from the side, the wrist's own angles, and how high the wrist
// is over the spot the stick lands on. The library tests collect these at every hand stroke's impact and hold them,
// per instrument, to POSTURE: real drummers keep the elbows by the body (1-22 degrees out), bent 68-91 degrees,
// the forearm near level (25 degrees down to 6 up) and the wrist near straight (the hand 0-27 degrees below the
// forearm seen from the side); before this was pinned the robot winged its elbows 40-50 degrees out at the snare,
// held its hands 15-17 cm over it, and bent its wrists 30 degrees and more.
import { DOF_BASE, J, type Side } from '../src/drums/DrummerSpec';
import type { DrummerPose } from '../src/drums/DrummerIK';
import type { DrumId } from '../src/drums/KitLayout';

const D = 180 / Math.PI;

export interface ArmPosture {
  /** the elbow out from the body, seen from the front (degrees, the torso's frame from the hips and shoulders) */
  elbowOut: number;
  /** the elbow's bend (degrees, 0 straight) */
  elbowFlex: number;
  /** the forearm's slope to level (degrees, + rising to the hand) */
  forearmPitch: number;
  /** the hand (wrist to knuckles) against the forearm seen from the side (degrees, - bent down) */
  wristVert: number;
  /** the wrist's flexion (+ toward the palm) and deviation (+ toward the thumb), degrees */
  flex: number;
  dev: number;
  /** the wrist's height over the contact (metres) */
  wristAbove: number;
}

const sub = (a: ArrayLike<number>, b: ArrayLike<number>) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: number[]) => Math.hypot(a[0], a[1], a[2]);
const nrm = (a: number[]) => a.map((x) => x / (len(a) || 1));

/** the middle finger's knuckle in the hand's frame (core/hand_spec.json) */
const MCP = [-0.0047, 0.0015, -0.0975];

export function armPosture(p: DrummerPose, s: Side, point: ArrayLike<number>): ArmPosture {
  const P = (j: number) => [p.pos[j * 3], p.pos[j * 3 + 1], p.pos[j * 3 + 2]];
  const hip = P(J.leg.R.thigh).map((v, i) => (v + P(J.leg.L.thigh)[i]) / 2);
  const shR = P(J.arm.R.upper);
  const shL = P(J.arm.L.upper);
  const sh = shR.map((v, i) => (v + shL[i]) / 2);
  const up = nrm(sub(sh, hip));
  const r0 = sub(shR, shL);
  const right = nrm(r0.map((x, i) => x - up[i] * dot(r0, up)));
  const out = right.map((x) => (s === 'R' ? x : -x));
  const a = J.arm[s];
  const S = P(a.upper);
  const E = P(a.forearm);
  const W = P(a.hand);
  const w = p.world;
  const o = a.palm * 9;
  const K = [0, 1, 2].map((r) => W[r] + w[o + r * 3] * MCP[0] + w[o + r * 3 + 1] * MCP[1] + w[o + r * 3 + 2] * MCP[2]);
  const u = sub(E, S);
  const f = sub(W, E);
  const h = sub(K, W);
  const pitch = (v: number[]) => Math.asin(v[1] / len(v)) * D;
  return {
    elbowOut: Math.atan2(dot(u, out), -dot(u, up)) * D,
    elbowFlex: Math.acos(Math.max(-1, Math.min(1, dot(u, f) / len(u) / len(f)))) * D,
    forearmPitch: pitch(f),
    wristVert: pitch(h) - pitch(f),
    flex: p.angles[DOF_BASE[a.palm]] * D,
    dev: p.angles[DOF_BASE[a.palm] + 1] * D,
    wristAbove: W[1] - point[1],
  };
}

export type PostureGroup = 'snare' | 'hi-hat (crossed)' | 'toms' | 'floor tom' | 'ride' | 'crash';

/** the instrument a stroke is on, as the limits group them (the left hand on the hi-hat is too rare to hold) */
export function postureGroup(piece: DrumId, hand: Side): PostureGroup | null {
  if (piece === 'snare') return 'snare';
  if (piece === 'hihat') return hand === 'R' ? 'hi-hat (crossed)' : null;
  if (piece === 'tom1' || piece === 'tom2') return 'toms';
  if (piece === 'floorTom') return 'floor tom';
  if (piece === 'ride' || piece === 'crash') return piece;
  return null;
}

/** a bound on a statistic of one measure over a groove's strokes in a group: [measure, which, at least, at most] */
type Bound = [keyof ArmPosture, 'median' | 'p10' | 'p90', number, number];

/**
 * At impact, per instrument, over each groove's hand strokes (the footage's ranges where it shows them, and
 * otherwise what a reach to that instrument allows; each well inside what the robot did before): medians, and the
 * ninetieth percentile for the spread. Before the posture stage, across the sixteen grooves, the snare's medians
 * were: elbow out 5-48 degrees, the hand 5-55 degrees below the forearm, the wrist flexed 6-68 degrees and 6-18 cm
 * over the spot; the toms' forearms rose 28-47 degrees to the hand; the ride's elbow was 41-77 degrees out.
 */
export const POSTURE: Record<PostureGroup, Bound[]> = {
  snare: [
    ['elbowOut', 'median', -15, 20],
    ['elbowOut', 'p90', -Infinity, 25],
    ['elbowFlex', 'median', 60, 122],
    ['forearmPitch', 'median', -20, 10],
    ['wristVert', 'median', -28, 5],
    ['flex', 'median', -10, 32],
    ['flex', 'p90', -Infinity, 40],
    ['wristAbove', 'median', 0.04, 0.16],
  ],
  'hi-hat (crossed)': [
    ['elbowOut', 'median', -10, 25],
    ['elbowFlex', 'median', 70, 100],
    ['forearmPitch', 'median', 0, 32],
    ['wristVert', 'median', -28, 5],
    ['flex', 'median', -10, 28],
  ],
  toms: [
    ['elbowOut', 'median', -15, 18],
    ['forearmPitch', 'median', 0, 30],
    ['wristVert', 'median', -25, 5],
    ['flex', 'median', -10, 28],
  ],
  'floor tom': [
    ['elbowOut', 'median', -25, 10],
    ['forearmPitch', 'median', -20, 8],
    ['wristVert', 'median', -15, 8],
    ['flex', 'median', -10, 18],
  ],
  ride: [
    ['elbowOut', 'median', -10, 65],
    ['forearmPitch', 'median', 20, 48],
    ['wristVert', 'median', -38, 0],
    ['flex', 'median', -10, 38],
  ],
  crash: [
    ['forearmPitch', 'median', 10, 40],
    ['wristVert', 'median', -30, 5],
    ['flex', 'median', -10, 28],
  ],
};

/** the strokes' postures, by group, and their check against POSTURE */
export class PostureLog {
  private by = new Map<PostureGroup, ArmPosture[]>();
  add(group: PostureGroup | null, a: ArmPosture) {
    if (!group) return;
    const l = this.by.get(group) ?? [];
    l.push(a);
    this.by.set(group, l);
  }
  /** what is out of bounds (groups with fewer than `min` strokes are not held) */
  check(min = 12): string[] {
    const bad: string[] = [];
    for (const [g, list] of this.by) {
      if (list.length < min) continue;
      for (const [k, stat, lo, hi] of POSTURE[g]) {
        const v = list.map((a) => a[k]).sort((x, y) => x - y);
        const q = stat === 'median' ? 0.5 : stat === 'p10' ? 0.1 : 0.9;
        const x = v[Math.round(q * (v.length - 1))];
        if (!(x >= lo && x <= hi)) bad.push(`${g}: ${k} ${stat} ${x.toFixed(k === 'wristAbove' ? 3 : 1)} outside [${lo}, ${hi}] (${list.length} strokes)`);
      }
    }
    return bad;
  }
  summary(): string {
    const rows: string[] = [];
    for (const [g, list] of this.by) {
      const med = (k: keyof ArmPosture) => {
        const v = list.map((a) => a[k]).sort((x, y) => x - y);
        return v[v.length >> 1];
      };
      rows.push(`${g} (${list.length}): elbow out ${med('elbowOut').toFixed(0)}°, bent ${med('elbowFlex').toFixed(0)}°, forearm ${med('forearmPitch').toFixed(0)}°, hand on forearm ${med('wristVert').toFixed(0)}°, wrist ${med('flex').toFixed(0)}°/${med('dev').toFixed(0)}°, wrist ${(med('wristAbove') * 100).toFixed(1)} cm over the spot`);
    }
    return rows.join('\n');
  }
}
