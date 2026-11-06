// The drum pieces in the library: real human performances from Google's
// Groove MIDI Dataset (Gillick, Roberts, Engel, Eck and Bamman, "Learning to
// Groove with Inverse Sequence Transformations", ICML 2019; CC BY 4.0),
// recorded by professional drummers on a Roland TD-11 electronic kit with its
// hi-hat pedal (CC4). The files are copied unchanged from
// groove-v1.0.0-midionly.zip (each entry's `source` is its path there); their
// licence is in src/music/drums/. The library lists them by family of styles,
// in this order.
import rock from '../music/drums/groove-rock-87.mid?inline';
import rock135 from '../music/drums/groove-rock-135.mid?inline';
import rock68 from '../music/drums/groove-rock-6-8-80.mid?inline';
import pop from '../music/drums/groove-pop-132.mid?inline';
import country from '../music/drums/groove-country-114.mid?inline';
import funk from '../music/drums/groove-funk-102.mid?inline';
import soul from '../music/drums/groove-soul-105.mid?inline';
import hiphop from '../music/drums/groove-hiphop-87.mid?inline';
import secondline from '../music/drums/groove-secondline-124.mid?inline';
import shuffle from '../music/drums/groove-shuffle-104.mid?inline';
import jazz from '../music/drums/groove-jazz-93.mid?inline';
import jazz158 from '../music/drums/groove-jazz-158.mid?inline';
import samba from '../music/drums/groove-samba-93.mid?inline';
import reggae from '../music/drums/groove-reggae-78.mid?inline';
import afrobeat from '../music/drums/groove-afrobeat-103.mid?inline';
import highlife from '../music/drums/groove-highlife-126.mid?inline';

export interface DrumPieceInfo {
  id: string;
  title: string;
  artist: string;
  year?: string;
  blurb: string;
  data: string;
  /** where it came from, for the credits */
  source: string;
  /** its family of styles: the library's heading for it */
  family: string;
}

const ROCK = 'Rock, pop and country';
const FUNK = 'Funk, soul and hip-hop';
const NEW_ORLEANS = 'New Orleans';
const JAZZ = 'Jazz';
const LATIN = 'Latin and Caribbean';
const AFRICA = 'West African';

