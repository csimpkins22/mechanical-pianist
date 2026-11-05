"""
The robot drummer's proportions: the single source of truth for its joints,
written to src/drums/drummer_spec.json by build_drummer.py (or on its own with
`python tools/blender/build_drummer.py --spec-only`) and read by the runtime
(src/drums/DrummerSpec.ts) and the Blender build alike.

Model frame (three.js axes, metres): origin on the top of the stool's seat at
its centre; +x to the drummer's right, +y up, -z forward. The rig places this
origin on KitLayout's SEAT, so the model never copies the kit's numbers.

Rest pose: every joint's local rotation is the identity, which is a seated
pose: thighs forward and level, shins down, feet flat, upper arms hanging,
forearms forward and level, hands palm down along the forearms. Each node's
offset is in its parent's frame (which, at rest, is the world's).

Proportions follow an adult of about 1.76 m (Drillis and Contini's segment
fractions, adjusted for joint centres): seated, the shoulder joints sit 0.55 m
above the seat, so 1.0-1.05 m above the floor once the drummer leans in a
little. The hands are the existing robot hand (src/core/hand_spec.json).
"""

import json
import math
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
HAND = json.load(open(os.path.join(ROOT, "src", "core", "hand_spec.json")))


def kit_constant(name):
    """A numeric object literal from src/drums/KitLayout.ts (read, never copied)."""
    src = open(os.path.join(ROOT, "src", "drums", "KitLayout.ts")).read()
    m = re.search(r"export const " + name + r"\b[^=]*=\s*\{([^;]*)\};", src)
    if not m:
        raise RuntimeError(f"KitLayout.ts has no {name}")
    body = m.group(1)
    out = {}
    for k, v in re.findall(r"(\w+):\s*(\[[^\]]*\]|[-\d.e]+)", body):
        out[k] = json.loads(v)
    return out


# ----------------------------------------------------------------- segment lengths
UPPER_ARM = 0.290      # shoulder (glenohumeral centre) to elbow
FOREARM = 0.255        # elbow to the wrist pivot
TWIST_AT = 0.115       # the forearm's roll joint, this far from the elbow
THIGH = 0.420          # hip joint to knee
SHIN = 0.420           # knee to ankle
ANKLE_H = 0.078        # ankle above the sole
BALL = (0.0, -0.058, -0.150)   # the toe joint (MTP), from the ankle
TOE = 0.062            # toe joint to the tip of the toe cap
HEEL = (0.0, -ANKLE_H, 0.040)  # the heel's contact on the sole, from the ankle
HIP_HALF = 0.090       # half the distance between the hip joints
HIP_UP = 0.085         # hip joints above the seat
SIT_Z = 0.075          # hip joints behind the seat's centre (the drummer sits a little back: see the report)

# spine: hip-joint midpoint -> lumbar -> lower thorax -> chest -> neck base -> head pivot
SPINE1 = (0.0, 0.075, 0.055)
SPINE2 = (0.0, 0.130, 0.0)
CHEST = (0.0, 0.130, -0.005)
NECK = (0.0, 0.200, 0.005)
HEAD = (0.0, 0.100, -0.012)
# sternoclavicular joint (from the chest), then the shoulder joint (from it)
CLAVICLE = (0.028, 0.120, -0.120)
SHOULDER = (0.158, 0.012, 0.075)

# ----------------------------------------------------------------- the grip (right hand's canonical frame)
# Matched (American) grip: the stick lies between the pad of the thumb and the
# middle phalanx of the index finger a third of the way up from its butt (the
# fulcrum), runs diagonally under the palm and leaves under the heel of the hand
# on the little-finger side. The back fingers wrap it loosely and rock it about
# the fulcrum (about the line between thumb and index finger).
STICK = kit_constant("STICK")
FULCRUM_FROM_BUTT = STICK["length"] / 3


def _unit(v):
    n = math.sqrt(sum(c * c for c in v))
    return [c / n for c in v]


