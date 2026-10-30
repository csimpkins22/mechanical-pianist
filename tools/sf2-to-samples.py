"""
Converts a SoundFont 2 piano into the sample set the app plays: one stereo MP3
per recorded note and velocity layer, plus public/piano/manifest.json.

    python tools/sf2-to-samples.py UprightPianoKW-20220221.sf2 public/piano

Needs numpy and ffmpeg. Written for stereo multisample pianos like FreePats'
"Upright Piano KW" (left/right zones panned hard apart, a few velocity layers):

* left and right zones become one stereo file;
* each sample is levelled: the soundfont normalises every sample on its own,
  so loudness jumps from note to note and the soft layer is as loud as the
  hard one. Levels are smoothed along the keyboard and the layers are set a
  fixed distance apart, which the player then scales with velocity;
* where a sample ends in a sustain loop (bass and middle), the loop is
  unrolled into a few seconds of naturally decaying tail, since MP3 encoder
  padding makes sample-accurate runtime loops unreliable;
* the end gets a short fade and silence before the attack is trimmed.
"""

import json
import os
import struct
import subprocess
import sys
import tempfile

import numpy as np

SR_OUT = 44100
LAYER_DB = (-25.0, -19.0)  # level of the softest and loudest layer, first 0.4 s RMS (headroom for peaks)
MAKEUP = 1.8  # the player's gain back up to its usual level
TAIL_MAX = 6.0  # seconds of tail grown from a sustain loop
NAMES = ["C", "Cs", "D", "Ds", "E", "F", "Fs", "G", "Gs", "A", "As", "B"]


def chunks(b, off, end):
    while off < end:
        cid = b[off:off + 4]
        sz = struct.unpack("<I", b[off + 4:off + 8])[0]
        yield cid, off + 8, sz
        off += 8 + sz + (sz & 1)


