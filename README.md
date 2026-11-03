![Robotic hands playing an upright piano](docs/images/mechanical-pianist-header.jpg)

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
npm run build        # static site in dist/, with the library's plans prepared (open with `npm run preview`)
npm test             # interpretation + kinematics tests (vitest)
```

The piano samples are checked in under `public/piano`. `npm run dev` and `npm run build` also copy the key-release noises from `node_modules` into `public/samples`, since those are not checked in. If the piano samples cannot load, the app falls back to a synthesized piano.

To use a different SoundFont 2 piano, run `python tools/sf2-to-samples.py <file.sf2> public/piano`. It needs numpy and ffmpeg.

Choose a piece from the **Library** (the button in the control bar, the title, or `O`). To perform your own `.mid` file, use **Open a MIDI file** there or drop the file anywhere on the window. Files with several parts ask which tracks to perform, with piano parts preselected. Your files are kept under "Your files" in this browser (IndexedDB), along with the parts you chose.

URL options for development: `?demo=<library id>` (for example `nocturne-op9-2`, `raindrop` or `nocturne`; see `src/app/library.ts`), `?t=12.5` (start time), `?camera=cinematic|follow|overhead|macro`, `?settings=default` (ignore saved settings), `?quality=high|medium|low`, `?debug=1`, `?play=1`, `?ui=0` (no interface, for stills).

### Publishing on GitHub Pages

`.github/workflows/pages.yml` builds the site (including the prepared library performances, cached between runs) and publishes it to GitHub Pages on every push to `main`. Once, in the repository's Settings → Pages, set **Source** to **GitHub Actions**. The site is then at `https://<user>.github.io/mechanical-pianist/`. Everything is relative to the page, so it works under any path.

### More music, kept out of the repository

The repository carries only music that can be shared freely. To build a version with more pieces, put MIDI files in `extra/music/` and describe them in `extra/library.json` (the folder is gitignored; `MP_EXTRA=<dir>` points elsewhere): an id, title, artist, year, group (`Songs`, `Classical` or `Original`), a one-line blurb and the file name for each, and optionally a `defaultPiece`. `npm run build` then plans them at build time like the rest and lists them in the library in their groups (`tools/extra-music.cjs`). Without the folder, nothing changes.

### Exporting a film

⚙ → **Export** renders the performance as an MP4: choose its shape (16:9, 2.39:1 scope, 1.85:1, 4:3, 1:1, 4:5 or 9:16 vertical), its size (1080p, 1440p or 4K on the long side), 24, 30 or 60 fps, and the whole piece or from the playhead. Every frame is drawn offline at its exact time at high quality, so a slower computer only takes longer, never drops a frame; the piano is rendered offline too (`AudioEngine.renderOffline`), with the same room, pedal halo and key noises. Both are encoded in the browser with WebCodecs (H.264 at a generous bitrate; AAC, or Opus where the browser has no AAC encoder) and muxed with `mp4-muxer` into a file streamed out as it is written (`app/VideoExport.ts`). The camera, style and look are the current ones; the interface is HTML over the canvas, so it never appears in the film, and the letterbox bars are left off because the frame itself has the chosen shape. In the published artifact the page offers the file through its `downloads` capability (the viewer confirms the save); elsewhere it is an ordinary download. `tools/render-video.cjs` renders a stretch to video from the command line instead (silent).

### Open the piano

⚙ → Camera → **Open the piano** (or **I**) takes the upper front panel off, with its music desk and candle sconces, and shows the action at work. It is built in three.js from the same keyboard layout as the keys (`presentation/ActionLayout.ts`, `presentation/PianoInterior.ts`), so every hammer stands behind its key and every string runs where its hammer strikes:

* a hammer per key, with a white felt head over a red underfelt and a mahogany moulding. The head has a rounded crown, worn flat with string grooves at the strike line, and tapers toward the string. It sits on a maple shank and a buckskin butt.
* a damper per key up to E6 (F6 and above have none, as in the sound), with felt on a wooden head and a wire running down beside the hammer.
* wippens on the key backs, and the flange, rest and damper rails on cast brackets.
* 236 strings: steel trichords in the treble and tenor, and copper-wound bichords and single strings in the bass, overstrung on a steep diagonal across the tenor.
* a gilded cast-iron plate with its pin field, struts, bolts and a hitch-pin rail; tuning pins with their coils of string, and hitch pins.
* the treble and bass bridges on a spruce soundboard.

