# The Mechanical Pianist

A browser application that turns a MIDI piano performance into a close, cinematic, real-time film of two articulated robotic hands playing an old upright piano.

There are no falling notes or piano-roll bars. The application works out how a skilled pianist would play the piece (which hand, which finger, where the hand should be and when it should start moving), then animates the physical act: fingers that land on keys, push them down on the beat, hold them, ride them back up and travel to the next note.

The build has three layers, and each one only hands data to the next:

| Layer | Turns | Into |
|---|---|---|
| **Musical interpretation** (`src/interpretation`) | MIDI | notes → hand assignment → fingering |
| **Physical performance** (`src/performance`) | fingering | hand trajectories → joint poses → key contact |
| **Cinematic presentation** (`src/presentation`) | poses at time *t* | piano, hands, light, lens, camera |

The fingering is solved for the whole piece before anything is drawn, so the hands always know what comes next. Because the layers only share data, the robot, the piano or the camera language can be replaced without touching the interpretation.

## Run it

Needs Node 20+ (tested on 22).

```bash
npm install
npm run dev          # http://127.0.0.1:5174
npm run build        # static site in dist/ (open with `npm run preview`)
npm test             # interpretation + kinematics tests (vitest)
```

`npm run dev` and `npm run build` first copy the piano samples from `node_modules` into `public/samples` (they are not checked in). If they are missing the app falls back to a synthesized piano.

Open a `.mid` file with the folder button or by dropping it on the window. Files with several parts ask which tracks to perform; piano parts are preselected.

URL options for development: `?demo=nocturne|phrase|etudes`, `?t=12.5` (start time), `?camera=cinematic|overhead|macro`, `?quality=high|medium|low`, `?debug=1`, `?play=1`, `?ui=0` (no interface, for stills).

### Controls

| Action | Control |
|---|---|
| Play / pause | Space, or ▶ (sound starts on the first Play) |
| Scrub | drag the timeline (sound is silent while dragging and resumes where you let go) |
| Previous / next frame (1/30 s) | ← / → or the step buttons |
| Back / forward 1 s | Shift + ← / → |
| Start / end, restart | Home / End, ⏮ |
| Speed (0.25×–1.5×) | the speed menu, `[` / `]` |
| Cinematic / Overhead / Macro camera | 1 / 2 / 3, or the camera switch |
| Loop | L |
| Mute, volume | M, the volume slider |
| Fingering, look, debug drawer | A, or ⚙ |
| Kinematics overlay | D |

## The built-in pieces

**Nocturne for Mechanical Hands** (original, A minor, about 90 s) is written as data in `src/interpretation/demoPiece.ts` and rendered to a real Standard MIDI File at startup, so it goes through the same parser as your files. It has two tracks, tempo changes and sustain pedal:

1. a slow melody over a broken-chord left hand (it opens with the five-note phrase A–C–E–D–C),
2. flowing arpeggios handed from the left hand to the right,
3. a two-octave A harmonic minor scale up and down with thumb crossings,
4. rich two-handed chords, pedalled,
5. a two-octave leap in both hands,
6. the opening returns, and a quiet A major chord with a long release.

**Five-Note Phrase** is that opening on its own: the first visual milestone.

**Études for Mechanical Hands** strings the test passages together so each can be watched (and inspected with the debug overlay): a five-finger position in each hand, two-octave scales in both hands with thumb crossings, a trill, fast repeated notes, a tempo change into fast arpeggios in both hands, wide leaps from the bass to the top of the keyboard, interlocking hands in the same register, and pedalled two-handed chords.

## How it works

### Interpretation

* **`MidiEngine`** reads the file with `@tonejs/midi`, applies the tempo map, folds out-of-range notes by octaves, merges duplicate notes, makes sure a key is released before it is struck again, and extracts the sustain pedal (CC 64).
* **`HandAssignment`** is a beam search over onset groups. Each state knows where both hands are, what each is holding and when it last moved. Every split of a chord between the hands is scored for count (at most five fingers), span, travel speed, collisions, register and, when the file separates the hands into tracks, the track. Overrides are hard constraints.
* **`Fingering`** is a beam search per hand whose states remember the last key each finger played and whether it is still held. Transitions follow Parncutt et al. (1997) — comfortable and practical spans per finger pair, thumb passing, weak fingers, thumb and fifth on black keys — extended to chords, held notes and timing (legato vs. detached, fast vs. slow, chord-to-chord shifts). Distances are physical: E–F is as wide as C–D. Results it produces include standard scale fingerings (3 crossings in two octaves, after 3 or 4, finishing 3-4-5), 1-3-5 / 5-3-1 triads and 1-2-4-5 for wide four-note chords.
* **`PerformancePlanner`** combines both, then makes the result physically honest: a finger that is needed elsewhere lets go of its key in time, and a held key that is out of reach of the next notes is released early enough for the hand to travel (the pedal, when down, keeps it sounding).

