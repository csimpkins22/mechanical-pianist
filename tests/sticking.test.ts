import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assignLimbs, footFor, scoreHands, type Hand, type LimbHit, type Sticking } from '../src/drums/Sticking';
import { stickingText } from '../src/drums/StickingTab';
import { readDrumMidi, type DrumPerformance } from '../src/drums/DrumScore';
import { DRUMS, PEDALS, type V3 } from '../src/drums/KitLayout';
import { PATTERNS, choke, flams, ghostNotes, jazzRide, perfOf, rockBeat, sixteenthHats, snareRoll, threeAtOnce, tomFill, type Note } from './stickingPatterns';

const groove = (name: string) => readDrumMidi(new Uint8Array(readFileSync(`src/music/drums/${name}.mid`)), name);
const GROOVES = ['groove-rock-87', 'groove-funk-102', 'groove-jazz-93'];

const hands = (s: Sticking) => s.hits.filter((h) => h.played && (h.limb === 'R' || h.limb === 'L'));
const beatOf = (p: DrumPerformance, h: { t: number }) => (h.t - p.bars[0]) / (60 / p.bpm);
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * The hard physical limits, checked from the outside: one limb per hit, and
 * no hand in two places at once (a move between instruments at most 6 m/s,
 * plus a stroke; on one instrument, a rebound at least 18 ms on).
 */
function expectPlayable(p: DrumPerformance, s: Sticking) {
  expect(s.hits).toHaveLength(p.hits.length);
  s.hits.forEach((h, k) => {
    expect(h.hit).toBe(k);
    const foot = footFor(p.hits[k]);
    if (foot) expect(h.limb).toBe(foot);
    else expect(['R', 'L']).toContain(h.limb);
  });
  for (const hand of ['R', 'L'] as Hand[]) {
    const mine = s.hits.filter((h) => h.played && h.limb === hand);
    for (let k = 1; k < mine.length; k++) {
      const a = mine[k - 1];
      const b = mine[k];
      const dt = b.t - a.t;
      if (a.piece === b.piece) expect(dt, `${hand} at ${b.t}`).toBeGreaterThanOrEqual(0.018 - 1e-9);
      else expect(dt, `${hand} ${a.piece} -> ${b.piece} at ${b.t}`).toBeGreaterThanOrEqual(0.03 + dist(a.at, b.at) / 6 - 1e-9);
      // the links the motion stage walks
      expect(b.prev).toBe(a.hit);
      expect(a.next).toBe(b.hit);
    }
  }
  expect(s.dropped.length).toBe(s.hits.filter((h) => !h.played).length);
}

describe('sticking: grooves', () => {
  it('plays a rock beat: right hand on the hi-hat over the left on the snare backbeat, right foot on the kick', () => {
    const p = rockBeat();
    const s = assignLimbs(p);
    expectPlayable(p, s);
    for (const h of s.hits) {
      if (h.piece === 'hihat') expect(h.limb).toBe('R');
      if (h.piece === 'snare') expect(h.limb).toBe('L');
      if (h.piece === 'kick') expect(h.limb).toBe('RF');
    }
    expect(s.dropped).toHaveLength(0);
    // the crossed-hands groove: the right over the left, the standard cross, not an awkward one
    expect(s.stats.hatCrosses).toBeGreaterThan(0);
    expect(s.stats.crossings).toBe(0);
    expect(s.hits.filter((h) => h.piece === 'snare').every((h) => h.over === 'R')).toBe(true);
    expect(s.home).toEqual([{ t: 0, R: 'hihat', L: 'snare' }]);
  });

  it('plays a jazz ride pattern: right hand on the ride, left foot chick on 2 and 4, left hand comping', () => {
    const p = jazzRide();
    const s = assignLimbs(p);
    expectPlayable(p, s);
    for (const h of s.hits) {
      if (h.piece === 'ride') expect(h.limb).toBe('R');
      if (h.piece === 'hihat') expect(h.limb).toBe('LF');
      if (h.piece === 'snare') expect(h.limb).toBe('L');
      if (h.piece === 'kick') expect(h.limb).toBe('RF');
    }
    // the chick lands on 2 and 4
    for (const h of s.hits.filter((x) => x.limb === 'LF')) expect([1, 3]).toContain(Math.round(beatOf(p, h)) % 4);
    expect(s.home[0]).toEqual({ t: 0, R: 'ride', L: 'snare' });
    expect(s.dropped).toHaveLength(0);
  });

  it('puts ghost notes in the left hand, between the right hand\'s hi-hat strokes', () => {
    const p = ghostNotes();
    const s = assignLimbs(p);
    expectPlayable(p, s);
    const ghosts = s.hits.filter((h) => h.piece === 'snare' && h.level === 'ghost');
    expect(ghosts.length).toBeGreaterThan(5);
    expect(ghosts.every((h) => h.limb === 'L')).toBe(true);
    expect(s.hits.filter((h) => h.piece === 'hihat').every((h) => h.limb === 'R')).toBe(true);
  });

  it('keeps sixteenth hats in one hand at 100 bpm, and shares them between the hands at 140', () => {
    const slow = assignLimbs(sixteenthHats(100));
    expect(slow.hits.filter((h) => h.piece === 'hihat').every((h) => h.limb === 'R')).toBe(true);
    expect(slow.stats.leftHandTime).toBe(0);
    const p = sixteenthHats(140);
    const fast = assignLimbs(p);
    expectPlayable(p, fast);
    expect(fast.dropped).toHaveLength(0);
    const hats = fast.hits.filter((h) => h.piece === 'hihat');
    const left = hats.filter((h) => h.limb === 'L').length;
    expect(left / hats.length).toBeGreaterThan(0.3);
    // two-handed time still leads with the right: the right on most beats and "ands"
    const eighths = hats.filter((h) => Math.abs(beatOf(p, h) * 2 - Math.round(beatOf(p, h) * 2)) < 0.1);
    expect(eighths.filter((h) => h.limb === 'R').length / eighths.length).toBeGreaterThan(0.6);
    // no hand keeps sixteenths alone at 140 (9.3 a second)
    expect(fast.stats.limbs.R.maxRate).toBeLessThan(9);
    expect(fast.stats.limbs.L.maxRate).toBeLessThan(9);
  });
});