def read_sf2(path):
    d = open(path, "rb").read()
    assert d[:4] == b"RIFF" and d[8:12] == b"sfbk", "not a SoundFont 2 file"
    sub = {}
    for _, o, sz in chunks(d, 12, len(d)):
        for c2, o2, s2 in chunks(d, o + 4, o + sz):
            sub[c2.decode()] = (o2, s2)

    def recs(name, fmt):
        o, s = sub[name]
        n = struct.calcsize(fmt)
        return [struct.unpack(fmt, d[o + i * n:o + (i + 1) * n]) for i in range(s // n)]

    o, s = sub["smpl"]
    pcm = np.frombuffer(d[o:o + s], dtype="<i2").astype(np.float32) / 32768.0
    info = {k: d[sub[k][0]:sub[k][0] + sub[k][1]].split(b"\0")[0].decode("latin1") for k in ("INAM", "ICMT") if k in sub}
    inst = recs("inst", "<20sH")
    ibag = recs("ibag", "<HH")
    igen = recs("igen", "<HH")
    shdr = recs("shdr", "<20sIIIIIBbHH")
    zones = []
    glob = {}
    # the first instrument only (a single-preset piano)
    for zi in range(inst[0][1], inst[1][1]):
        z = {}
        for op, amt in igen[ibag[zi][0]:ibag[zi + 1][0]]:
            if op in (43, 44):
                z[op] = (amt & 0xFF, amt >> 8)
            else:
                z[op] = struct.unpack("<h", struct.pack("<H", amt))[0] if op != 53 else amt
        if 53 not in z:
            glob = z
            continue
        zones.append({**glob, **z})
    return pcm, shdr, zones, info


def rms_db(x):
    m = x.mean(axis=0) if x.ndim == 2 else x
    return 20 * np.log10(np.sqrt((m ** 2).mean()) + 1e-12)


def note_name(m):
    return f"{NAMES[m % 12]}{m // 12 - 1}"


def main():
    sf2, out = sys.argv[1], sys.argv[2]
    pcm, shdr, zones, info = read_sf2(sf2)
    release = 2 ** (zones[0].get(38, -12000) / 1200) if zones else 0.5

    # pair left/right zones that share a key and velocity range
    groups = {}
    for z in zones:
        key = (z[43], z.get(44, (0, 127)))
        groups.setdefault(key, []).append(z)
    vels = sorted({k[1] for k in groups})
    notes = []
    for (krange, vrange), zs in groups.items():
        zs.sort(key=lambda z: z.get(17, 0))  # pan: left first
        chans = []
        for z in zs[:2]:
            name, st, en, ls, le, sr, pitch, corr, link, typ = shdr[z[53]]
            assert sr == SR_OUT, f"unexpected sample rate {sr}"
            root = z.get(58, pitch) if z.get(58, -1) >= 0 else pitch
            cents = corr + z.get(52, 0) + 100 * z.get(51, 0)
            # a tail loop, whether or not this zone enables it (the hard layer leaves them off)
            loop = (ls - st, le - st) if le > ls else None
            chans.append((pcm[st:en].copy(), root, cents, loop, name.split(b"\0")[0].decode()))
        if len(chans) == 1:
            chans.append(chans[0])
        n = min(len(chans[0][0]), len(chans[1][0]))
        x = np.stack([chans[0][0][:n], chans[1][0][:n]])
        notes.append({"layer": vels.index(vrange), "root": chans[0][1], "cents": chans[0][2], "x": x,
                      "loop": chans[0][3], "keys": krange})

    # trim silence before the attack
    for nt in notes:
        x = nt["x"]
        a = np.abs(x).max(axis=0)
        on = int(np.argmax(a > 0.02 * a.max()))
        cut = max(0, on - int(0.001 * SR_OUT))
        nt["x"] = x[:, cut:]
        if nt["loop"]:
            nt["loop"] = (nt["loop"][0] - cut, nt["loop"][1] - cut)

    # unroll sustain loops into a decaying tail
    for nt in notes:
        lp = nt["loop"]
        x = nt["x"]
        if not lp or lp[0] < int(0.3 * SR_OUT) or lp[1] - lp[0] < int(0.2 * SR_OUT):
            continue
        ls, le = lp
        seg = x[:, ls:le]
        # how fast the note was decaying just before the loop
        w = int(0.5 * SR_OUT)
        early = rms_db(x[:, max(0, ls - 4 * w):ls - 3 * w])
        late = rms_db(x[:, ls - w:ls])
        rate = max(1.5, min(8.0, (early - late) / 1.5))  # dB per second
        reps = int(np.ceil(TAIL_MAX * SR_OUT / seg.shape[1]))
        tail = np.tile(seg, (1, reps))[:, :int(TAIL_MAX * SR_OUT)]
        t = np.arange(tail.shape[1]) / SR_OUT
        # the loop itself does not decay: continue the decay through it and on
        t_loop = np.arange(seg.shape[1]) / SR_OUT
        body = x[:, :ls]
        looped = seg * 10 ** (-rate * t_loop / 20)
        tail = tail * 10 ** (-rate * (t + t_loop[-1]) / 20)
        nt["x"] = np.concatenate([body, looped, tail], axis=1)
        nt["tail_rate"] = rate

    # level: smooth along the keyboard within each layer, then place the layers
    for li in range(len(vels)):
        lay = sorted((nt for nt in notes if nt["layer"] == li), key=lambda nt: nt["root"])
        meas = np.array([rms_db(nt["x"][:, :int(0.4 * SR_OUT)]) for nt in lay])
        k = 3
        smooth = np.array([np.median(meas[max(0, i - k):i + k + 1]) for i in range(len(meas))])
        smooth = smooth - np.median(smooth)
        for nt, m, s in zip(lay, meas, smooth):
            target = LAYER_DB[0] + (LAYER_DB[1] - LAYER_DB[0]) * (li / max(1, len(vels) - 1)) + np.clip(s, -6, 3)
            nt["gain_db"] = float(target - m)

    os.makedirs(out, exist_ok=True)
    layers = []
    with tempfile.TemporaryDirectory() as tmp:
        for li, vr in enumerate(vels):
            ldir = f"v{li + 1}"
            os.makedirs(os.path.join(out, ldir), exist_ok=True)
            lay = sorted((nt for nt in notes if nt["layer"] == li), key=lambda nt: nt["root"])
            entries = []
            for nt in lay:
                x = nt["x"] * 10 ** (nt["gain_db"] / 20)
                f = int(0.02 * SR_OUT)
                x[:, -f:] *= np.linspace(1, 0, f)
                peak = np.abs(x).max()
                if peak > 0.98:
                    x *= 0.98 / peak
                    nt["gain_db"] += 20 * np.log10(0.98 / peak)
                wav = os.path.join(tmp, "n.f32")
                x.T.astype("<f4").tofile(wav)
                fname = f"{note_name(nt['root'])}.mp3"
                subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR_OUT), "-ac", "2", "-i", wav,
                                "-c:a", "libmp3lame", "-q:a", "5", os.path.join(out, ldir, fname)], check=True)
                entries.append({"root": nt["root"], "file": f"{ldir}/{fname}", "cents": nt["cents"],
                                "keys": list(nt["keys"]), "seconds": round(x.shape[1] / SR_OUT, 2)})
                print(f"{ldir} {note_name(nt['root']):4s} {x.shape[1] / SR_OUT:5.1f}s  gain {nt['gain_db']:+5.1f} dB"
                      + (f"  tail {nt['tail_rate']:.1f} dB/s" if "tail_rate" in nt else ""))
            # the layer's centre velocity (0..1), used for crossfading between layers
            layers.append({"velocity": [vr[0] / 127, vr[1] / 127], "centre": round((vr[0] + vr[1]) / 2 / 127, 3),
                           "samples": entries})
    manifest = {"name": info.get("INAM", os.path.basename(sf2)), "source": info.get("ICMT", ""),
                "release": round(release, 3), "gain": MAKEUP, "layers": layers}
    with open(os.path.join(out, "manifest.json"), "w") as fh:
        json.dump(manifest, fh, indent=1)
    total = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(out) for f in fs)
    print(f"{sum(len(l['samples']) for l in layers)} samples in {len(layers)} layers, {total / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