GRIP_FULCRUM = [-0.030, -0.052, -0.135]
# 48 degrees off the hand's axis toward the thumb, a little down toward the tip. The fulcrum is at the index
# finger's first-to-second joint, 4 cm in front of its knuckle, with the thumb's pad opposite; the stick lies in
# the curl of the other fingers and its butt leaves under the little finger's side (reference footage: the butt
# shows 3-5 cm past the hand). Fitted with the hand's own IK so the index, middle and thumb close on the stick
# and the ring and little fingers wrap it loosely.
GRIP_DIR = _unit([-math.sin(math.radians(48)), -0.06, -math.cos(math.radians(48))])   # butt -> tip
# the rock axis: perpendicular to the stick, roughly across the fulcrum from thumb to index
_up = [0.0, 1.0, 0.0]
_ax = [GRIP_DIR[1] * _up[2] - GRIP_DIR[2] * _up[1], GRIP_DIR[2] * _up[0] - GRIP_DIR[0] * _up[2],
       GRIP_DIR[0] * _up[1] - GRIP_DIR[1] * _up[0]]
GRIP_ROCK_AXIS = _unit(_ax)

D = math.radians


def joint(name, parent, offset, kind, dofs, side=None):
    j = {"name": name, "parent": parent, "offset": [round(c, 6) for c in offset], "kind": kind,
         "dofs": [{"name": n, "limits": [round(lo, 4), round(hi, 4)]} for n, lo, hi in dofs]}
    if side:
        j["side"] = side
    return j


def mirror(v):
    return (-v[0], v[1], v[2])