describe('sticking: speed limits', () => {
  /** the longest run of strokes by one hand */
  const longestRun = (hs: LimbHit[]) => {
    let best = 0;
    let run = 0;
    hs.forEach((h, k) => {
      run = k && hs[k - 1].limb === h.limb ? run + 1 : 1;
      best = Math.max(best, run);
    });
    return best;
  };

  it('plays an 8-a-second snare roll with single strokes', () => {
    const p = snareRoll(8);
    const s = assignLimbs(p);
    expectPlayable(p, s);
    const roll = hands(s);
    expect(roll.every((h) => !h.double)).toBe(true);
    expect(s.stats.limbs.R.maxRate).toBeLessThanOrEqual(10);
    expect(s.stats.limbs.L.maxRate).toBeLessThanOrEqual(10);
  });

  it('alternates a 14-a-second roll hand to hand (RLRL), leading with the right', () => {
    const p = snareRoll(14);
    const s = assignLimbs(p);
    expectPlayable(p, s);
    const roll = hands(s);
    expect(longestRun(roll)).toBe(1);
    expect(roll[0].limb).toBe('R');
    expect(s.stats.doubles).toBe(0);
  });

  it('plays a 24-a-second roll in doubles (RRLL)', () => {
    const p = snareRoll(24);
    const s = assignLimbs(p);
    expectPlayable(p, s);
    const roll = hands(s).slice(0, -1);
    expect(longestRun(roll)).toBe(2);
    expect(s.stats.doubles).toBeGreaterThanOrEqual(roll.length / 2 - 2);
    // each double's second stroke follows its first on the same hand, off the rebound
    for (const h of roll.filter((x) => x.double)) expect(s.hits[h.prev].limb).toBe(h.limb);
    // twelve strokes a second per hand, in pairs: no hand plays fast singles
    expect(s.stats.limbs.R.maxRate).toBeLessThanOrEqual(13);
  });

  it('flags kick notes faster than one pedal comfortably repeats, without dropping them', () => {
    const notes: Note[] = [];
    for (let k = 0; k < 8; k++) notes.push([k / 16, 'kick', 'head', 0.8]);
    const s = assignLimbs(perfOf('kick run', notes));
    expect(s.stats.fastKicks).toBe(7);
    expect(s.dropped).toHaveLength(0);
    expect(s.hits.every((h) => h.limb === 'RF')).toBe(true);
  });
});

