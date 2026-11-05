#!/usr/bin/env python3
"""
Convert Karoryfer's Big Rusty Drums (CC0, an SFZ library) into the drum
kit's samples: one stereo MP3 per hit, mixed from the library's close and
overhead microphones, with a manifest for src/drums/DrumAudio.ts.

    python tools/drum-samples.py <big-rusty-drums checkout> public/drums
    python tools/drum-samples.py --paths     (the source files it reads, one per line)

The library is at https://github.com/sfzinstruments/karoryfer.big-rusty-drums
(a shallow, blobless clone and `git checkout HEAD -- $(python tools/drum-samples.py --paths)`
fetches only what is needed). Needs numpy and ffmpeg.

For every articulation it takes a spread of the recorded velocity layers and
two or three round-robin alternates of each. The microphones are mixed as the
library's own "basic" program mixes them (close mics panned to where each drum
sits, seen from the stool; the overheads as recorded), the start trimmed to a
millisecond and a half before the attack, the tail cut where it has died away
(cymbals fade over their last second). One gain is applied to the whole kit,
so the recorded balance between drums and between velocity layers is kept.

Every sample's attack time is measured here and written to the manifest; the
app measures it again in the decoded audio and starts each sample that much
later, so the MP3 encoder's padding never delays a hit.
"""
import json
import os
import subprocess
import sys

SR = 44100

# (id, source folder, file prefix, velocity layers taken, round robins, max length s, mics)
# mics: (folder, gain, pan or None for stereo as recorded); pan -1 = left .. 1 = right, seen from the stool
HAT_MICS = [("cl", 0.8, -0.45), ("oh", 0.8, None)]
CYM = lambda pan: [("cl", 0.4, pan), ("oh", 1.0, None)]
TOM = lambda pan: [("cl", 1.0, pan), ("oh", 0.6, None)]
SPEC = [
    ("kick", "kick_24/kick", "k", [2, 5, 8, 11, 14], 3, 1.5, [("kick", 1.0, 0.05), ("oh", 0.35, None)]),
    ("snare", "snare_14/center", "sn_center", [1, 3, 5, 7, 9, 10], 3, 1.5, [("top", 0.85, -0.15), ("btm", 0.45, -0.15), ("oh", 0.6, None)]),
    ("rimshot", "snare_14/rimshot", "sn_rims", [2, 4, 6], 3, 1.5, [("top", 0.85, -0.15), ("btm", 0.45, -0.15), ("oh", 0.6, None)]),
    ("crossStick", "snare_14/sidestick", "sn_ss", [1, 2, 3, 4], 2, 0.7, [("top", 0.85, -0.15), ("btm", 0.3, -0.15), ("oh", 0.6, None)]),
    ("tom1", "tom_14/center", "t14", [1, 3, 5, 6], 3, 2.2, TOM(-0.1)),
    ("tom2", "tom_15/center", "t15", [1, 3, 5, 7], 3, 2.4, TOM(0.2)),
    ("floorTom", "tom_18/center", "t18", [1, 3, 5, 8], 3, 2.8, TOM(0.55)),
    # the hi-hat from tight (the pedal pressed hard) to fully open
    ("hhTight", "hihat_14/tc", "ht_tc", [2, 4, 6, 8], 3, 0.45, HAT_MICS),
    ("hhClosed", "hihat_14/cl", "ht_cl", [1, 3, 5, 6], 3, 0.7, HAT_MICS),
    ("hhLoose", "hihat_14/lc", "ht_lc", [1, 3, 5, 6], 2, 1.2, HAT_MICS),
    ("hhQuarter", "hihat_14/qo", "ht_qo", [1, 2, 3, 4], 2, 1.8, HAT_MICS),
    ("hhHalf", "hihat_14/ho", "ht_ho", [1, 2, 3, 4], 2, 2.6, HAT_MICS),
    ("hhOpen", "hihat_14/open", "ht_open", [1, 3, 5, 6], 2, 3.4, HAT_MICS),
    ("hhEdge", "hihat_14/cl_s", "ht_cl_s", [1, 2, 3, 4], 2, 0.8, HAT_MICS),
    ("hhPedal", "hihat_14/chik", "ht_chik", [1, 3, 5], 3, 0.5, HAT_MICS),
    ("hhSplash", "hihat_14/footspl", "ht_footspl", [1, 2, 3, 4], 2, 2.0, HAT_MICS),
    ("crash", "crash_17/cr", "cr", [1, 2, 3, 4, 5], 2, 4.5, CYM(-0.6)),
    ("crashChoke", "crash_17/choke", "cr_choke", [None], 3, 0.9, CYM(-0.6)),
    ("ride", "ride_22/rd", "rd", [1, 3, 5, 7, 9, 10], 2, 4.5, CYM(0.65)),
    ("rideBell", "ride_22/bl", "rd_bl", [1, 2, 3, 4], 2, 4.0, CYM(0.65)),
    ("rideEdge", "ride_22/ed", "rd_ed", [1, 2, 3, 4], 2, 4.5, CYM(0.65)),
    ("rideChoke", "ride_22/choke", "rd_ed_choke", [None], 2, 0.9, CYM(0.65)),
]
# how many velocity layers each source records (for the layers' nominal velocities)
RECORDED = {"kick": 14, "snare": 10, "rimshot": 6, "crossStick": 4, "tom1": 6, "tom2": 7, "floorTom": 8, "hhTight": 8, "hhClosed": 6,
            "hhLoose": 6, "hhQuarter": 4, "hhHalf": 4, "hhOpen": 6, "hhEdge": 4, "hhPedal": 5, "hhSplash": 4, "crash": 5, "ride": 10,
            "rideBell": 4, "rideEdge": 4}