def build_spec():
    joints = [
        joint("Pelvis", None, (0.0, HIP_UP, SIT_Z), "euler_yxz",
              [("yaw", D(-12), D(12)), ("pitch", D(-14), D(10)), ("roll", D(-8), D(8))]),
        joint("Spine1", "Pelvis", SPINE1, "euler_yxz", [("yaw", D(-10), D(10)), ("pitch", D(-20), D(12)), ("roll", D(-12), D(12))]),
        joint("Spine2", "Spine1", SPINE2, "euler_yxz", [("yaw", D(-18), D(18)), ("pitch", D(-18), D(10)), ("roll", D(-12), D(12))]),
        joint("Chest", "Spine2", CHEST, "euler_yxz", [("yaw", D(-22), D(22)), ("pitch", D(-14), D(10)), ("roll", D(-10), D(10))]),
        joint("Neck", "Chest", NECK, "euler_yxz", [("yaw", D(-35), D(35)), ("pitch", D(-25), D(30)), ("roll", D(-12), D(12))]),
        joint("Head", "Neck", HEAD, "euler_yxz", [("yaw", D(-35), D(35)), ("pitch", D(-25), D(25)), ("roll", D(-12), D(12))]),
    ]
    for s, sg in (("R", 1), ("L", -1)):
        m = (lambda v: v) if sg > 0 else mirror
        joints += [
            # elevation (about z: the shoulder rises) and protraction (about y: it comes forward)
            joint(f"Clavicle{s}", "Chest", m(CLAVICLE), "clavicle", [("elevation", D(-8), D(22)), ("protraction", D(-12), D(26))], s),
            # swing of the arm (flexion forward, abduction outward) and its rotation about its own axis
            joint(f"UpperArm{s}", f"Clavicle{s}", m(SHOULDER), "shoulder",
                  [("flexion", D(-55), D(120)), ("abduction", D(-35), D(95)), ("rotation", D(-75), D(80))], s),
            joint(f"Forearm{s}", f"UpperArm{s}", (0.0, -UPPER_ARM, 0.0), "elbow", [("flexion", D(15), D(150))], s),
            # supination from palm down (positive turns the thumb up)
            joint(f"ForearmTwist{s}", f"Forearm{s}", (0.0, 0.0, -TWIST_AT), "twist", [("supination", D(-15), D(120))], s),
            joint(f"Hand{s}", f"ForearmTwist{s}", (0.0, 0.0, -(FOREARM - TWIST_AT)), "fixed", [], s),
            # wrist: flexion toward the palm (negative = extension, the back of the hand up), deviation toward the thumb
            joint(f"{s}_Palm", f"Hand{s}", (0.0, 0.0, 0.0), "wrist", [("flexion", D(-70), D(70)), ("deviation", D(-35), D(22))], s),
            # the stick rocks in the grip about the fulcrum (positive lifts the tip: the back fingers open)
            joint(f"Stick{s}", f"{s}_Palm", m(GRIP_FULCRUM), "stick", [("rock", D(-12), D(22))], s),
            joint(f"Thigh{s}", "Pelvis", m((HIP_HALF, 0.0, 0.0)), "hip",
                  [("flexion", D(-25), D(70)), ("abduction", D(-20), D(45)), ("rotation", D(-40), D(40))], s),
            # knee flexion from straight (90 degrees at rest)
            # knee flexion from straight (90 degrees at rest), and the shin's turn about its own axis (a flexed knee
            # rotates 30-40 degrees, which lets the knee splay out round a drum with the foot still on its pedal)
            joint(f"Shin{s}", f"Thigh{s}", (0.0, 0.0, -THIGH), "knee", [("flexion", D(10), D(140)), ("rotation", D(-32), D(32))], s),
            joint(f"Foot{s}", f"Shin{s}", (0.0, -SHIN, 0.0), "ankle",
                  [("plantar", D(-32), D(48)), ("inversion", D(-15), D(20)), ("abduction", D(-22), D(22))], s),
            joint(f"Toes{s}", f"Foot{s}", m(BALL), "toes", [("dorsiflexion", D(-5), D(55))], s),
        ]
    # the hand's own nodes (built from hand_spec.json) hang off {s}_Palm; their offsets are tested with the hand's spec
    spec = {
        "about": __doc__.strip().split("\n\n")[0] + " See tools/blender/drummer_spec.py.",
        "frame": "model frame: origin on the seat top's centre; three.js axes, metres, radians; +x right, +y up, -z forward. "
                 "Every joint's rest rotation is the identity. Left joints mirror the right (x -> -x); their local "
                 "rotations are the mirror images M R M of the right's, so joint angles mean the same on both sides.",
        "joints": joints,
        "segments": {"upperArm": UPPER_ARM, "forearm": FOREARM, "twistAt": TWIST_AT, "thigh": THIGH, "shin": SHIN},
        "foot": {"ankleHeight": ANKLE_H, "ball": list(BALL), "heel": list(HEEL), "toe": TOE,
                 "soleWidth": 0.092, "soleLength": 0.27},
        "seat": {"hipUp": HIP_UP, "sitZ": SIT_Z, "hipHalf": HIP_HALF},
        "grip": {
            "fulcrum": GRIP_FULCRUM,
            "direction": [round(c, 6) for c in GRIP_DIR],
            "rockAxis": [round(c, 6) for c in GRIP_ROCK_AXIS],
            "fulcrumFromButt": round(FULCRUM_FROM_BUTT, 6),
        },
        # the stick's shoulder (where the taper to the tip begins), from the tip: crashes are struck with it
        "stick": dict(STICK, shoulderFromTip=0.052, taper=0.062),
        # capsules for clearance checks (radius about each segment's axis), metres
        "capsules": {"upperArm": 0.050, "forearm": 0.040, "hand": 0.045, "thigh": 0.072, "shin": 0.052, "torso": 0.115,
                     "head": 0.105},
        "hand": {"spec": "src/core/hand_spec.json", "prefix": {"R": "R_", "L": "L_"}},
    }
    return spec


def write_spec(path=None):
    path = path or os.path.join(ROOT, "src", "drums", "drummer_spec.json")
    spec = build_spec()
    with open(path, "w") as f:
        json.dump(spec, f, indent=2)
        f.write("\n")
    return spec


if __name__ == "__main__":
    write_spec()
    print("wrote src/drums/drummer_spec.json")
