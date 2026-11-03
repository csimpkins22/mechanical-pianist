// Optional extra pieces from extra/library.json (see tools/extra-music.cjs)
declare module 'virtual:extra-music' {
  const extra: {
    defaultPiece: string | null;
    pieces: { id: string; title: string; artist: string; year?: string; group: 'Original' | 'Classical' | 'Songs'; blurb: string; data: string }[];
  };
  export default extra;
}