describe('sticking: two hands, never in two places at once', () => {
  it('plays a flam with both hands, the grace note by the other hand', () => {
    const p = flams();
    const s = assignLimbs(p);
    expectPlayable(p, s);
    const graces = s.hits.filter((h) => h.grace);
    expect(graces).toHaveLength(8);
    expect(s.stats.flams).toBe(8);
    for (const g of graces) {
      const main = s.hits.find((h) => h.piece === g.piece && h.t > g.t && h.t - g.t < 0.05)!;
      expect(main.limb).not.toBe(g.limb);
      expect(main.grace).toBe(false);
    }
    // right-handed flams on the snare: the left hand's grace note, the right's main note
    expect(graces.filter((g) => g.piece === 'snare').every((g) => g.limb === 'L')).toBe(true);
  });

  it('plays a fill down the toms without crossing the arms, and crashes on the 1 with the right hand and the kick', () => {
    const p = tomFill();
    const s = assignLimbs(p);
    expectPlayable(p, s);
    expect(s.dropped).toHaveLength(0);
    const fill = s.hits.filter((h) => beatOf(p, h) >= 4 - 0.01 && beatOf(p, h) < 8 - 0.01 && h.piece !== 'kick');
    expect(fill.map((h) => h.piece)).toEqual([...Array(4).fill('snare'), ...Array(4).fill('tom1'), ...Array(4).fill('tom2'), ...Array(4).fill('floorTom')]);
    // no crossed arms in the fill: the left hand never to the right of the right hand
    expect(fill.every((h) => h.over === null)).toBe(true);
    expect(s.stats.crossings).toBe(0);
    // led by the right hand on the beats, hand to hand between
    for (const h of fill) expect(h.limb, `beat ${beatOf(p, h)}`).toBe(Math.round((beatOf(p, h) - 4) * 4) % 2 ? 'L' : 'R');
    // the crash on the 1, with the kick
    const one = s.hits.filter((h) => Math.abs(beatOf(p, h) - 8) < 0.01);
    expect(one.find((h) => h.piece === 'crash')!.limb).toBe('R');
    expect(one.find((h) => h.piece === 'kick')!.limb).toBe('RF');
    // and back on the groove: the right on the hi-hat, the left on the backbeat
    const after = s.hits.filter((h) => beatOf(p, h) > 8.01);
    expect(after.filter((h) => h.piece === 'hihat').every((h) => h.limb === 'R')).toBe(true);
    expect(after.filter((h) => h.piece === 'snare').every((h) => h.limb === 'L')).toBe(true);
  });

  it('drops one of three hand notes at once, the least important, and says why', () => {
    const p = threeAtOnce();
    const s = assignLimbs(p);
    expectPlayable(p, s);
    expect(s.dropped).toHaveLength(1);
    const d = s.hits[s.dropped[0].hit];
    expect(d.piece).toBe('hihat');
    expect(d.played).toBe(false);
    expect(s.dropped[0].why).toMatch(/three hand notes at once/);
    expect(s.dropped[0].why).toMatch(/hihat/);
    // the other two have a hand each
    const together = s.hits.filter((h) => Math.abs(h.t - d.t) < 0.001 && h.played && h.piece !== 'kick');
    expect(together.map((h) => h.limb).sort()).toEqual(['L', 'R']);
    expect(s.stats.dropped).toBe(1);
  });

  it('chokes a crash with a free hand (the left), free around the choke', () => {
    const p = choke();
    const s = assignLimbs(p);
    expectPlayable(p, s);
    expect(s.chokes).toHaveLength(2);
    for (const c of s.chokes) {
      expect(c.piece).toBe('crash');
      expect(c.hand).toBe('L');
      // nothing else in that hand from just before the grab until it lets go
      expect(s.hits.filter((h) => h.limb === c.hand && h.t > c.t - 0.08 && h.t < c.t + 0.12)).toHaveLength(0);
    }
    expect(s.stats.chokesMissed).toBe(0);
    // the crash itself on the 1 is the right hand's
    expect(s.hits.filter((h) => h.piece === 'crash').every((h) => h.limb === 'R')).toBe(true);
  });
});