The moving parts are pure functions of time from the same key strokes that move the keys (`performance/ActionMechanics.ts`), as deterministic as everything else:

* **Hammers** move as slow-motion footage of a real upright action shows them:
  * Each hammer eases out of the resting row and accelerates under the jack, covering most of its travel in the second half of the rise.
  * The jack trips a few millimetres short of the string (let-off), and the hammer flies the rest of the way on its own, slowing into the string.
  * It reaches the string exactly at the note onset and lingers there, for contact and felt compression, for about a fifth of the rise, without bouncing off.
  * It comes back about twice as fast as it rose and settles softly into the backcheck, a little over halfway back, with no jolt or overshoot. It then holds still while the key is down, and returns smoothly to its rail with the key.
  * A soft note rises more slowly, rebounds more gently and is caught a little higher than a loud one.
  * As in a real action, the hammers of a chord are never quite in unison. Each note has its own lost motion before the jack takes up, and its own small differences in linger, rebound and check. They all strike on their onsets but sit at different heights in between.
  * A repeated note strikes again from wherever the half-risen key left it.
* **Dampers:**
  * A damper lifts in the second half of its key's travel, falls back a moment after the key rises, and its felt gives a little as it lands.
  * The sustain pedal lifts every damper together on the damper lift rail, visible behind the damper wires. Each damper meets the rail at a slightly different point, and half-pedalling (the MIDI controller's in-between values) lifts them part of the way.
  * The dampers clear the strings, and the strings ring, once the pedal is half down, matching where the sound counts it as down.
* **Soft pedal** (CC67): it moves the hammer rest rail toward the strings, so every hammer rests, and starts its blow, a third of the way closer (`performance/Pedals.ts`). Satie's Gnossienne holds it throughout. The sound is unchanged.
* **Strings** (`performance/StringMechanics.ts`): each string swings by a physical amount, set by velocity and register. That is a few millimetres at mid-span for a bass string struck hard, a few tenths in the middle and hundredths at the top. It dies away in two stages, the quick prompt sound and then the long aftersound, slowly in the bass and quickly in the treble. Once its damper is back on the strings (the key risen past where it lifts the damper, and the pedal up), the swing dies within tens of milliseconds in the treble and a few hundred in the bass, rather than stopping dead. The undamped top strings and pedalled strings ring on. While the dampers are off, strings that share a partial with a sounding note (octaves, twelfths, fifths) pick up a faint sympathetic swing. The swing starts in the hammer's plane, toward the soundboard, and turns partly into the other polarisation over a few tenths of a second.

A string vibrates far faster than any frame rate, so a camera never sees a moving wire. It sees the envelope of the swing over the exposure, which is how the strings are drawn. Each string is a ribbon facing the camera, as wide as the wire plus the part of its swing seen across the line of sight, with the first mode's shape: widest at mid-span and pinched at the bridge and the top bearing. Every pixel takes the share of the exposure the wire covers it, so a swinging string becomes a translucent band, brightest at its edges where the wire lingers as it turns. The band holds exactly the wire's light, however wide it spreads. In practice only loud bass notes blur visibly, and mostly when seen from above or from the side. The same filter gives distant strings, thinner than a pixel, a steady faint line instead of a broken, flickering one. The normal across the ribbon is the round wire's, so light runs along each string in a bright streak; where a wire is only a pixel or two wide, its highlight broadens instead of depending on where the pixel falls.

Hammers, dampers and wippens are instanced, and keep their transforms from the start of the shutter for motion blur. The lighting, bounce, occlusion and reflections take the inside in, and its surfaces get less of the room's light the deeper they sit in the case. With the piano open, the cinematic director also cuts to four shots inside it:

* *The hammers*, a close-up above the leading hand;
* *Along the hammer line*;
* *Through the action*, looking out past the dampers and hammers to the hands;
* *The plate and the pins*, a crane down from the tuning pins to the hammers.

### Controls

| Action | Control |
|---|---|
| Play / pause | Space, or ▶ (sound starts on the first Play) |
| Scrub | drag the timeline (sound is silent while dragging and resumes where you let go) |
| Previous / next frame (1/30 s) | ← / → or the step buttons |
| Back / forward 1 s | Shift + ← / → |
| Start / end, restart | Home / End, ⏮ |
| Speed (0.25×–1.5×) | the speed menu, `[` / `]` |
| Cinematic / Follow / Overhead / Macro camera | 1 / 2 / 3 / 4, or the camera switch |
| Next / previous visual style | S / Shift + S |
| Loop | L |
| Mute, volume | M, the volume slider |
| Library: choose a piece or open a file | O, the Library button, or the title |
| Close the library, a dialog or the drawer | Esc |
| Settings drawer (fingering, light, camera, sound, debug) | A, or ⚙ |
| Kinematics overlay | D |
| Open the piano (upper panel off: hammers, dampers, strings) | I, or ⚙ → Camera |

## The library

The library is laid out like a concert programme, in groups, each in order of year. Satie's Gnossienne No. 1 plays first.

| Piece | Composer | |
|---|---|---|
| Nocturne in E♭ major, Op. 9 No. 2 | Frédéric Chopin | 1832 |
| Prelude in D♭ major, Op. 28 No. 15 “Raindrop” | Frédéric Chopin | 1839 |
| Gnossienne No. 1 | Erik Satie | 1890 |
| Maple Leaf Rag | Scott Joplin | 1899 |
| Nocturne for Mechanical Hands, Études, Five-Note Phrase | The Mechanical Pianist | |

The classical pieces are public-domain compositions, played from piano MIDI performances in `src/music/` that are inlined into the build (nothing is fetched). To add a piece, put its `.mid` in `src/music/` and an entry in `src/app/library.ts`; `tools/trim-midi.cjs` cuts stray notes or silence from the start of a file. Your own files can also be opened in the app at any time (they stay in your browser).

**Prepared at build time.** Interpreting a long piece takes a while: 10 to 40 seconds. So `npm run build` plans every library piece in advance (`tools/plan-library.cjs`, one process per core, about a minute) and ships the results in `public/plans/`, gzipped (1 to 2.5 MB each). A visitor downloads the finished performance, which opens in a fraction of a second. The plans are deterministic, so a prepared plan is exactly the one the browser would compute. Each carries the hash of the planner's source and a fingerprint of its MIDI file, and the app only uses a plan whose hash and fingerprint match its own code and file. A piece is re-planned at build time only when one of them changes (`npm run plans -- --force` redoes them all). The file format is in `src/app/planCodec.ts`.

**Planning in the browser.** Your own files, other parts, fingering overrides, and the dev server (whose code is usually newer than the last build's plans) are planned in a Web Worker (`src/app/planner.worker.ts`). The current piece keeps playing meanwhile, and progress shows under the title. The result is kept in this browser (IndexedDB), keyed by the file, the chosen parts, the overrides and the planner hash, so a piece opens at once the second time. Where workers are unavailable, planning falls back to the page itself.

### The original pieces

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
* **`Fingering`** is a beam search per hand whose states remember the last key each finger played and whether it is still held. Transitions follow Parncutt et al. (1997) — comfortable and practical spans per finger pair, thumb passing, weak fingers, thumb and fifth on black keys — extended to chords, held notes and timing (legato vs. detached, fast vs. slow, chord-to-chord shifts). Distances are physical: E–F is as wide as C–D. A hand spread near its limit between its outer fingers leaves the inner pairs less room. Fast repeated notes change finger down the hand (4-3-2-1); slow ones keep it.
* **`Patterns`** recognises familiar figures and hands their conventional fingerings (`Conventions.ts`) to the search as soft priors:
  * scale runs longer than a hand position, fitted to a major key or a white-key minor;
  * chromatic runs;
  * white-root arpeggios;
  * exact repeats of an earlier figure, nudged toward its first fingering.

  Priors add a cost when the search departs from them; they never force it, so a recognised fragment that fits under five fingers, or that collides with a held note, is still fingered sensibly. Recognised notes are labelled in the Fingering tab (scale, chrom., arp., motif).

  `node tools/fingering-report.cjs` writes an image comparing the engine with conventional fingering. It covers all 24 major scales over two octaves up and down, arpeggios, chords and repeated notes, and currently 98.8% of notes match. The remaining differences are turnaround variants at the top of a scale.
* **`app/plan.ts`** checks the interpretation against the physical hand. After motion planning, it scans the holds of chords and stretches at 30 Hz. If a fingertip cannot stay within 2 mm of its key, that exact hand shape is banned for that chord and the piece is planned again (at most twice). User overrides are never second-guessed.
* **`PerformancePlanner`** combines both, then makes the result physically honest: a finger that is needed elsewhere lets go of its key in time, and a held key that is out of reach of the next notes is released early enough for the hand to travel (the pedal, when down, keeps it sounding).

Anything the modelled hands genuinely cannot do (more than five notes at once, spans beyond reach) is flagged and reported in the title card and the fingering drawer. The key of a note with no free finger is not animated, rather than moving under a hovering finger.

### Physical performance

* **`MotionPlanner`** samples each hand's wrist position, yaw, pitch and roll at 120 Hz for the whole piece. Every note pulls the wrist toward the place that puts its finger on its key, starting as early as the music allows. The pull is blurred with a zero-phase filter, so the hand starts moving before it must (anticipation), then projected back into what is reachable while keys are held, and re-smoothed. On top come black-key depth (a thumb on a black key brings the whole hand in and the long fingers play between the black keys), lifting between phrases, arcs over leaps, a small give of the wrist on chord attacks, roll toward the playing side of the hand and turning for thumb passages.

  **Leaps:** where no key is held, the wrist follows a minimum-jerk path. Keys the hand cannot keep are let go early enough for the trip, allowing 0.08 s plus 0.7 s per metre. Onsets never move, and the sound still lasts the written note. Peak wrist speed stays under 2 m/s.

  **Repeated notes:** the earlier key lets go in time to rise most of the way before the re-strike, and the finger visibly lifts off.
* **`HandIK`** is closed-form. For each finger, abduction turns its flexion plane to the target and a preferred distal angle fixes the DIP joint, so MCP and PIP follow from the two-link solution. The thumb's CMC is a ball joint: swing spreads it in the palm plane and twist turns its flexion plane until the target lies in it.
* **`HandPoser`** evaluates every fingertip target from that finger's notes (prepare, strike, hold, release, travel), then runs a few damped Gauss–Newton steps over wrist position, yaw, roll and pitch so the fingers on keys always reach them.
* **`KeyMechanics`**: a key starts moving when the fingertip lands (soft notes travel more slowly), bottoms out exactly at the note onset, stays down while held and springs back on release. Repeated notes restrike a half-risen key. Keys pivot on a balance rail rather than sliding.
* **`PerformanceTimeline.evaluate(t)`** returns keys, both hands' joints, finger phases, pedal and sounding notes for any *t*, as a pure function. After planning it checks every held key against the hand and re-plans where needed.

The robot's dimensions live in `src/core/hand_spec.json`, read by the Blender build, the IK and the fingering model alike. The keyboard layout in `src/core/keyboard.ts` is shared by the planner, the IK and the piano model.

* **Hands playing close together.** The two hands are checked against each other as sets of capsules (each thumb and finger segment, three across the palm; `HandCollision.ts`). In practice they meet thumb to thumb, or a thumb against the other hand's index finger or palm, when both play in the same octave. Two things keep them apart, as a pianist's would. A free thumb tucks in and up under its palm when the other hand comes near (a little ahead of time, eased; a thumb that is playing or about to goes to its key as before). Where tucking is not enough, the hand already a little higher where they meet rides over the other, by the height it needs to clear (side by side that is more than their overlap) and a little further in toward the fallboard; the contact refinement then runs once more so the lifted hand still holds its keys. On the pieces it was measured on (songs from an earlier, larger library) this cut the time the hands spend inside each other by 50 to 90 percent; what remains is mostly both thumbs pressing neighbouring keys at once, which these thumbs, wider than a key, cannot do without touching.

### Presentation

* **Robot hands** are modelled in Blender by script (`tools/blender/build_hand.py`). Each finger segment is a smooth porcelain capsule between exposed chrome joint barrels, with cyan rings on the barrel ends at the knuckles and middle joints. Fingertips are long and rounded, with a pale matte pad underneath. One porcelain shell covers the back of the hand and carries a thin cyan circle. Iridescent glass on the thumb side and around the wrist shows lit mechanics behind it, and a chrome collar joins the hand to a plain porcelain forearm. The thumb has a ball-joint CMC, and the wrist is a segmented spine that shares the bend. Ambient occlusion and curvature are baked into vertex colours. The left hand is the right mirrored at runtime.
* **Sheet music** (`SheetMusic.ts`) is drawn procedurally onto canvases: aged paper, grand staves, notes, beams and slurs. An open score leans on the music desk, and loose pages lie on the floor toward the window.
* **The piano case** (`tools/blender/build_piano.py`) is an older upright: key slip, scrolled cheek blocks on turned legs, a nameboard with gilt lettering over burgundy key felt, folded fallboard, music desk, panelled fronts, lid, brass sconces and pedals. The 88 keys are built in three.js from the shared layout: bevelled ivory with per-key tint, tapered ebony, each on its own pivot.
* **Materials** extend three's PBR shaders: lacquered walnut with procedural grain and edge wear, ivory with faint grain and yellowing, porcelain with clearcoat and cavity warmth, chrome and brushed steel, matte fingertip pads, and thin iridescent glass that casts no shadow. The hands reflect a cube capture of the keyboard. Contact shadows darken the keys under approaching fingertips.
* **Light**:
  * **Sun**: low warm sun through a tall window on the bass side, with a 4096² shadow map framed tightly on the keyboard. The window's heavy glazing bars throw their shadows across the keys.
  * **Window and fill**: the window itself as an area light for long reflections, a cool fill and a camera-side soft key.
  * **Raking light** (optional): a hard source a few degrees above the keys, its own shadow map fitted to the keyboard each time its angle changes.
  * **Light shafts**: a volumetric pass in `PostPipeline`, raymarched at half resolution against the scene depth. The sun gets through only a few openings in drawn curtains, so it crosses the room as distinct beams. The sun's shadow map shades the air, so the hands cut shadows through the light. Dust hangs over the instrument, and motes drift and catch the light only inside the beams.
* **Post**:
  * HDR with MSAA.
  * A physical thin-lens depth of field (focal length in mm on a 36 mm sensor, f-stop, focus distance).
  * Restrained bloom and anamorphic streaks: the bright parts are smeared horizontally in three passes and tinted blue.
  * A grade with highlight roll-off, ACES, lift/gamma/gain, split toning, warm (or cool) blacks, faded blacks, selective colour (keep the cyan) and vignette.
  * Grain seeded by *t*, and letterbox bars.
* **Visual styles** (`VisualStyles.ts`) set the room's light and the grade together:
  * Golden hour
  * Noir (black and white, hard low light)
  * Noir, cyan (only the joint lights keep their colour)
  * Moonlight
  * Faded film
  * Studio

  Every slider still applies after choosing one.
* **`CinematicCamera`** analyses the performance ahead of time into slowly varying curves: a region of interest, phrase peaks (attack density weighted by loudness) and which hand leads. That hand is chosen decisively, with a minimum hold, the way a focus puller commits. There are four modes:
  * **Cinematic** is the director (`ShotDirector.ts`): nineteen designed camera moves cut together at musical moments, described below.
  * **Follow** is one continuous treble-end three-quarter view down the keyboard.
  * **Overhead** looks over the player's shoulder.
  * **Macro** is low and close at the right hand's fingertips.

  Camera drama adds slow push-ins at phrase peaks, rack focus between the hands and longer lenses to the continuous modes. Switching modes blends over 1.8 s; cuts within Cinematic are hard cuts.
* **`ShotDirector`** edits the piece like a concert film.
  * **Cutting:** every onset is a candidate cut, scored for attack strength, a breath before it, a bar line and a new bass note. A cut in the middle of a fast run is penalised. Dynamic programming chooses cuts that aim for shots of 6–9 s in calm passages and 3–5 s as the music builds. Each cut falls 50 ms before an attack, so the new shot sees it land.
  * **Shot choice:** shots are assigned by film grammar. The edit opens low along the keys into the light (from the treble end, the hands backlit by the window, a slow push-in with the keys falling into soft focus) and ends on a pull-back reveal. It alternates wide, medium, close and detail, never repeats a recent shot, and gives close-ups to the leading hand.
  * **The shots:**
    * along the keys, into the light (the opening)
    * establishing (a crane down from above the player)
    * crane up
    * into the light
    * overhead turning
    * down the keys from the bass and from the treble
    * Dutch angle
    * handheld
    * orbit
    * over the shoulder
    * low from the key slip
    * slider along the keys
    * macro
    * the back of the hand
    * waiting on a key (locked off on the key of the strongest coming note)
    * from the music desk
    * slow push-in
    * pull-back reveal
  * **Tracking:** each shot's subject is pre-tracked, so the camera follows the hands smoothly instead of chasing them. Close shots stop down to keep the fingers sharp.
  * **Forearms:** the robots are only forearms, so their ends are never shown. Wide shots look down from above the arms, in front of where they end. Every camera mode, including any framing or drama setting, also passes through a guard. It projects both forearm ends for the actual screen shape, landscape or portrait. If an end could be in frame, it tightens the lens, or failing that turns away. A test scans every mode at five aspect ratios across both demos. As a further safeguard, the last few centimetres of each forearm fade into darkness.
  * **Determinism:** the edit is computed once, so the camera is still a pure function of *t*.
* **Settings** are remembered in the browser (`app/settings.ts`). Each tab of the drawer has its own reset.

### Audio

`AudioEngine` plays FreePats' Upright Piano KW, a Kawai upright recorded in a living room. It has two velocity layers, crossfaded by velocity, with a sample every two or three semitones and the notes in between pitch-shifted. `tools/sf2-to-samples.py` converts the SoundFont into one stereo MP3 per sample. Because the SoundFont normalises every sample, the converter evens out levels along the keyboard and sets the two layers 6 dB apart. It also unrolls the sustain loops in the bass and middle into decaying tails, since MP3 padding would make runtime loops click. Brightness follows velocity, dampers follow the sustain pedal, and the top octaves are undamped. It adds quiet key-release noises and a small synthesized room. While the sustain pedal is down, a little more of the sound goes to the room, a stand-in for the halo of undamped strings ringing in sympathy. Notes are scheduled ahead against the master timeline. While sound plays, the picture reads its time from the audio clock, so they cannot drift. While playing, each frame is drawn for the moment it will reach the screen (about one frame after it is drawn, longer when frames are heavy), since the audio clock already allows for the sound's own output delay; ⚙ → Sound → Picture sync corrects for devices that misreport their delay, such as Bluetooth headphones. Seeking fades everything out and restarts the notes already sounding at the new time part-way through their samples, so nothing gets stuck. If samples cannot load, `synthPiano.ts` renders an additive, inharmonic, two-stage-decay piano instead.

### Realism

* **Motion blur.** Each frame also poses the performance and camera as the shutter opened (a 180° shutter at 24 fps by default, adjustable under ⚙ → Camera), so every key and hand part knows its own motion. A prepass draws per-pixel motion, depth and normals; the blur follows McGuire et al.'s reconstruction filter (largest motion per tile and neighbourhood, then a depth-aware gather), so a moving finger smears over what lies behind it. Cuts are never blurred across, slow motion blurs less, and a paused frame keeps its blur.
* **Live reflections in the lacquer.** The vertical lacquer behind the keys reflects the keys and the moving hands: the scene is drawn mirrored in that plane each frame (an oblique near plane keeps everything behind the board out) and the clear coat reflects that image, spread by the coat's own roughness, in place of the static environment there.
* **Bounced light.** The room as it is lit is captured at three heights in front of the piano (by the floor, at the keys, above them), with the hands left out, and reduced to spherical-harmonic irradiance. Every surface takes the light bounced off its surroundings by height, in place of most of the flat sky/ground fill: warm from the floor and the sunlit keys, darker under the keybed. Captures are redone whenever the lights change and each includes the previous bounce, so two bounces are in by the time the piece starts. The exposure stops down a touch to keep the room's level.
* **Contact shadows.** Ambient occlusion from the prepass depth and normals darkens where surfaces crowd each other: between the fingers, under the hands on the keys, in the gaps between keys.
* **Wear, kept slight.** Each key sits a fraction of a millimetre differently (height, side, turn, tilt: well under the fingertip tolerance), the ivory is a touch more polished and warmer where it is played most, with a trace of grime where keys meet. The lacquer carries a few fingerprints and smudges within reach of the hands, and fine dust on what faces up; these change only the coat's gloss, so they show in its highlights and reflections. The robot shells have a few small scuffs and hairline scratches, seams between the forearm's panels and a printed maker's label (mirrored correctly on the left hand).

Motion blur, the lacquer reflections and the contact shadows need medium or high quality; each can be switched off under ⚙. Phones and tablets start at medium.

### Small signs of life

* A released key rises on its spring, arrives at rest still moving a little, and bounces about 3% of its dip (a quarter of a millimetre) on the back-rail felt before settling, all within 0.25 s (`KeyMechanics.ts`).
* Each finger's cyan servo rings flare briefly when it strikes, in proportion to the velocity, and fade over a quarter of a second. The emblem and wrist rings follow the hand's hardest-working finger, a third as much (`PerformanceTimeline.effort`, `HandRig.setGlow`).
* Thin clouds pass over the sun: the window light, its shafts and the lit dust breathe by about a tenth over tens of seconds (`Environment.update`).
* The fingers, wrists and camera drift very slightly even at rest, and the camera breathes.
* Mechanical give: the arm's joints are stiff, not rigid. The wrist follows its planned path through a light spring and damper (7 Hz, damping 0.42), driven only by the path's acceleration, so steady motion is untouched; where a fast leap stops, the hand carries on a couple of millimetres and settles within about 0.2 s (capped at 2.5 mm and about a degree, which the fingers' IK absorbs at the keys; typically well under half a millimetre). A finger lifting off a key carries on about 5% past its hover height and settles back (`MotionPlanner.give`, `HandPoser`).

All of these are functions of the performance time, so a paused or scrubbed frame is still exact.

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
  interpretation/  MidiEngine, HandAssignment, Fingering, Patterns, Conventions, PerformancePlanner, demoPiece
  performance/     MotionPlanner, HandIK, HandPoser, KeyMechanics, ActionMechanics, StringMechanics, Pedals, PerformanceTimeline
  presentation/    SceneRenderer, PianoModel, PianoInterior, ActionLayout, HandRig, Environment, materials, PostPipeline,
                   CinematicCamera, DebugOverlay, shaderPatch
  audio/           AudioEngine, synthPiano
  ui/              AppUI, LibrarySheet, dom helpers, styles
  app/             App (master clock, transport, pieces), library, planner + planner.worker (worker + cache),
                   planCodec (prepared plan files), plan (IK-checked planning), settings
  music/           the bundled MIDI performances
tools/             Blender builds, SoundFont conversion, library plans, MIDI trimming, sample copy, screenshots, video,
                   determinism test
tests/             vitest suites
```

## Credits

* Piano: [Upright Piano KW](http://freepats.zenvoid.org/Piano/acoustic-grand-piano.html#UprightKW) from the FreePats project, recorded by Gonzalo and Roberto from Inma Martínez de Miguel's Kawai upright, CC0.
* Key-release noises: [Salamander Grand Piano V3](https://archive.org/details/SalamanderGrandPianoV3) by Alexander Holm, CC BY 3.0, via `@audio-samples/piano-mp3-release`.
* [three.js](https://threejs.org), [@tonejs/midi](https://github.com/Tonejs/Midi), [mp4-muxer](https://github.com/Vanilagy/mp4-muxer).
* The classical pieces are public-domain compositions, played from MIDI performances.
* Fingering rules after R. Parncutt, J. A. Sloboda, E. F. Clarke, M. Raekallio and P. Desain, "An ergonomic model of keyboard fingering for melodic fragments", *Music Perception* 14 (1997).
* "Halloran & Vey" on the nameboard and "Vey Automata" on the robot's label are invented makers.
