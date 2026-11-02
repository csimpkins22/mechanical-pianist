// The library: the pieces that come with the app. Originals are composed in
// code (demoPiece.ts); the others are MIDI performances bundled into the app
// itself (inlined at build time, so nothing has to be fetched).
import { composeEtudes, composeNocturne, composePhrase, midiBytes } from '../interpretation/demoPiece';
import nocturneOp9 from '../music/chopin-nocturne-op9-2.mid?inline';
import raindrop from '../music/chopin-raindrop-prelude.mid?inline';
import gnossienne from '../music/satie-gnossienne-1.mid?inline';
import mapleLeaf from '../music/joplin-maple-leaf-rag.mid?inline';

export type LibraryGroup = 'Original' | 'Classical' | 'Songs';

export interface LibraryEntry {
  id: string;
  title: string;
  artist: string;
  year?: string;
  group: LibraryGroup;
  blurb: string;
  bytes(): Uint8Array;
}

function fromDataUrl(url: string): () => Uint8Array {
  let cache: Uint8Array | null = null;
  return () => {
    if (cache) return cache;
    const b64 = url.slice(url.indexOf(',') + 1);
    const raw = atob(b64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return (cache = out);
  };
}

/** in programme order: classical, then originals; each by year */
export const LIBRARY: LibraryEntry[] = [
  {
    id: 'nocturne-op9-2',
    title: 'Nocturne in E♭ major, Op. 9 No. 2',
    artist: 'Frédéric Chopin',
    year: '1832',
    group: 'Classical',
    blurb: 'The best known of the nocturnes: an ornamented, singing melody over a rocking 12/8 accompaniment.',
    bytes: fromDataUrl(nocturneOp9),
  },
  {
    id: 'raindrop',
    title: 'Prelude in D♭ major, Op. 28 No. 15 “Raindrop”',
    artist: 'Frédéric Chopin',
    year: '1839',
    group: 'Classical',
    blurb: 'The repeated A♭ falls through the whole prelude, darkening into C♯ minor and back.',
    bytes: fromDataUrl(raindrop),
  },
  {
    id: 'gnossienne',
    title: 'Gnossienne No. 1',
    artist: 'Erik Satie',
    year: '1890',
    group: 'Classical',
    blurb: 'Without bar lines, marked to be played “very lost”, over a slow, swaying bass.',
    bytes: fromDataUrl(gnossienne),
  },
  {
    id: 'maple-leaf-rag',
    title: 'Maple Leaf Rag',
    artist: 'Scott Joplin',
    year: '1899',
    group: 'Classical',
    blurb: 'The rag that made ragtime famous: syncopated right-hand figures over a striding left hand.',
    bytes: fromDataUrl(mapleLeaf),
  },
  {
    id: 'nocturne',
    title: 'Nocturne for Mechanical Hands',
    artist: 'The Mechanical Pianist',
    group: 'Original',
    blurb: 'Written for these hands: a slow melody over broken chords, a restless middle, a return.',
    bytes: () => midiBytes(composeNocturne()),
  },
  {
    id: 'etudes',
    title: 'Études',
    artist: 'The Mechanical Pianist',
    group: 'Original',
    blurb: 'Scales, arpeggios, chords, leaps and repeated notes: the passages the fingering is tested on.',
    bytes: () => midiBytes(composeEtudes()),
  },
  {
    id: 'phrase',
    title: 'Five-Note Phrase',
    artist: 'The Mechanical Pianist',
    group: 'Original',
    blurb: 'A, C, E, D, C. The first thing the hands ever played.',
    bytes: () => midiBytes(composePhrase()),
  },
];

/** what plays first */
export const DEFAULT_PIECE = 'nocturne-op9-2';

export const entryById = (id: string) => LIBRARY.find((e) => e.id === id);