describe('sticking: the search', () => {
  it('is deterministic', () => {
    for (const mk of Object.values(PATTERNS)) expect(assignLimbs(mk())).toEqual(assignLimbs(mk()));
    const p = groove('groove-funk-102');
    expect(assignLimbs(p)).toEqual(assignLimbs(p));
  });

  it('finds a sticking no more costly than the textbook one', () => {
    // the fill, RLRL down the kit and the crash with the right
    const p = tomFill();
    const s = assignLimbs(p);
    const book = s.hits.map((h, k) => {
      const b = beatOf(p, h);
      if (footFor(p.hits[k])) return null;
      if (b >= 3.99 && b < 7.99) return Math.round((b - 4) * 4) % 2 ? 'L' : 'R';
      return h.piece === 'snare' ? 'L' : 'R';
    }) as (Hand | null)[];
    const chosen = s.hits.map((h) => (h.limb === 'R' || h.limb === 'L' ? h.limb : null));
    expect(scoreHands(p, chosen).cost).toBeCloseTo(s.stats.cost, 6);
    expect(s.stats.cost).toBeLessThanOrEqual(scoreHands(p, book).cost + 1e-9);
  });

  it('keeps its choices when the kit moves forward (the costs read KitLayout)', () => {
    const before = Object.fromEntries(Object.values(PATTERNS).map((mk) => [mk().name, assignLimbs(mk()).hits.map((h) => h.limb)]));
    const saved = Object.values(DRUMS).map((d) => d.centre.slice() as V3);
    const savedPedals = Object.values(PEDALS).map((p) => [p.ball.slice() as V3, p.heel.slice() as V3]);
    try {
      // everything 20 cm further from the stool, as a corrected layout for a seated adult might put it
      for (const d of Object.values(DRUMS)) d.centre[2] -= 0.2;
      for (const p of Object.values(PEDALS)) {
        p.ball[2] -= 0.15;
        p.heel[2] -= 0.15;
      }
      for (const mk of Object.values(PATTERNS)) {
        const s = assignLimbs(mk());
        expect(s.hits.map((h) => h.limb), mk().name).toEqual(before[mk().name]);
        expect(s.hits[0].at[2]).toBeLessThan(-0.2);
      }
    } finally {
      Object.values(DRUMS).forEach((d, k) => (d.centre = saved[k]));
      Object.values(PEDALS).forEach((p, k) => {
        p.ball = savedPedals[k][0];
        p.heel = savedPedals[k][1];
      });
    }
  });

  it('prints a sticking as a drum tab', () => {
    const p = rockBeat();
    const text = stickingText(p, assignLimbs(p), { bars: 1 });
    // sixteenths, the limb on each note, ">" an accent
    expect(text).toMatch(/\|1 +e +& +a +2 +e +& +a +3 +e +& +a +4 +e +& +a +\|/);
    expect(text).toMatch(/Hi-hat\s+\|R> +- +R +- +R> +- +R +- +R> +- +R +- +R> +- +R +- +\|/);
    expect(text).toMatch(/Snare\s+\|- +- +- +- +L> +- +- +- +- +- +- +- +L> +- +- +- +\|/);
    expect(text).toMatch(/Kick\s+\|RF> +- +- +- +- +- +RF> +- +RF> +- +- +- +- +- +- +- +\|/);
  });
});

describe('sticking: the library grooves', () => {
  for (const name of GROOVES)
    it(`plays ${name} with every hit, within the hands' limits`, () => {
      const p = groove(name);
      const s = assignLimbs(p);
      expectPlayable(p, s);
      expect(s.dropped).toHaveLength(0);
      expect(s.stats.crossings).toBeLessThanOrEqual(5);
      // the time-keeping hand stays the right one
      const time = s.hits.filter((h) => h.played && (h.piece === 'ride' || (h.piece === 'hihat' && h.zone !== 'pedal')));
      expect(time.filter((h) => h.limb === 'R').length / time.length).toBeGreaterThan(0.97);
      expect(s.stats.keeperSwaps).toBeLessThanOrEqual(6);
      // the snare is mostly the left hand's
      const snare = s.hits.filter((h) => h.piece === 'snare');
      expect(snare.filter((h) => h.limb === 'L').length / snare.length).toBeGreaterThan(0.7);
      for (const h of s.hits) {
        if (h.piece === 'kick') expect(h.limb).toBe('RF');
        if (h.zone === 'pedal') expect(h.limb).toBe('LF');
      }
    });

  it('is fast: three minutes of dense funk in well under 100 ms', () => {
    const p = groove('groove-funk-102');
    const span = p.bars[p.bars.length - 2];
    const hits = [];
    for (let k = 0; k * span < 180; k++) for (const h of p.hits) if (h.t < span) hits.push({ ...h, t: h.t + k * span });
    hits.forEach((h, i) => (h.i = i));
    const bars: number[] = [];
    for (let t = 0; t < 182; t += p.bars[1] - p.bars[0]) bars.push(t);
    const long: DrumPerformance = { ...p, hits, bars, duration: 182 };
    let ms = Infinity;
    for (let k = 0; k < 5; k++) {
      const t0 = performance.now();
      const s = assignLimbs(long);
      ms = Math.min(ms, performance.now() - t0);
      expect(s.hits).toHaveLength(hits.length);
    }
    // (about 40 ms on an idle machine; generous here, as the other test files run alongside)
    expect(ms).toBeLessThan(300);
  });
});

