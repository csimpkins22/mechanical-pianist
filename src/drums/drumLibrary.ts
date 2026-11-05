// The drum pieces in the library: real human performances from Google's
// Groove MIDI Dataset (Gillick, Roberts, Engel, Eck and Bamman, "Learning to
// Groove with Inverse Sequence Transformations", ICML 2019; CC BY 4.0),
// recorded by professional drummers on a Roland TD-11 electronic kit with its
// hi-hat pedal (CC4). The files are copied unchanged from
// groove-v1.0.0-midionly.zip; their licence is in src/music/drums/.
import rock from '../music/drums/groove-rock-87.mid?inline';
import funk from '../music/drums/groove-funk-102.mid?inline';
import jazz from '../music/drums/groove-jazz-93.mid?inline';

export interface DrumPieceInfo {
  id: string;
  title: string;
  artist: string;
  year?: string;
  blurb: string;
  data: string;
  /** where it came from, for the credits */
  source: string;
}

export const DRUM_PIECES: DrumPieceInfo[] = [
  {
    id: 'groove-rock',
    title: 'Rock, 87 bpm',
    artist: 'Groove MIDI Dataset · drummer 4',
    year: '2019',
    blurb: 'A heavy, laid-back rock groove: open hi-hat accents, ghost notes on the snare, fills around the toms into crashes.',
    data: rock,
    source: 'drummer4/session1/1_rock_87_beat_4-4.mid',
  },
  {
    id: 'groove-funk',
    title: 'Funk, 102 bpm',
    artist: 'Groove MIDI Dataset · drummer 7',
    year: '2019',
    blurb: 'Sixteenths on the hi-hat with barks of open hat, a busy snare full of ghost notes, short tom fills into the crash.',
    data: funk,
    source: 'drummer7/session1/12_funk_102_beat_4-4.mid',
  },
  {
    id: 'groove-jazz',
    title: 'Jazz, 93 bpm',
    artist: 'Groove MIDI Dataset · drummer 1',
    year: '2019',
    blurb: 'A swung ride pattern with the hi-hat foot on two and four, comping on the snare, feathered kick and the odd tom.',
    data: jazz,
    source: 'drummer1/session1/48_jazz_93_beat_4-4.mid',
  },
];
