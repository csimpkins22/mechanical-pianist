// The drummer lab's "proposed layout": KitLayout with the moves this stage
// recommends for a seated adult (see the report on the drums-robot branch),
// applied at run time so the IK and the clearance checks can be compared on
// both. KitLayout.ts itself is not changed; this only moves its objects in
// the lab's own page, and puts them back.
//
// Why: in KitLayout the snare's strike spot is 0.30 m from the stool's centre
// and the kick pedal's heel 0.06 m in front of it (under the seat). A stick
// held a third of the way up needs about 0.40 m from the wrist to its tip, so
// the hands end up at the hips with the elbows drawn back behind the body, the
// snare sits on the left thigh and the right knee meets the kick. Moving the
// hand instruments about 0.18-0.22 m away and the pedals about 0.3 m forward
// lets the elbows hang at the sides and the shins stand near vertical.
import { DRUMS, PEDALS, type DrumId, type PedalId, type V3 } from '../KitLayout';

/** how far each instrument moves (metres, kit frame) */
export const DRUM_MOVES: Record<DrumId, V3> = {
  kick: [0, 0, -0.22],
  snare: [0.02, 0.04, -0.18],
  hihat: [-0.03, 0.05, -0.15],
  tom1: [-0.02, 0.03, -0.17],
  tom2: [-0.02, 0.03, -0.17],
  floorTom: [0.04, 0.04, -0.13],
  crash: [-0.02, 0.0, -0.12],
  ride: [0.04, 0.02, -0.16],
};
/** and each pedal's heel and ball */
export const PEDAL_MOVES: Record<PedalId, { heel: V3; ball: V3 }> = {
  kickPedal: { heel: [0, 0, -0.25], ball: [0, 0, -0.25] },
  hihatPedal: { heel: [-0.04, 0, -0.22], ball: [-0.05, 0, -0.22] },
};

const orig = {
  drums: Object.fromEntries(Object.values(DRUMS).map((d) => [d.id, { centre: [...d.centre] as V3, yaw: d.yaw }])) as Record<DrumId, { centre: V3; yaw: number }>,
  pedals: Object.fromEntries(Object.entries(PEDALS).map(([k, p]) => [k, { heel: [...p.heel] as V3, ball: [...p.ball] as V3 }])) as Record<PedalId, { heel: V3; ball: V3 }>,
};

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

export type LayoutName = 'kit' | 'proposed';
let current: LayoutName = 'kit';

/** move the kit (in place) to KitLayout's own positions, or to the proposed ones */
export function useLayout(which: LayoutName) {
  current = which;
  for (const id of Object.keys(DRUMS) as DrumId[]) {
    const d = DRUMS[id];
    const o = orig.drums[id];
    const c = which === 'kit' ? o.centre : add(o.centre, DRUM_MOVES[id]);
    d.centre[0] = c[0];
    d.centre[1] = c[1];
    d.centre[2] = c[2];
    // a drum's yaw turns its tilt toward the stool (KitLayout's rule), the kick's stays square
    d.yaw = id === 'kick' ? o.yaw : Math.atan2(-c[0], -c[2]);
  }
  for (const id of Object.keys(PEDALS) as PedalId[]) {
    const p = PEDALS[id];
    const o = orig.pedals[id];
    const h = which === 'kit' ? o.heel : add(o.heel, PEDAL_MOVES[id].heel);
    const b = which === 'kit' ? o.ball : add(o.ball, PEDAL_MOVES[id].ball);
    p.heel.splice(0, 3, ...h);
    p.ball.splice(0, 3, ...b);
  }
}

export function layout(): LayoutName {
  return current;
}

/** the proposed positions, in KitLayout's terms, for the report */
export function proposedNumbers() {
  return {
    drums: Object.fromEntries((Object.keys(DRUMS) as DrumId[]).map((id) => [id, add(orig.drums[id].centre, DRUM_MOVES[id]).map((x) => +x.toFixed(3))])),
    pedals: Object.fromEntries(
      (Object.keys(PEDALS) as PedalId[]).map((id) => [
        id,
        { heel: add(orig.pedals[id].heel, PEDAL_MOVES[id].heel).map((x) => +x.toFixed(3)), ball: add(orig.pedals[id].ball, PEDAL_MOVES[id].ball).map((x) => +x.toFixed(3)) },
      ]),
    ),
  };
}