export const DRUM_PIECES: DrumPieceInfo[] = [
  {
    id: 'groove-rock',
    title: 'Rock, 87 bpm',
    artist: 'Groove MIDI Dataset · drummer 4',
    year: '2019',
    blurb: 'A heavy, laid-back rock groove: open hi-hat accents, ghost notes on the snare, fills around the toms into crashes.',
    data: rock,
    source: 'drummer4/session1/1_rock_87_beat_4-4.mid',
    family: ROCK,
  },
  {
    id: 'groove-rock-135',
    title: 'Rock, 135 bpm',
    artist: 'Groove MIDI Dataset · drummer 7',
    year: '2019',
    blurb: 'Fast and driving: eighths on the hi-hat with open accents, ghost notes around the backbeat, a syncopated kick and a crash every four bars.',
    data: rock135,
    source: 'drummer7/session2/45_rock_135_beat_4-4.mid',
    family: ROCK,
  },
  {
    id: 'groove-rock-6-8',
    title: 'Rock in 6/8, 80 bpm',
    artist: 'Groove MIDI Dataset · drummer 6',
    year: '2019',
    blurb: 'Two big beats to the bar: the ride on every eighth, now and then on its bell, the kick and snare repeating a lilting figure on each beat, with rimshots and the odd cross-stick.',
    data: rock68,
    source: 'drummer6/session1/4_rock_80_beat_6-8.mid',
    family: ROCK,
  },
  {
    id: 'groove-pop',
    title: 'Pop, 132 bpm',
    artist: 'Groove MIDI Dataset · drummer 7',
    year: '2019',
    blurb: 'Bright and pushing: eighths on the hi-hat with open accents, the backbeat cracked as rimshots among ghost notes, a syncopated kick, one bar of floor tom on the beat and a few crashes.',
    data: pop,
    source: 'drummer7/session2/103_pop_132_beat_4-4.mid',
    family: ROCK,
  },
  {
    id: 'groove-country',
    title: 'Country, 114 bpm',
    artist: 'Groove MIDI Dataset · drummer 1',
    year: '2019',
    blurb: 'A train beat: both hands run sixteenths on the snare over the kick on every beat and the hi-hat foot on the off-beats; midway, for a while, the ride and then the hi-hat take the time and the snare cracks on the off-beats.',
    data: country,
    source: 'drummer1/session2/10_country_114_beat_4-4.mid',
    family: ROCK,
  },
  {
    id: 'groove-funk',
    title: 'Funk, 102 bpm',
    artist: 'Groove MIDI Dataset · drummer 7',
    year: '2019',
    blurb: 'Sixteenths on the hi-hat with barks of open hat, a busy snare full of ghost notes, short tom fills into the crash.',
    data: funk,
    source: 'drummer7/session1/12_funk_102_beat_4-4.mid',
    family: FUNK,
  },
  {
    id: 'groove-soul',
    title: 'Soul, 105 bpm',
    artist: 'Groove MIDI Dataset · drummer 8',
    year: '2019',
    blurb: 'A plain, deep backbeat: eighths on the closed hi-hat, the snare hard on two and four, the kick on one and the and of three with a pickup into the next bar.',
    data: soul,
    source: 'drummer8/eval_session/9_soul-groove9_105_beat_4-4.mid',
    family: FUNK,
  },
  {
    id: 'groove-hiphop',
    title: 'Hip-hop, 87 bpm',
    artist: 'Groove MIDI Dataset · drummer 7',
    year: '2019',
    blurb: 'Sixteenths on the hi-hat, accent and ghost in turn, a snare backbeat with rimshots and the odd ghost note, and a busy, syncopated kick. No fills, no crash: just the beat.',
    data: hiphop,
    source: 'drummer7/eval_session/6_hiphop-groove6_87_beat_4-4.mid',
    family: FUNK,
  },
  {
    id: 'groove-secondline',
    title: 'Second line, 124 bpm',
    artist: 'Groove MIDI Dataset · drummer 5',
    year: '2019',
    blurb: 'A parade beat on the snare alone: both hands in sixteenths, ghost notes, buzzed doubles and flams, the accents cracked as rimshots and rim clicks, over the bass drum and the hi-hat foot on every beat. No cymbals.',
    data: secondline,
    source: 'drummer5/session2/7_neworleans-secondline_124_beat_4-4.mid',
    family: NEW_ORLEANS,
  },
  {
    id: 'groove-shuffle',
    title: 'New Orleans shuffle, 104 bpm',
    artist: 'Groove MIDI Dataset · drummer 5',
    year: '2019',
    blurb: 'Both hands on the snare in a shuffling stream of ghost notes with accents and rimshots, the bass drum soft beneath, the hi-hat foot keeping time, a tom or two answering every other bar.',
    data: shuffle,
    source: 'drummer5/session2/9_neworleans-shuffle_104_beat_4-4.mid',
    family: NEW_ORLEANS,
  },
  {
    id: 'groove-jazz',
    title: 'Jazz, 93 bpm',
    artist: 'Groove MIDI Dataset · drummer 1',
    year: '2019',
    blurb: 'A swung ride pattern with the hi-hat foot on two and four, comping on the snare, feathered kick and the odd tom.',
    data: jazz,
    source: 'drummer1/session1/48_jazz_93_beat_4-4.mid',
    family: JAZZ,
  },
  {
    id: 'groove-jazz-158',
    title: 'Jazz, 158 bpm',
    artist: 'Groove MIDI Dataset · drummer 4',
    year: '2019',
    blurb: 'Up-tempo, the time on an open hi-hat struck on every beat, the kick on the beats beneath it, the snare comping and kicking accents from both hands, crashes thrown in.',
    data: jazz158,
    source: 'drummer4/session1/2_jazz_158_beat_4-4.mid',
    family: JAZZ,
  },
  {
    id: 'groove-samba',
    title: 'Samba, 93 bpm',
    artist: 'Groove MIDI Dataset · drummer 5',
    year: '2019',
    blurb: "Samba on the kit: the right hand's pattern on the ride's bell and bow, the kick playing the surdo's beat with its pickups, the hi-hat foot on the off-beats, the left hand answering on the toms, their rims and the snare.",
    data: samba,
    source: 'drummer5/session2/18_latin-brazilian-samba_93_beat_4-4.mid',
    family: LATIN,
  },
  {
    id: 'groove-reggae',
    title: 'Reggae, 78 bpm',
    artist: 'Groove MIDI Dataset · drummer 1',
    year: '2019',
    blurb: 'A one-drop: the kick and a cross-stick land together on two and four, the hi-hat in eighths and sixteenths with open accents, a few ghost notes on the snare and short fills on the high tom.',
    data: reggae,
    source: 'drummer1/session1/184_reggae_78_beat_4-4.mid',
    family: LATIN,
  },
  {
    id: 'groove-afrobeat',
    title: 'Afrobeat, 103 bpm',
    artist: 'Groove MIDI Dataset · drummer 8',
    year: '2019',
    blurb: 'A hi-hat line full of open barks over a busy, syncopated kick, the snare cracking rimshots among its ghost notes, the hi-hat foot working, and short fills on the high tom.',
    data: afrobeat,
    source: 'drummer8/session2/14_afrobeat_103_beat_4-4.mid',
    family: AFRICA,
  },
  {
    id: 'groove-highlife',
    title: 'Highlife, 126 bpm',
    artist: 'Groove MIDI Dataset · drummer 8',
    year: '2019',
    blurb: "Highlife's bell pattern on the ride, the kick on every beat and the hi-hat foot on every off-beat; the snare chatters between in ghost notes and rimshots, with short fills on the toms.",
    data: highlife,
    source: 'drummer8/session2/42_highlife_126_beat_4-4.mid',
    family: AFRICA,
  },
];