Anything the modelled hands genuinely cannot do (more than five notes at once, spans beyond reach) is flagged and reported in the title card and the fingering drawer. The key of a note with no free finger is not animated, rather than moving under a hovering finger.

### Physical performance

* **`MotionPlanner`** samples each hand's wrist position, yaw, pitch and roll at 120 Hz for the whole piece. Every note pulls the wrist toward the place that puts its finger on its key, starting as early as the music allows. The pull is blurred with a zero-phase filter, so the hand starts moving before it must (anticipation), then projected back into what is reachable while keys are held, and re-smoothed. On top come black-key depth (a thumb on a black key brings the whole hand in and the long fingers play between the black keys), lifting between phrases, arcs over leaps, a small give of the wrist on chord attacks, roll toward the playing side of the hand and turning for thumb passages.
* **`HandIK`** is closed-form. For each finger, abduction turns its flexion plane to the target and a preferred distal angle fixes the DIP joint, so MCP and PIP follow from the two-link solution. The thumb's CMC is a ball joint: swing spreads it in the palm plane and twist turns its flexion plane until the target lies in it.
* **`HandPoser`** evaluates every fingertip target from that finger's notes (prepare, strike, hold, release, travel), then runs a few damped Gauss–Newton steps over wrist position, yaw, roll and pitch so the fingers on keys always reach them.
* **`KeyMechanics`**: a key starts moving when the fingertip lands (soft notes travel more slowly), bottoms out exactly at the note onset, stays down while held and springs back on release. Repeated notes restrike a half-risen key. Keys pivot on a balance rail rather than sliding.
* **`PerformanceTimeline.evaluate(t)`** returns keys, both hands' joints, finger phases, pedal and sounding notes for any *t*, as a pure function. After planning it checks every held key against the hand and re-plans where needed.

The robot's dimensions live in `src/core/hand_spec.json`, read by the Blender build, the IK and the fingering model alike. The keyboard layout in `src/core/keyboard.ts` is shared by the planner, the IK and the piano model.

### Presentation

* **Robot hands** are modelled in Blender by script (`tools/blender/build_hand.py`). Porcelain dorsal shells sit over a graphite inner frame. Seams show chrome tendon rods, and every joint is a chrome barrel hooded by the parent segment's shell. Cyan light marks the knuckles, middle joints, thumb base and wrist. The thumb has a ball-joint CMC, and the wrist is a segmented spine that shares the bend. Ambient occlusion and curvature are baked into vertex colours. The left hand is the right mirrored at runtime.
* **The piano case** (`tools/blender/build_piano.py`) is an older upright: key slip, scrolled cheek blocks on turned legs, a nameboard with gilt lettering over burgundy key felt, folded fallboard, music desk, panelled fronts, lid, brass sconces and pedals. The 88 keys are built in three.js from the shared layout: bevelled ivory with per-key tint, tapered ebony, each on its own pivot.
* **Materials** extend three's PBR shaders: lacquered walnut with procedural grain and edge wear, ivory with faint grain and yellowing, porcelain with clearcoat and cavity warmth, chrome and brushed steel. The hands reflect a cube capture of the keyboard. Contact shadows darken the keys under approaching fingertips.
* **Light**: low warm sun through a window on the bass side (4096² shadow map framed tightly on the keyboard), the window itself as an area light for long reflections, a cool fill, a camera-side soft key, a shaft of dusty light and drifting motes.
* **Post**: HDR with MSAA, a physical thin-lens depth of field (focal length in mm on a 36 mm sensor, f-stop, focus distance), restrained bloom, ACES with a gentle split-tone grade, vignette and grain seeded by *t*.
* **`CinematicCamera`** analyses the performance ahead of time into a slowly varying region of interest. It eases toward a register before the hands arrive, widens as they spread and drifts very slowly. Cinematic is the treble-end three-quarter view down the keyboard, Overhead looks over the player's shoulder, and Macro is low and close at the right hand's fingertips. Switching views blends over 1.8 s.

