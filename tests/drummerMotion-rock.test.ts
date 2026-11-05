// The rock groove, frame by frame at 120 fps (see drummerMotionAudit.ts): every contact with the kit as it moves
// or between the arms, every joint past its range, every hand and stick tip past a person's speed, the feet on
// their boards. Prints everything it finds; fails on anything new or worse than what is known (KNOWN).
import { expect, test } from 'vitest';
import { GROOVES, audit, loadGroove, regressions, report } from './drummerMotionAudit';

const name = GROOVES[0];
test(`${name}: no stick, hand or arm through the kit or the other arm beyond what is known; joints, speeds and feet`, () => {
  const a = audit(loadGroove(name));
  console.log(report(name, a));
  // the feet: exactly on the boards the kit's reactions turn
  expect(a.feet).toBeLessThan(0.002);
  expect(a.board).toBeLessThan(1e-9);
  expect(regressions(name, a)).toEqual([]);
}, 600000);