def src_path(folder, mic, prefix, vl, rr):
    name = f"{prefix}_rr{rr}.flac" if vl is None else f"{prefix}_vl{vl}_rr{rr}.flac"
    return f"Samples/{folder}/{mic}/{name}"


def sources():
    for aid, folder, prefix, vls, rrs, _, mics in SPEC:
        for vl in vls:
            for rr in range(1, rrs + 1):
                yield aid, vl, rr, [(src_path(folder, m, prefix, vl, rr), g, p) for m, g, p in mics]


def decode(path):
    import numpy as np
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-ar", str(SR), "-"], check=True, capture_output=True).stdout
    probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels", "-of", "csv=p=0", path],
                           check=True, capture_output=True, text=True).stdout.strip()
    ch = int(probe)
    x = np.frombuffer(raw, dtype=np.float32).reshape(-1, ch)
    return x


def mix(files, root):
    import numpy as np
    parts = []
    for path, gain, pan in files:
        x = decode(os.path.join(root, path))
        if pan is None or x.shape[1] == 2:
            st = x if x.shape[1] == 2 else np.repeat(x, 2, axis=1)
            if pan is not None and x.shape[1] == 2:
                st = st  # a stereo close mic stays as recorded
        else:
            th = (pan + 1) * np.pi / 4
            st = np.stack([x[:, 0] * np.cos(th), x[:, 0] * np.sin(th)], axis=1) * np.sqrt(2)
        parts.append(st * gain)
    n = max(p.shape[0] for p in parts)
    out = np.zeros((n, 2), dtype=np.float64)
    for p in parts:
        out[: p.shape[0]] += p
    return out


def attack(x):
    """the first sample at a tenth of the peak: the same measure as DrumAudio.attackOf"""
    import numpy as np
    a = np.abs(x).max(axis=1)
    pk = a.max()
    return int(np.argmax(a >= 0.1 * pk)) if pk > 0 else 0


def main():
    if sys.argv[1:2] == ["--paths"]:
        for _, _, _, files in sources():
            for p, _, _ in files:
                print(p)
        return
    import numpy as np
    root, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    clips = []
    for aid, vl, rr, files in sources():
        x = mix(files, root)
        maxlen = next(s[5] for s in SPEC if s[0] == aid)
        a0 = attack(x)
        start = max(0, a0 - int(0.0015 * SR))
        x = x[start:]
        # the tail: where the level (50 ms windows) has fallen 60 dB below the peak, or the longest allowed
        env = np.abs(x).max(axis=1)
        pk = env.max()
        win = int(0.05 * SR)
        n = len(env) // win
        lv = env[: n * win].reshape(n, win).max(axis=1)
        alive = np.nonzero(lv > pk * 10 ** (-60 / 20))[0]
        end = min(len(x), (alive[-1] + 2) * win if len(alive) else len(x), int(maxlen * SR))
        x = x[:end].copy()
        # fade the last part: cymbals over their last second, the rest over the last fifth
        fl = min(len(x) // 5 if maxlen < 3 else int(1.0 * SR), len(x))
        x[len(x) - fl:] *= np.cos(np.linspace(0, np.pi / 2, fl))[:, None] ** 2
        clips.append((aid, vl, rr, x))
        print(f"{aid} vl{vl} rr{rr}: {len(x) / SR:.2f}s", file=sys.stderr)
    peak = max(np.abs(c[3]).max() for c in clips)
    gain = 0.89 / peak
    man = {
        "name": "Big Rusty Drums",
        "source": "https://github.com/sfzinstruments/karoryfer.big-rusty-drums",
        "licence": "CC0 1.0 (Karoryfer Samples)",
        "sampleRate": SR,
        "articulations": {},
    }
    for aid, folder, prefix, vls, rrs, _, _ in SPEC:
        layers = []
        for vl in vls:
            files = []
            for rr in range(1, rrs + 1):
                x = next(c[3] for c in clips if c[0] == aid and c[1] == vl and c[2] == rr) * gain
                name = f"{aid}/{aid}-v{vl or 0}-{rr}.mp3"
                os.makedirs(os.path.join(out, aid), exist_ok=True)
                subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", "-",
                                "-c:a", "libmp3lame", "-q:a", "6", os.path.join(out, name)], input=x.astype(np.float32).tobytes(), check=True)
                rms = float(np.sqrt(np.mean(x[: int(0.1 * SR)] ** 2)))
                files.append({"file": name, "attack": round(attack(x) / SR, 5), "rms": round(rms, 5)})
            vel = 1.0 if vl is None else round((vl - 0.5) / RECORDED[aid], 3)
            layers.append({"velocity": vel, "files": files})
        man["articulations"][aid] = {"layers": layers}
    with open(os.path.join(out, "manifest.json"), "w") as f:
        json.dump(man, f, indent=1)
    with open(os.path.join(out, "README.txt"), "w") as f:
        f.write("Drum samples converted by tools/drum-samples.py from Big Rusty Drums by Karoryfer Samples\n"
                "(https://github.com/sfzinstruments/karoryfer.big-rusty-drums), released under CC0 1.0.\n")
    total = sum(os.path.getsize(os.path.join(dp, fn)) for dp, _, fns in os.walk(out) for fn in fns)
    print(f"{len(clips)} samples, {total / 1e6:.1f} MB", file=sys.stderr)


if __name__ == "__main__":
    main()