### Audio

`AudioEngine` uses the Salamander Grand Piano (three velocity layers, every minor third, pitch-shifted between). Brightness follows velocity, dampers follow the sustain pedal, and the top octaves are undamped. It adds quiet key-release noises and a small synthesized room. Notes are scheduled ahead against the master timeline. While sound plays, the picture reads its time from the audio clock, so they cannot drift. Seeking fades everything out and restarts the notes already sounding at the new time part-way through their samples, so nothing gets stuck. If samples cannot load, `synthPiano.ts` renders an additive, inharmonic, two-stage-decay piano instead.

## Determinism

Nothing is integrated frame to frame. Planning happens once, and every frame is evaluated from the absolute time *t*: keys, joints, camera, dust and film grain. `npm run test:determinism` (with `npm run dev` running) renders a set of probe times after visiting the timeline forward, backward and shuffled, with random jumps in between, and checks that the full state hash and the pixels are identical. They are.

## Tests

`npm test` covers:

* five-finger positions; two-octave scales up and down (right hand, thumb crossings in the right places); a left-hand scale; harmonic minor (thumb never on G♯); triads; trills (two alternating fingers); repeated notes; no finger ever holding two keys;
* hand assignment: melodies crossing middle C stay in one hand, bass and treble split, interleaved lines in overlapping registers keep their tracks, leaps stay in reach, impossible chords are detected and flagged, overrides are honoured;
* the demo round-trips through a real MIDI file with tempo changes and pedal, and plans with no approximations, deterministically; so do the Études;
* the exported robot hand's joints match the shared hand spec;
* IK reproduces the rest pose and reaches forward-kinematics targets exactly;
* every key is down exactly at its onset and up after release;
* every key that is going down or held down has its fingertip on it, within 2 mm, across the whole demo;
* the state at any *t* is identical whatever order times are visited in;
* scales, chords and leaps stay within reach.

Tools: `node tools/shot.cjs out.png "?t=12&ui=0"` for stills, `node tools/render-video.cjs out.mp4 "?demo=phrase" 0 9.6` for frame-exact video, both against the dev server.

## Rebuilding the 3D assets

```bash
pip install bpy==5.2.3      # Blender as a Python module
npm run assets              # writes public/assets/robot_hand.glb and piano_case.glb
```

Add `--preview out.png` to either script for a Cycles studio render. `tests/assets.test.ts` fails if the exported joints drift from `hand_spec.json`, so the model and the IK can never disagree. `tools/glb-to-json.cjs` converts a `.glb` into self-contained glTF JSON for hosts that do not serve binary glTF; the app tries the `.glb` first and otherwise decodes the JSON itself.

## Layout

```
src/
  core/            keyboard layout, hand spec + forward kinematics, types, math, seeded noise
  interpretation/  MidiEngine, HandAssignment, Fingering, PerformancePlanner, demoPiece
  performance/     MotionPlanner, HandIK, HandPoser, KeyMechanics, PerformanceTimeline
  presentation/    SceneRenderer, PianoModel, HandRig, Environment, materials, PostPipeline,
                   CinematicCamera, DebugOverlay, shaderPatch
  audio/           AudioEngine, synthPiano
  ui/              AppUI, styles
  app/App.ts       master clock, transport, re-planning on overrides
tools/             Blender builds, sample copy, screenshots, video, determinism test
tests/             vitest suites
```

## Credits

* Piano samples: [Salamander Grand Piano V3](https://archive.org/details/SalamanderGrandPianoV3) by Alexander Holm, CC BY 3.0, via `@audio-samples/piano-mp3-*`.
* [three.js](https://threejs.org), [@tonejs/midi](https://github.com/Tonejs/Midi).
* Fingering rules after R. Parncutt, J. A. Sloboda, E. F. Clarke, M. Raekallio and P. Desain, "An ergonomic model of keyboard fingering for melodic fragments", *Music Perception* 14 (1997).
* "Halloran & Vey" on the nameboard is an invented maker.
