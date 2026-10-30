// Data passed between the three layers. Interpretation produces a
// Performance; the physical layer turns it into trajectories; presentation
// only ever reads poses evaluated at a time t.

export type Hand = 'L' | 'R';
/** 1 = thumb, 2 = index, 3 = middle, 4 = ring, 5 = little */
export type Finger = 1 | 2 | 3 | 4 | 5;

/** A note as it comes out of the MIDI file, in seconds (tempo map applied). */
export interface ScoreNote {
  id: number;
  midi: number;
  start: number;
  end: number;
  velocity: number; // 0..1
  track: number;
}

export interface PedalEvent {
  time: number;
  down: boolean;
}

export interface TempoEvent {
  time: number;
  bpm: number;
}

export interface TrackInfo {
  index: number;
  name: string;
  instrument: string;
  noteCount: number;
  minMidi: number;
  maxMidi: number;
  isPiano: boolean;
  channel: number;
}

export interface Score {
  name: string;
  notes: ScoreNote[];
  pedal: PedalEvent[];
  tempos: TempoEvent[];
  tracks: TrackInfo[];
  /** tracks selected for performance (others are ignored) */
  selectedTracks: number[];
  duration: number;
  /** notes outside A0..C8 that were dropped or folded */
  outOfRange: number;
}

export type NoteFlag =
  | 'hand-override'
  | 'finger-override'
  | 'stretch' // wider than a comfortable span for this hand
  | 'unreachable' // beyond the modelled hand's reach: best-effort
  | 'finger-conflict' // finger had to leave a held key early
  | 'early-release' // the hand had to leave before the notated release (sound continues)
  | 'chord-overflow' // more simultaneous notes than fingers
  | 'track-hand';

/** A note after interpretation: who plays it and how. */
export interface PerformanceNote extends ScoreNote {
  hand: Hand;
  finger: Finger;
  /** time the finger lets go of the key; equals `end` unless a conflict forced an early lift */
  keyEnd: number;
  flags: NoteFlag[];
}

export interface Override {
  hand?: Hand;
  finger?: Finger;
}

export interface Performance {
  score: Score;
  notes: PerformanceNote[]; // sorted by start, then pitch
  /** notes per hand, sorted by start */
  byHand: Record<Hand, PerformanceNote[]>;
  overrides: Map<number, Override>;
  warnings: string[];
  stats: {
    approximated: number;
    stretched: number;
    planningMs: number;
  };
}
