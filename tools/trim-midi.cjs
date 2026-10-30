// Trim the start of a MIDI file: drop everything before a time, then move
// the rest earlier so the first remaining note lands after a short lead-in.
// Controller state (the sustain pedal) and tempo in force at the cut carry
// over to the new start.
//
//   node tools/trim-midi.cjs in.mid out.mid <from seconds> [lead-in seconds = 0.75]
//
// "from" 0 keeps every note and only shortens leading silence.
const { Midi } = require('@tonejs/midi');
const fs = require('fs');

const [input, output, fromArg, leadArg] = process.argv.slice(2);
if (!input || !output || fromArg === undefined) {
  console.error('usage: node tools/trim-midi.cjs in.mid out.mid <from seconds> [lead-in seconds]');
  process.exit(1);
}
const midi = new Midi(fs.readFileSync(input));
const from = midi.header.secondsToTicks(parseFloat(fromArg));
const lead = parseFloat(leadArg ?? '0.75');

const kept = midi.tracks.flatMap((t) => t.notes.filter((n) => n.ticks >= from));
if (!kept.length) throw new Error('no notes after the cut');
const first = Math.min(...kept.map((n) => n.ticks));
// the tempo at the first kept note decides how many ticks the lead-in takes
const tempoAt = (tick) => [...midi.header.tempos].reverse().find((t) => t.ticks <= tick)?.bpm ?? 120;
const leadTicks = Math.round((lead * tempoAt(first) * midi.header.ppq) / 60);
const shift = Math.max(0, first - leadTicks);

let dropped = 0;
for (const t of midi.tracks) {
  const before = t.notes.length;
  const notes = t.notes.filter((n) => n.ticks >= from).map((n) => n.toJSON());
  dropped += before - notes.length;
  t.notes.length = 0;
  for (const n of notes) t.addNote({ midi: n.midi, ticks: n.ticks - shift, durationTicks: n.durationTicks, velocity: n.velocity });
  for (const [num, list] of Object.entries(t.controlChanges)) {
    const prior = list.filter((c) => c.ticks < shift);
    const rest = list.filter((c) => c.ticks >= shift).map((c) => ({ number: c.number, ticks: c.ticks - shift, value: c.value }));
    list.length = 0;
    const state = prior[prior.length - 1];
    if (state && state.value > 0 && !rest.some((c) => c.ticks === 0)) t.addCC({ number: +num, ticks: 0, value: state.value });
    for (const c of rest) t.addCC(c);
  }
}
const tempos = midi.header.tempos;
const startBpm = tempoAt(shift);
midi.header.tempos = [{ ticks: 0, bpm: startBpm }, ...tempos.filter((t) => t.ticks > shift).map((t) => ({ ticks: t.ticks - shift, bpm: t.bpm }))];
midi.header.timeSignatures = midi.header.timeSignatures.filter((s) => s.ticks <= shift).slice(-1).map((s) => ({ ...s, ticks: 0 })).concat(
  midi.header.timeSignatures.filter((s) => s.ticks > shift).map((s) => ({ ...s, ticks: s.ticks - shift })),
);
midi.header.update();
fs.writeFileSync(output, Buffer.from(midi.toArray()));
console.log(`${input} → ${output}: dropped ${dropped} note(s) before ${fromArg} s, moved the rest ${midi.header.ticksToSeconds(shift).toFixed(2)} s earlier`);
