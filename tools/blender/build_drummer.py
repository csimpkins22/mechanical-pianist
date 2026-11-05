"""
The Mechanical Pianist: scripted Blender build of the robot drummer.

    pip install bpy==5.2.3                     # Blender as a Python module
    python tools/blender/build_drummer.py public/assets/robot_drummer.glb [--preview out.png] [--pose pose.json]
    python tools/blender/build_drummer.py --spec-only        # just write src/drums/drummer_spec.json

The proportions live in drummer_spec.py; this script writes them to
src/drums/drummer_spec.json, which the IK and the rig read, and builds the
model on exactly those joints. Each articulated part is its own node with its
origin on the joint's pivot and an identity rest rotation (a seated pose:
thighs forward, shins down, upper arms hanging, forearms forward, hands palm
down). The left limbs are the right ones mirrored.

Design language: the robot hand's (tools/blender/build_hand.py), at the scale
of a body. Smooth porcelain shells over a graphite frame; exposed chrome joint
barrels with cyan rings on their pin caps; chrome ball joints ringed with
light at the hips and shoulders; iridescent glass panels over lit mechanics
(the abdomen, the sternum, the calves, the head's sensor band); a segmented
spine of chrome vertebrae; a maker's label on the back. The hands are the
robot hand itself, built by its own script. Two hickory sticks (from
KitLayout's STICK) sit in the hands' grip. Ambient occlusion and curvature are
baked into vertex colours.

Node hierarchy (three.js names; L mirrors R):
    Drummer (on the seat) > Pelvis > Spine1 > Spine2 > Chest > Neck > Head
      Chest > ClavicleR > UpperArmR > ForearmR > ForearmTwistR > HandR
                HandR > R_WristCore, R_WristRing1/2, R_Palm > R_F2_0.., R_T_0.., StickR
      Pelvis > ThighR > ShinR > FootR > ToesR
"""

import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import drummer_spec as DS  # noqa: E402

ARGS = sys.argv[1:]
if "--spec-only" in ARGS:
    DS.write_spec()
    print("wrote src/drums/drummer_spec.json")
    sys.exit(0)

import bpy  # noqa: E402
import bmesh  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

import common  # noqa: E402
from common import (MB, TAU, V, bake_masks, cyl_x, cyl_z, lathe, lerp, mesh_objects, node, rot_x, rot_y,  # noqa: E402
                    rot_z, scene, set_pose, smooth01, sphere, superellipse, to_blender, torus_z, tr, tri_count, tube,
                    mat_to_blender)

# the body is seen whole, so its shells need fewer rows than the hand's (DETAIL scales them); the hands are the
# robot hand's own meshes, thinned to HAND_DETAIL of their triangles
DETAIL = float(os.environ.get("DETAIL", "0.7"))
HAND_DETAIL = float(os.environ.get("HAND_DETAIL", "0.6"))


def pill(mb, mat, z0, z1, w, h, nu=28, nv=36, **kw):
    common.pill(mb, mat, z0, z1, w, h, nu=max(4, round(nu * DETAIL)), nv=max(8, round(nv * DETAIL)), **kw)

ROOT = DS.ROOT
OUT = next((a for a in ARGS if a.endswith(".glb")), os.path.join(ROOT, "public", "assets", "robot_drummer.glb"))
PREVIEW = ARGS[ARGS.index("--preview") + 1] if "--preview" in ARGS else None
POSE = ARGS[ARGS.index("--pose") + 1] if "--pose" in ARGS else None
if "--check-torso" in ARGS:
    os.environ.setdefault("NO_BAKE", "1")

SPEC = DS.write_spec()
JS = {j["name"]: j for j in SPEC["joints"]}
HAND = DS.HAND
STICK = SPEC["stick"]
GRIP = SPEC["grip"]

common.MATS.setdefault("hickory", ((0.74, 0.55, 0.36), 0.0, 0.45, None))
common.MATS.setdefault("label", ((0.17, 0.17, 0.18), 0.0, 0.5, None))


def off(name):
    return V(*JS[name]["offset"])


# -----------------------------------------------------------------------------
# The robot hand's own builder (build_hand.py without its final main() call)
# -----------------------------------------------------------------------------
def load_hand_builder():
    path = os.path.join(HERE, "build_hand.py")
    src = open(path).read()
    cut = src.rfind("\nmain()")
    ns = {"__file__": path, "__name__": "build_hand_lib"}
    exec(compile(src[:cut], path, "exec"), ns)
    return ns


HB = load_hand_builder()


# -----------------------------------------------------------------------------
# Shapes at body scale
# -----------------------------------------------------------------------------
def xf_down():
    """pill local -Z -> -Y (down); its +Y (height) -> -Z (front)"""
    return rot_x(-math.pi / 2)


def xf_up():
    """pill local -Z -> +Y (up); its +Y (height) -> +Z (back)"""
    return rot_x(math.pi / 2)


def orient(d, up_hint=V(0, 1, 0)):
    """a rotation taking local -Z to direction d, local +Y as near up_hint as it can"""
    z = (-d).normalized()
    x = up_hint.cross(z)
    if x.length < 1e-6:
        x = V(1, 0, 0).cross(z)
    x.normalize()
    y = z.cross(x).normalized()
    M = Matrix((x, y, z)).transposed()
    return M.to_4x4()


def pill_between(mb, mat, a, b, w, h, up_hint=V(0, 1, 0), pad0=0.0, pad1=0.0, **kw):
    """a pill from point a to point b (cross-section w by h, h toward up_hint)"""
    d = b - a
    L = d.length
    xf = tr(*a) @ orient(d, up_hint)
    pill(mb, mat, -pad0, -(L - pad1), w, h, xf=xf, **kw)


def ring_y(mb, y, ax, az, r, mat, cx=0.0, cz=0.0, segs=64, rsegs=8):
    """a thin torus around the Y axis, stretched to an ellipse (ax, az)"""
    t = MB()
    torus_z(t, 1.0, r, mat, segs, rsegs)
    xf = tr(cx, y, cz) @ rot_x(math.pi / 2) @ Matrix.Diagonal((ax, az, 1.0, 1.0))
    t.v = [xf @ p for p in t.v]
    mb.extend(t)


def ring_z(mb, z, ax, ay, r, mat, cx=0.0, cy=0.0, segs=64, rsegs=8):
    t = MB()
    torus_z(t, 1.0, r, mat, segs, rsegs)
    xf = tr(cx, cy, z) @ Matrix.Diagonal((ax, ay, 1.0, 1.0))
    t.v = [xf @ p for p in t.v]
    mb.extend(t)


def joint_barrel(mb, glow, w, rb, xf=None, lit=(True, True), band=False):
    """A chrome joint barrel along X, centred on the pivot: chamfered ends, a recessed graphite ring round
    each pin cap with a cyan ring of light in it, the pin proud of the face (the robot hand's barrel, at
    body scale)."""
    xf = xf or Matrix()
    hw = w / 2
    m, g = MB(), MB()
    c = rb * 0.06
    if band:
        gap = rb * 0.08
        cyl_x(m, rb, -hw, -gap, "chrome", 48, chamfer=c)
        cyl_x(m, rb, gap, hw, "chrome", 48, chamfer=c)
        cyl_x(m, rb * 0.86, -gap - 0.001, gap + 0.001, "graphite", 48)
        cyl_x(g, rb * 0.93, -gap * 0.6, gap * 0.6, "glow", 48)
    else:
        cyl_x(m, rb, -hw, hw, "chrome", 48, chamfer=c)
    for s, on in ((-1, lit[0]), (1, lit[1])):
        face = s * hw
        d = rb * 0.035
        x0, x1 = (face - d, face + d * 0.4) if s > 0 else (face - d * 0.4, face + d)
        lathe(m, [(rb * 0.62, x1), (rb * 0.82, x1), (rb * 0.82, x0), (rb * 0.62, x0), (rb * 0.62, x1)], "graphite", 48,
              rot_y(math.pi / 2))
        if on:
            ring = MB()
            torus_z(ring, rb * 0.72, rb * 0.045, "glow", 64, 8, tr(face + s * d * 0.3, 0, 0) @ rot_y(math.pi / 2))
            g.extend(ring)
        cx0, cx1 = (face - d, face + d * 1.6) if s > 0 else (face - d * 1.6, face + d)
        cyl_x(m, rb * 0.5, cx0, cx1, "chrome", 40, chamfer=rb * 0.04)
    mb.extend(m, xf)
    glow.extend(g, xf)


def ball_joint(mb, glow, r, xf=None, ring_axis=V(1, 0, 0), ring_at=0.55):
    """a chrome ball joint with a ring of light round it, facing ring_axis"""
    xf = xf or Matrix()
    s = MB()
    sphere(s, r, "chrome", 48, 24)
    mb.extend(s, xf)
    t = MB()
    rot = orient(-ring_axis)  # local -Z -> -axis, so +Z -> axis
    torus_z(t, r * math.sqrt(1 - ring_at ** 2) + r * 0.03, r * 0.04, "glow", 72, 8, rot @ tr(0, 0, r * ring_at))
    glow.extend(t, xf)


def glow_line(glow, pts, r=0.0011):
    tube(glow, pts, r, "glow", 6)


# -----------------------------------------------------------------------------
# Body parts (right side; the left is mirrored)
# -----------------------------------------------------------------------------
# -----------------------------------------------------------------------------
# The torso: shells that telescope like armour
# -----------------------------------------------------------------------------
# Every torso shell is a superellipse section round the body's centre line (the y axis of its joint, which sits
# on that line where the shells overlap), so a joint turning moves its shell about the shell's own centre and
# the overlap stays closed. Spine1 (the waist) is the narrowest ring: its bottom tucks inside the pelvis's rim,
# its top inside Spine2, whose top tucks inside the chest. Each shell's rims roll inward, any opening at the front
# has a rolled lip with the glass sunk under it, and a dark graphite liner covers the shell's inside.
SHELL_T = 0.0035     # porcelain thickness of the torso's shells
LIP_SPAN = 0.13      # how far round (radians) a window's lip rolls in
RIM_SPAN = 0.009     # how far up (metres) a rim rolls in
SHELLS = {}          # each torso node's outer shell, for the clearance check


def _dense(t):
    """rows crowded toward both ends (for lips and rims)"""
    return 0.5 - 0.5 * math.cos(math.pi * t)


def shell_point(d, u, th, inset=0.0, lips=True):
    """a point on shell d at height parameter u and angle th (front = -pi/2), `inset` metres inside its surface"""
    W, D, ZC, n = d["W"], d["D"], d["ZC"], d["n"]
    y = lerp(d["y0"], d["y1"], u)
    x, z = superellipse(th, W(u) / 2, D(u) / 2, n)
    r = math.hypot(x, z) or 1e-6
    k = inset
    if lips:
        a = d["open"](u) if d.get("open") else 0.0
        if a > 1e-4:
            front = -math.pi / 2
            e = min((th - (front + a)) % TAU, ((front - a) - th) % TAU)
            k += d["lip"] * smooth01(a / 0.12) * (1 - smooth01(e / LIP_SPAN))
        if d.get("rim0"):
            k += d["rim0"] * (1 - smooth01((y - d["y0"]) / RIM_SPAN))
        if d.get("rim1"):
            k += d["rim1"] * (1 - smooth01((d["y1"] - y) / RIM_SPAN))
    s = 1 - k / r
    if d.get("dome1"):
        s *= common.end_round(u, 0.0, d["dome1"])
    return V(x * s, y, ZC(u) + z * s)


def torso_shell(mb, mat, d, inset=0.0, theta=None, u0=0.0, u1=1.0, lips=True, nu=26, nv=88):
    """a shell (or its liner, or the glass in its window) on definition d, between heights u0..u1 of it"""
    front = -math.pi / 2

    def rng(u):
        if theta:
            return theta
        a = d["open"](u) if d.get("open") else 0.0
        return (front + a, front + TAU - a)
    closed = theta is None and not d.get("open")

    def fn(t, v):
        u = lerp(u0, u1, _dense(t))
        a0, a1 = rng(u)
        th = a0 + (a1 - a0) * (v if closed else _dense(v))
        return shell_point(d, u, th, inset, lips)
    pole = None
    if d.get("dome1") and u1 >= 1.0:
        pole = shell_point(d, 1.0, 0.0, inset, lips)
        pole.x = 0.0
        pole.z = d["ZC"](1.0)
    common.grid_surface(mb, fn, max(4, round(nu * DETAIL)), max(12, round(nv * DETAIL)), mat, closed_v=closed, pole1=pole)


def window_glass(mb, d, a, nu=12, nv=40):
    """glass across the front window (half-angle a), sunk under the shell's lips"""
    front = -math.pi / 2
    span = (front - a - 0.6 * LIP_SPAN, front + a + 0.6 * LIP_SPAN)
    torso_shell(mb, "glass", d, inset=d["lip"] + 0.0006, theta=span, u0=0.02, u1=0.98 if not d.get("dome1") else 0.93,
                lips=False, nu=nu, nv=nv)


def _pelvis_def():
    def f(u):
        # the bottom rounds in toward the seat
        return 0.56 + 0.44 * math.sin(0.5 * math.pi * min(1.0, u / 0.42))
    return dict(y0=-0.074, y1=0.118, n=2.3, lip=0.005, rim1=0.0025,
                W=lambda u: 0.306 * f(u) * (1 - 0.045 * u), D=lambda u: 0.2 * f(u) * (1 - 0.05 * u),
                ZC=lambda u: 0.012 * (1 - u) ** 1.5,
                # open at the front below the abdomen for the thighs, closing into a full rim at the top
                open=lambda u: 0.95 * (1 - smooth01((u - 0.3) / 0.58)))


def build_pelvis(parent):
    shell, liner, core, hw, glow = MB(), MB(), MB(), MB(), MB()
    d = _pelvis_def()
    SHELLS["Pelvis"] = d
    torso_shell(shell, "shell", d, nu=34, nv=96)
    torso_shell(liner, "graphite", d, inset=SHELL_T + 0.0016, u0=0.25, u1=0.985, lips=False, nu=12, nv=64)
    pill(core, "graphite", 0.06, -0.07, lambda u: 0.25, lambda u: 0.15, n=2.8, e0=0.25, e1=0.0, yoff=0.01,
         xf=xf_up(), nu=16, nv=40)
    # a chrome bead along the rim, and a line of light round the hips below it
    ring = [shell_point(d, 1.0, TAU * i / 128, 0.0016) for i in range(129)]
    tube(hw, ring, 0.0028, "chrome", 10)
    glw = [shell_point(d, 0.9, TAU * i / 128, -0.0004) for i in range(129)]
    tube(glow, glw, 0.0010, "glow", 6)
    # the hip joints: chrome balls in graphite sockets, a ring of light on the outer cap
    for s in (1, -1):
        c = V(s * DS.HIP_HALF, 0.0, 0.0)
        sphere(core, 0.058, "graphite", 32, 16, center=tuple(c + V(s * 0.012, 0, 0.006)))
        ball_joint(hw, glow, 0.05, tr(*c), ring_axis=V(s, 0, 0), ring_at=0.62)
    return node("Pelvis", [(shell, {"solid": 0.004, "bevel": 0.0012, "bseg": 2}), (liner, {}), (core, {}), (hw, {}),
                           (glow, {})], off("Pelvis"), parent)


def _band_def(y0, y1, w0, w1, d0, d1, z0, z1, flare=0.0):
    """a band; `flare` widens its bottom rim (where it overlaps the band below), like an armour plate's lip"""
    fl = lambda u: flare * (1 - smooth01(u / 0.3))
    return dict(y0=y0, y1=y1, n=2.3, lip=0.0035, rim0=0.0025, rim1=0.0025,
                W=lambda u: lerp(w0, w1, u) + fl(u), D=lambda u: lerp(d0, d1, u) + fl(u), ZC=lambda u: lerp(z0, z1, u),
                open=lambda u: BAND_WINDOW)


BAND_WINDOW = 0.92   # half-angle of the abdomen's front window (radians)


def spine_band(name, parent, d):
    """a segment of the abdomen: a porcelain band, its window over the lit spine sunk under rolled lips, a chrome
    vertebra and a ring of light at its joint (the body's centre line)"""
    shell, liner, glass, core, hw, glow = MB(), MB(), MB(), MB(), MB(), MB()
    SHELLS[name] = d
    y0, y1 = d["y0"], d["y1"]
    torso_shell(shell, "shell", d, nu=22, nv=88)
    torso_shell(liner, "graphite", d, inset=SHELL_T + 0.0014, lips=False, nu=6, nv=56)
    window_glass(glass, d, BAND_WINDOW)
    # inside: the spine (a graphite column and chrome vertebrae on the centre line), actuator rods and lines of
    # light in front of it, behind the glass
    zf = d["ZC"](0.5) - d["D"](0.5) / 2 * 0.62
    cyl_z(core, 0.022, y0 + 0.004, y1 - 0.004, "graphite", 32, xf=rot_x(-math.pi / 2))
    for yy in (0.0, 0.5 * (y0 + y1)):
        lathe(hw, [(0.0, yy + 0.009), (0.029, yy + 0.009), (0.032, yy + 0.005), (0.032, yy - 0.005), (0.029, yy - 0.009),
                   (0.0, yy - 0.009)], "chrome", 48, rot_x(-math.pi / 2))
    torus_z(glow, 0.034, 0.0016, "glow", 72, 8, rot_x(math.pi / 2))
    pill(core, "graphite", -(y0 + 0.006), -(y1 - 0.006), lambda u: d["W"](u) * 0.6, lambda u: d["D"](u) * 0.42, n=3.0,
         e0=0, e1=0, yoff=lambda u: d["ZC"](u) - 0.012, xf=xf_up(), nu=4, nv=32)
    for x in (-0.05, 0.05):
        cyl_z(hw, 0.0055, y0 + 0.004, y1 - 0.004, "chrome", 20, center=(x, 0.0), xf=tr(0, 0, zf) @ rot_x(-math.pi / 2))
    for x in (-0.026, 0.0, 0.026):
        glow_line(glow, [V(x, y0 + 0.008, zf - 0.004), V(x, y1 - 0.008, zf - 0.004)], 0.0016)
    parts = [(shell, {"solid": SHELL_T, "bevel": 0.001}), (liner, {}), (glass, {"solid": 0.0016, "bevel": 0.0005}),
             (core, {}), (hw, {}), (glow, {})]
    return node(name, parts, off(name), parent)


CHEST_WIN = 0.2


def _chest_def():
    def fl(u):
        # its bottom rim flares a little over Spine2, like an armour plate's lip
        return 0.007 * (1 - smooth01(u / 0.22))

    def W(u):
        # from over the lower thorax out to the ribs, in to the shoulders' yoke
        return 0.31 + 0.01 * math.sin(math.pi * min(1.0, u * 1.6)) - 0.054 * smooth01((u - 0.5) / 0.45) + fl(u)

    def D(u):
        return 0.211 + 0.006 * math.sin(math.pi * min(1.0, u * 1.4)) - 0.038 * smooth01((u - 0.6) / 0.4) + fl(u)
    return dict(y0=-0.036, y1=0.205, n=2.4, lip=0.0035, rim0=0.0025, dome1=0.2, W=W, D=D,
                ZC=lambda u: lerp(-0.004, -0.014, u), open=lambda u: CHEST_WIN)


def build_chest(parent):
    shell, liner, glass, core, hw, glow = MB(), MB(), MB(), MB(), MB(), MB()
    d = _chest_def()
    SHELLS["Chest"] = d
    torso_shell(shell, "shell", d, nu=40, nv=96)
    torso_shell(liner, "graphite", d, inset=SHELL_T + 0.0016, lips=False, u1=0.86, nu=12, nv=64)
    window_glass(glass, d, CHEST_WIN, nu=20, nv=24)
    W, Dd, ZC = d["W"], d["D"], d["ZC"]
    pill(core, "graphite", 0.03, -0.19, lambda u: 0.22, lambda u: 0.15, n=2.8, e0=0, e1=0.18, yoff=-0.01, xf=xf_up(),
         nu=16, nv=40)
    # the lit core behind the sternum: a ring of light round a chrome hub, lines of light up to the collar
    zc = ZC(0.55) - Dd(0.55) / 2 * 0.78
    for rr, mat, w in ((0.03, "glow", 0.0018), (0.022, "chrome", 0.003)):
        torus_z(glow if mat == "glow" else hw, rr, w, mat, 72, 8, tr(0, 0.11, zc))
    cyl_z(hw, 0.013, zc - 0.004, zc + 0.006, "chrome", 32, center=(0.0, 0.11))
    for x in (-0.012, 0.012):
        glow_line(glow, [V(x, 0.0, zc + 0.006), V(x * 0.6, 0.08, zc), V(x * 0.5, 0.14, zc + 0.002), V(x * 2.2, 0.185, zc + 0.02)])
    # a fine line of light round the ribs, just above the bottom rim
    u = (0.012 - d["y0"]) / (d["y1"] - d["y0"])
    pts = []
    for i in range(129):
        th = -math.pi / 2 + CHEST_WIN + 0.15 + (TAU - 2 * CHEST_WIN - 0.3) * i / 128
        pts.append(shell_point(d, u, th, -0.0004))
    glow_line(glow, pts, 0.0010)
    # the sternoclavicular joints
    for s in (1, -1):
        sphere(hw, 0.017, "chrome", 32, 16, center=tuple(V(*JS["ClavicleR" if s > 0 else "ClavicleL"]["offset"])))
    parts = [(shell, {"solid": 0.004, "bevel": 0.0012}), (liner, {}), (glass, {"solid": 0.0018, "bevel": 0.0006}),
             (core, {}), (hw, {}), (glow, {})]
    return node("Chest", parts, off("Chest"), parent)


def build_neck(parent):
    hw, core, glow = MB(), MB(), MB()
    L = off("Head").y
    for i, y in enumerate((0.014, 0.046, 0.078)):
        lathe(hw, [(0.0, y + 0.008), (0.024, y + 0.008), (0.027, y + 0.004), (0.027, y - 0.004), (0.024, y - 0.008),
                   (0.0, y - 0.008)], "chrome", 40, rot_x(-math.pi / 2))
    cyl_z(core, 0.019, -0.01, L + 0.01, "graphite", 32, xf=rot_x(-math.pi / 2))
    torus_z(glow, 0.03, 0.0015, "glow", 64, 8, tr(0, 0.0, 0) @ rot_x(math.pi / 2))
    for s in (1, -1):
        tube(hw, [V(s * 0.03, -0.01, 0.012), V(s * 0.031, 0.05, 0.016), V(s * 0.028, L + 0.012, 0.012)], 0.0032, "steel", 10)
    # the throat: a graphite actuator in front
    tube(core, [V(0, -0.005, -0.03), V(0, 0.05, -0.034), V(0, L, -0.028)], 0.0085, "graphite", 14)
    return node("Neck", [(hw, {}), (core, {}), (glow, {})], off("Neck"), parent)


def build_head(parent):
    shell, glass, core, hw, glow = MB(), MB(), MB(), MB(), MB()
    # an elegant sensor head: a long porcelain ovoid, a band of glass across the front at eye level over a lit
    # sensor array, chrome pivot caps at the sides. No face.
    yb, yt = -0.035, 0.212
    H_ = yt - yb
    zoff = 0.006

    def prof(y):
        u = (y - yb) / H_
        return math.sin(math.pi * min(1.0, max(0.0, u)) ** 0.85) ** 0.55

    Wf = lambda y: 0.148 * (0.62 + 0.38 * prof(y))
    Df = lambda y: 0.192 * (0.6 + 0.4 * prof(y))
    vis0, vis1 = 0.074, 0.122
    win = 1.05  # half-angle of the visor about the front

    def piece(mb, mat, ya, yb_, th, scale=1.0, e0=0.0, e1=0.0, nu=16, nv=64):
        pill(mb, mat, -ya, -yb_, lambda u: Wf(lerp(ya, yb_, u)) * scale, lambda u: Df(lerp(ya, yb_, u)) * scale,
             n=2.2, e0=e0, e1=e1, th=th, yoff=zoff, xf=xf_up(), nu=nu, nv=nv)

    front = 3 * math.pi / 2
    piece(shell, "shell", vis1 + 0.003, yt, (0, TAU), e1=0.5, nu=30, nv=72)
    piece(shell, "shell", yb, vis0 - 0.003, (0, TAU), e0=0.45, nu=24, nv=72)
    piece(shell, "shell", vis0 - 0.003, vis1 + 0.003, (front + win, front - win + TAU), nu=6, nv=56)
    piece(glass, "glass", vis0 - 0.002, vis1 + 0.002, (front - win - 0.04, front + win + 0.04), 1.004, nu=8, nv=40)
    piece(core, "graphite", vis0 - 0.01, vis1 + 0.01, (0, TAU), 0.9, nu=6, nv=48)
    # the sensor array: a line of light across the band, three small lenses
    ym = 0.5 * (vis0 + vis1)
    pts = []
    for i in range(41):
        a = front - win * 0.9 + 2 * win * 0.9 * i / 40
        x, z = superellipse(a, Wf(ym) / 2 * 0.905, Df(ym) / 2 * 0.905, 2.2)
        pts.append(V(x, ym + 0.006, z + zoff))
    glow_line(glow, pts, 0.0014)
    for k, x in enumerate((-0.026, 0.0, 0.026)):
        zf = zoff - Df(ym) / 2 * 0.9 * math.sqrt(max(0.0, 1 - (x / (Wf(ym) / 2 * 0.9)) ** 2)) + 0.002
        torus_z(hw, 0.0085 if k == 1 else 0.0062, 0.0016, "chrome", 40, 8, tr(x, ym - 0.008, zf))
        sphere(glow if k == 1 else core, 0.004 if k == 1 else 0.0035, "glow" if k == 1 else "graphite", 20, 10,
               center=(x, ym - 0.008, zf + 0.001))
    # pivot caps at the sides (where the ears would be), with rings of light
    for s in (1, -1):
        xc = s * Wf(0.09) / 2 * 0.985
        xf = tr(xc, 0.09, zoff + 0.012) @ rot_y(s * math.pi / 2)
        lathe(hw, [(0.0, 0.006), (0.016, 0.006), (0.02, 0.002), (0.02, -0.004), (0.0, -0.004)], "chrome", 40, xf)
        torus_z(glow, 0.0235, 0.0012, "glow", 64, 8, xf @ tr(0, 0, -0.002))
    # a panel line over the crown, front to back, on the shell's surface
    ya, yb2 = vis1 + 0.003, yt
    seam = []
    for i in range(61):
        t = i / 60
        side = -1 if t < 0.5 else 1
        u = min(0.998, (t * 2) if t < 0.5 else (2 - 2 * t))
        uu = math.sin(0.5 * math.pi * u)  # pill() rows crowd toward its rounded end
        y = lerp(ya, yb2, uu)
        sc = common.end_round(uu, 0.0, 0.5)
        seam.append(V(0, y, zoff + side * (Df(y) / 2 * sc + 0.0004)))
    tube(glow, seam, 0.0007, "glow", 6)
    parts = [(shell, {"solid": 0.0035, "bevel": 0.001}), (glass, {"solid": 0.0014, "bevel": 0.0005}), (core, {}),
             (hw, {}), (glow, {})]
    return node("Head", parts, off("Head"), parent)


def build_clavicle(name, parent):
    shell, hw, glow = MB(), MB(), MB()
    S = off("UpperArmR")
    # a slender strut and a yoke over it, from the sternum out to the shoulder
    pill_between(shell, "shell", V(0, 0, 0), S, 0.03, 0.026, up_hint=V(0, 1, 0), pad0=0.012, pad1=0.03, n=2.4,
                 e0=0.5, e1=0.4, nu=20, nv=28)
    pill_between(shell, "shell", V(0.01, 0.03, 0.03), S + V(-0.012, 0.03, 0.0), 0.085, 0.032, up_hint=V(0, 1, 0),
                 n=2.6, e0=0.45, e1=0.35, th=(-0.2, math.pi + 0.2), nu=24, nv=40)
    # the shoulder joint: a chrome ball, ringed with light toward the front and out
    ball_joint(hw, glow, 0.047, tr(*S), ring_axis=V(0.55, 0.0, -0.84).normalized(), ring_at=0.66)
    return node(name, [(shell, {"solid": 0.0035, "bevel": 0.001}), (hw, {}), (glow, {})], off(name), parent)


def build_upper_arm(name, parent):
    shell, inner, core, hw, glow = MB(), MB(), MB(), MB(), MB()
    L = DS.UPPER_ARM
    # the deltoid: a porcelain cap over the shoulder ball, up and out
    cap = MB()
    R0 = 0.06
    prof = [(0.0, R0 * 0.82), *[(R0 * math.sin(a), R0 * 0.82 * math.cos(a)) for a in [i * 0.11 for i in range(1, 14)]]]
    lathe(cap, prof, "shell", 64, orient(V(-0.5, -1, 0.05).normalized()))
    shell.extend(cap, tr(0.004, -0.006, 0.0))
    W = lambda u: lerp(0.094, 0.08, u)
    Dd = lambda u: lerp(0.1, 0.084, u)
    y0, y1 = -0.03, -(L - 0.036)
    pill(shell, "shell", y0, y1, W, Dd, n=2.5, e0=0.12, e1=0.15, th=(-2.1, 2.1), xf=xf_down(), nu=32, nv=48)
    pill(inner, "graphite", y0, y1, lambda u: W(u) * 0.985, lambda u: Dd(u) * 0.985, n=2.5, e0=0.12, e1=0.15,
         th=(2.1, TAU - 2.1), xf=xf_down(), nu=24, nv=16)
    pill(core, "graphite", y0 - 0.01, y1 + 0.01, lambda u: W(u) * 0.7, lambda u: Dd(u) * 0.7, n=3, e0=0.05, e1=0.05,
         xf=xf_down(), nu=12, nv=24)
    # the biceps actuator: a chrome piston on the inner front, a line of light up the outer side
    tube(hw, [V(-0.034, -0.06, -0.022), V(-0.04, -0.15, -0.026), V(-0.036, -0.235, -0.022)], 0.0058, "chrome", 16)
    tube(hw, [V(-0.034, -0.05, -0.022), V(-0.036, -0.09, -0.024)], 0.0085, "graphite", 16)
    pts = []
    for i in range(31):
        u = 0.15 + 0.6 * i / 30
        y = lerp(y0, y1, u)
        x, z = superellipse(-0.35, W(u) / 2 * 1.004, Dd(u) / 2 * 1.004, 2.5)
        pts.append(V(x, y, -z))
    glow_line(glow, pts, 0.0011)
    # the elbow: a chrome barrel across the hinge
    joint_barrel(hw, glow, 0.086, 0.034, tr(0, -L, 0), lit=(True, True))
    return node(name, [(shell, {"solid": 0.0035, "bevel": 0.001}), (inner, {"solid": 0.002}), (core, {}), (hw, {}),
                       (glow, {})], off(name), parent)


FA = HAND["forearm"]


def forearm_section(u):
    """the forearm's half-width and half-height from the elbow (u=0) to the wrist (u=1)"""
    a0, b0 = FA["elbowRadius"]
    a1, b1 = FA["wristRadius"]
    return lerp(a0, a1, u ** 0.9), lerp(b0, b1, u ** 0.9)


def build_forearm(name, parent):
    dorsal, ventral, core, hw, glow = MB(), MB(), MB(), MB(), MB()
    L = DS.FOREARM
    T = DS.TWIST_AT
    z0, z1 = -0.036, -(T - 0.008)
    w = lambda u: 2 * forearm_section(lerp(z0, z1, u) / -L)[0]
    h = lambda u: 2 * forearm_section(lerp(z0, z1, u) / -L)[1]
    X = lambda u: 0.0
    Y = lambda u: -0.002
    pill(dorsal, "shell", z0, z1, w, h, n=2.4, e0=0.18, e1=0, th=(-0.62, math.pi + 0.62), xoff=X, yoff=Y, nu=20, nv=56)
    pill(ventral, "graphite", z0, z1, lambda u: w(u) * 0.985, lambda u: h(u) * 0.985, n=2.4, e0=0.18, e1=0,
         th=(math.pi + 0.7, TAU - 0.7), xoff=X, yoff=Y, nu=12, nv=16)
    pill(core, "graphite", z0 + 0.01, z1 - 0.004, lambda u: w(u) * 0.86, lambda u: h(u) * 0.86, n=2.4, e0=0.1, e1=0,
         yoff=Y, nu=10, nv=28)
    # the olecranon, behind the elbow
    sphere(dorsal, 0.022, "shell", 32, 16, center=(0.0, 0.004, 0.024))
    # the roll joint's bearing: a chrome ring
    a, b = forearm_section(T / L)
    ring_z(hw, -T + 0.004, a * 1.02, b * 1.02, 0.0032, "chrome", cy=-0.002)
    return node(name, [(dorsal, {"solid": 0.003, "bevel": 0.0008}), (ventral, {"solid": 0.002}), (core, {}), (hw, {}),
                       (glow, {})], off(name), parent)


def build_forearm_twist(name, parent):
    dorsal, ventral, core, hw, glow = MB(), MB(), MB(), MB(), MB()
    L = DS.FOREARM
    T = DS.TWIST_AT
    D = L - T  # to the wrist pivot
    z0, z1 = -0.004, -(D - 0.026)
    uu = lambda u: (T - lerp(z0, z1, u)) / L
    w = lambda u: 2 * forearm_section(uu(u))[0]
    h = lambda u: 2 * forearm_section(uu(u))[1]
    X = lambda u: 0.0025 * u
    Y = lambda u: -0.002
    pill(dorsal, "shell", z0, z1, w, h, n=2.4, e0=0, e1=0, th=(-0.62, math.pi + 0.62), xoff=X, yoff=Y, nu=20, nv=56)
    pill(ventral, "graphite", z0, z1, lambda u: w(u) * 0.985, lambda u: h(u) * 0.985, n=2.4, e0=0, e1=0,
         th=(math.pi + 0.7, TAU - 0.7), xoff=X, yoff=Y, nu=10, nv=16)
    pill(core, "graphite", z0, z1 - 0.02, lambda u: w(u) * 0.9, lambda u: h(u) * 0.9, n=2.4, e0=0, e1=0, yoff=Y, nu=8,
         nv=28)
    # the roll ring's light, pistons and cables underneath (as on the piano's forearms), a line of light along the top
    a, b = forearm_section(T / L)
    ring_z(glow, -0.0005, a * 1.03, b * 1.03, 0.0012, "glow", cy=-0.002)
    bw = FA["wristRadius"][1]
    for s in (-1, 1):
        cyl_z(hw, 0.0038, -0.012, -(D - 0.04), "chrome", 20, center=(0.0025 + s * 0.012, -0.002 - bw * 0.95), chamfer=0.0006)
        cyl_z(hw, 0.0048, -0.006, -0.03, "graphite", 20, center=(0.0025 + s * 0.012, -0.002 - bw * 0.95))
    pts = []
    for k in range(25):
        u = 0.1 + 0.8 * k / 24
        x, y = superellipse(0.62, w(u) / 2 * 1.002, h(u) / 2 * 1.002, 2.4)
        pts.append(V(X(u) + x, Y(u) + y, lerp(z0, z1, u)))
    glow_line(glow, pts, 0.00035 * 2.2)
    # the wrist collar the hand's rings sit against (as on the piano's forearms)
    HB["ellipse_torus"](hw, 0.0025, -0.002, -(D - 0.0275), 0.0305, 0.0222, 0.0026, "chrome", 64, 12)
    return node(name, [(dorsal, {"solid": 0.0025, "bevel": 0.0006}), (ventral, {"solid": 0.0018}), (core, {}), (hw, {}),
                       (glow, {})], off(name), parent)


def stick_profile():
    """the drumstick as (radius, distance back from its end): an olive-shaped wooden tip, the taper to the
    shoulder, the shaft, and a rounded butt"""
    L = STICK["length"]
    rs = STICK["diameter"] / 2
    rt = STICK["tipDiameter"] / 2
    taper = STICK["taper"]
    pts = [(0.0, 0.0)]
    # the bead: an olive, slightly longer than wide
    for i in range(1, 9):
        a = math.pi / 2 * i / 8
        pts.append((rt * math.sin(a), rt * 1.15 * (1 - math.cos(a))))
    neck_at = rt * 2.2
    pts.append((rt * 0.92, rt * 1.6))
    pts.append((rt * 0.66, neck_at))
    # the taper out to the shoulder
    for i in range(1, 13):
        t = i / 12
        s = t * t * (3 - 2 * t)
        pts.append((lerp(rt * 0.66, rs, s ** 0.8), lerp(neck_at, taper, t)))
    pts.append((rs, L * 0.5))
    pts.append((rs, L - 0.006))
    for i in range(1, 7):
        a = math.pi / 2 * i / 6
        pts.append((rs * math.cos(a) * 0.98 + rs * 0.02, L - 0.006 + 0.006 * math.sin(a)))
    pts[-1] = (0.0, L)
    return pts


def build_stick(name, parent, fulcrum):
    """a hickory stick in the grip: its node on the fulcrum, the wood along the grip's direction"""
    wood = MB()
    L = STICK["length"]
    front = L - GRIP["fulcrumFromButt"]
    prof = stick_profile()
    # lathe along -Z from the end (z = -front) back to the butt (z = L - front), then turned onto the grip
    lp = [(r, -front + d) for r, d in reversed(prof)]
    lathe(wood, lp, "hickory", 28)
    d = V(*GRIP["direction"])
    rot = orient(d, V(0, 1, 0))
    wood.v = [rot @ p for p in wood.v]
    return node(name, [(wood, {"recalc": False})], fulcrum, parent)


def build_hand(side, parent):
    """the robot hand (its own builder) on the wrist pivot `parent`, without its piano forearm; returns the palm"""
    before = set(common.ALL)
    HB["build_wrist"](parent)
    palm = HB["build_palm"](parent)
    for f in HB["FINGERS"]:
        fid = f["id"]
        p0 = HB["phalanx"](f"F{fid}_0", f, 0, palm, V(*f["mcp"]))
        p1 = HB["phalanx"](f"F{fid}_1", f, 1, p0, V(0, 0, -f["segments"][0]))
        p2 = HB["phalanx"](f"F{fid}_2", f, 2, p1, V(0, 0, -f["segments"][1]))
        node(f"F{fid}_tip", None, V(0, 0, -f["segments"][2]), p2)
    t = HB["THUMB"]
    t0 = HB["phalanx"]("T_0", t, 0, palm, V(*t["cmc"]), is_thumb=True)
    t1 = HB["phalanx"]("T_1", t, 1, t0, V(0, 0, -t["segments"][0]), is_thumb=True)
    t2 = HB["phalanx"]("T_2", t, 2, t1, V(0, 0, -t["segments"][1]), is_thumb=True)
    node("T_tip", None, V(0, 0, -t["segments"][2]), t2)
    pre = SPEC["hand"]["prefix"][side]
    for o in common.ALL:
        if o not in before:
            o.name = pre + o.name.split(".")[0]
    return palm


def build_thigh(name, parent):
    shell, under, glass, core, hw, glow = MB(), MB(), MB(), MB(), MB(), MB()
    L = DS.THIGH
    z0, z1 = -0.052, -(L - 0.05)
    W = lambda u: lerp(0.142, 0.104, u ** 0.85)
    Hh = lambda u: lerp(0.128, 0.1, u)
    Y = lambda u: lerp(0.004, 0.002, u)
    pill(shell, "shell", z0, z1, W, Hh, n=2.5, e0=0.16, e1=0.14, th=(-0.32, math.pi + 0.5), yoff=Y, nu=36, nv=56)
    pill(under, "graphite", z0, z1, lambda u: W(u) * 0.985, lambda u: Hh(u) * 0.985, n=2.5, e0=0.16, e1=0.14,
         th=(math.pi + 0.5, TAU - 1.05), yoff=Y, nu=16, nv=20)
    # the outer side: glass over a lit actuator
    pill(glass, "glass", z0 - 0.01, z1 + 0.012, lambda u: W(u) * 1.006, lambda u: Hh(u) * 1.006, n=2.5, e0=0.1,
         e1=0.1, th=(-1.1, -0.28), yoff=Y, nu=16, nv=12)
    pill(core, "graphite", z0 + 0.006, z1 - 0.006, lambda u: W(u) * 0.78, lambda u: Hh(u) * 0.78, n=2.6, e0=0.1,
         e1=0.1, yoff=Y, nu=12, nv=28)
    cyl_z(hw, 0.0068, -0.08, -(L - 0.08), "chrome", 20, center=(0.045, -0.03))
    cyl_z(hw, 0.0095, -0.07, -0.16, "graphite", 20, center=(0.045, -0.03))
    glow_line(glow, [V(0.052, -0.016, -0.09), V(0.054, -0.016, -(L - 0.09))], 0.0016)
    # the hip's collar round the ball, and the knee barrel
    ring_z(hw, -0.012, 0.062, 0.062, 0.0045, "chrome")
    joint_barrel(hw, glow, 0.108, 0.043, tr(0, 0, -L), lit=(True, True))
    return node(name, [(shell, {"solid": 0.004, "bevel": 0.0012}), (under, {"solid": 0.0025}),
                       (glass, {"solid": 0.0016, "bevel": 0.0005}), (core, {}), (hw, {}), (glow, {})], off(name), parent)


def build_shin(name, parent):
    shell, calf, core, hw, glow = MB(), MB(), MB(), MB(), MB()
    L = DS.SHIN
    y0, y1 = -0.05, -(L - 0.036)
    W = lambda u: lerp(0.098, 0.066, u ** 1.1)
    Dd = lambda u: lerp(0.108, 0.07, u)
    Z = lambda u: lerp(-0.004, 0.0, u)  # down_pill: + is forward
    pill(shell, "shell", y0, y1, W, Dd, n=2.4, e0=0.12, e1=0.12, th=(-0.25, math.pi + 0.25), yoff=Z, xf=xf_down(),
         nu=34, nv=52)
    pill(calf, "glass", y0 - 0.02, y1 + 0.02, lambda u: W(u) * 1.004, lambda u: Dd(u) * 1.004, n=2.4, e0=0.12,
         e1=0.12, th=(math.pi + 0.2, TAU - 0.2), yoff=Z, xf=xf_down(), nu=16, nv=24)
    pill(core, "graphite", y0, y1, lambda u: W(u) * 0.8, lambda u: Dd(u) * 0.8, n=2.6, e0=0.1, e1=0.1, yoff=Z,
         xf=xf_down(), nu=12, nv=28)
    # the calf's actuator behind the glass: a chrome piston between graphite mounts, lines of light beside it
    cyl_z(hw, 0.0085, -0.08, -0.31, "chrome", 24, center=(0.0, -0.028), xf=rot_x(-math.pi / 2))
    cyl_z(hw, 0.012, -0.07, -0.16, "graphite", 24, center=(0.0, -0.028), xf=rot_x(-math.pi / 2))
    for x in (-0.018, 0.018):
        glow_line(glow, [V(x, -0.09, 0.03), V(x, -0.3, 0.026)], 0.0013)
    # the kneecap, and the ankle's barrel
    knee = MB()
    lathe(knee, [(0.0, 0.006), (0.024, 0.004), (0.034, -0.002), (0.036, -0.008), (0.0, -0.008)], "shell", 48,
          orient(V(0, 0.35, -1).normalized()) @ rot_x(math.pi))
    shell.extend(knee, tr(0, 0.012, -0.05))
    joint_barrel(hw, glow, 0.078, 0.027, tr(0, -L, 0), lit=(True, True))
    return node(name, [(shell, {"solid": 0.004, "bevel": 0.0012}), (calf, {"solid": 0.0016, "bevel": 0.0005}),
                       (core, {}), (hw, {}), (glow, {})], off(name), parent)


FOOT = SPEC["foot"]


def build_foot(name, parent):
    shell, sole, rub, hw, glow = MB(), MB(), MB(), MB(), MB()
    ah = FOOT["ankleHeight"]
    bz = FOOT["ball"][2]
    z0, z1 = 0.064, bz + 0.004
    W = lambda u: lerp(0.07, 0.094, u ** 0.8)
    Hh = lambda u: lerp(0.088, 0.046, u ** 0.9)
    Y = lambda u: -ah + 0.012 + Hh(u) / 2
    pill(shell, "shell", z0, z1, W, Hh, n=2.4, e0=0.38, e1=0.0, th=(-0.25, math.pi + 0.25), yoff=Y, nu=30, nv=48)
    pill(sole, "graphite", z0 + 0.002, z1, lambda u: W(u) * 1.01, 0.014, n=3.2, e0=0.3, e1=0.0,
         yoff=lambda u: -ah + 0.012, nu=20, nv=32)
    pill(rub, "rubber", z0, z1 - 0.002, lambda u: W(u) * 0.98, 0.009, n=3.4, e0=0.3, e1=0.0,
         yoff=lambda u: -ah + 0.0045, nu=20, nv=32)
    # a line of light along the upper's edge
    pts = []
    for k in range(25):
        u = 0.15 + 0.8 * k / 24
        pts.append(V(W(u) / 2 * 1.003, Y(u) - Hh(u) * 0.18, lerp(z0, z1, u)))
    glow_line(glow, pts, 0.0011)
    return node(name, [(shell, {"solid": 0.0035, "bevel": 0.001}), (sole, {}), (rub, {}), (hw, {}), (glow, {})],
                off(name), parent)


def build_toes(name, parent):
    shell, rub, hw, glow = MB(), MB(), MB(), MB()
    by = FOOT["ball"][1]
    ah = FOOT["ankleHeight"]
    floor = -ah - by  # the sole, relative to the toe joint
    joint_barrel(hw, glow, 0.086, 0.0135, lit=(True, False))
    W = lambda u: lerp(0.092, 0.082, u)
    Hh = lambda u: lerp(0.034, 0.028, u)
    pill(shell, "shell", -0.014, -FOOT["toe"], W, Hh, n=2.4, e0=0.0, e1=0.45, th=(-0.25, math.pi + 0.25),
         yoff=lambda u: floor + 0.01 + Hh(u) / 2, nu=16, nv=40)
    pill(rub, "rubber", -0.012, -FOOT["toe"] + 0.002, lambda u: W(u) * 0.98, 0.012, n=3.4, e0=0.0, e1=0.4,
         yoff=floor + 0.0055, nu=12, nv=28)
    return node(name, [(shell, {"solid": 0.003, "bevel": 0.0009}), (rub, {}), (hw, {}), (glow, {})], off(name), parent)


# -----------------------------------------------------------------------------
# Mirroring the left side
# -----------------------------------------------------------------------------
MIRROR = Matrix.Diagonal((-1.0, 1.0, 1.0, 1.0))


def mirror_tree(ob, own_offset=False):
    """mirror a subtree in x: meshes, node offsets and rest rotations (M R M)"""
    if ob.type == "MESH" and ob.data:
        me = ob.data
        bm = bmesh.new()
        bm.from_mesh(me)
        for v in bm.verts:
            v.co.x = -v.co.x
        bmesh.ops.reverse_faces(bm, faces=bm.faces)
        bm.to_mesh(me)
        bm.free()
        me.update()
    if own_offset:
        ob.matrix_basis = MIRROR @ ob.matrix_basis @ MIRROR
    else:
        # keep this node's (already mirrored) offset, mirror its rotation
        t = ob.matrix_basis.to_translation()
        R = MIRROR @ ob.matrix_basis.to_3x3().to_4x4() @ MIRROR
        ob.matrix_basis = Matrix.Translation(t) @ R
    for c in ob.children:
        mirror_tree(c, True)


# -----------------------------------------------------------------------------
# Assembly
# -----------------------------------------------------------------------------
def build_arm(s, chest):
    """an arm on the right's geometry and offsets; for L the subtree is mirrored after"""
    R = "R"
    clav = build_clavicle(f"Clavicle{s}", chest)
    if s == "L":
        clav.matrix_basis = Matrix.Translation(to_blender(off("ClavicleL")))
    up = build_upper_arm(f"UpperArm{s}", clav)
    up.matrix_basis = Matrix.Translation(to_blender(off(f"UpperArm{R}")))
    fa = build_forearm(f"Forearm{s}", up)
    fa.matrix_basis = Matrix.Translation(to_blender(off(f"Forearm{R}")))
    tw = build_forearm_twist(f"ForearmTwist{s}", fa)
    tw.matrix_basis = Matrix.Translation(to_blender(off(f"ForearmTwist{R}")))
    hand = node(f"Hand{s}", None, off(f"Hand{R}"), tw)
    palm = build_hand(s, hand)
    build_stick(f"Stick{s}", palm, V(*GRIP["fulcrum"]))
    if s == "L":
        mirror_tree(clav, own_offset=False)
    return clav


def build_leg(s, pelvis):
    R = "R"
    th = build_thigh(f"Thigh{s}", pelvis)
    th.matrix_basis = Matrix.Translation(to_blender(off(f"Thigh{R}")))
    sh = build_shin(f"Shin{s}", th)
    sh.matrix_basis = Matrix.Translation(to_blender(off(f"Shin{R}")))
    ft = build_foot(f"Foot{s}", sh)
    ft.matrix_basis = Matrix.Translation(to_blender(off(f"Foot{R}")))
    to = build_toes(f"Toes{s}", ft)
    to.matrix_basis = Matrix.Translation(to_blender(off(f"Toes{R}")))
    if s == "L":
        th.matrix_basis = Matrix.Translation(to_blender(off("ThighL")))
        mirror_tree(th, own_offset=False)
    return th


def build_label(chest):
    """the maker's label, printed on the upper back: a thin curved decal with UVs, on the chest's own surface"""
    d = _chest_def()
    me = bpy.data.meshes.new("Label")
    verts, faces, uvs = [], [], []
    nu, nv = 24, 6
    w, h = 0.14, 0.0525
    yc = 0.135

    def back_point(x, y):
        # where the chest's back is at this height and across, a hair proud of it
        u = (y - d["y0"]) / (d["y1"] - d["y0"])
        a = d["W"](u) / 2
        b = d["D"](u) / 2
        t = min(0.999, abs(x) / a)
        z = b * (1 - t ** d["n"]) ** (1 / d["n"])
        return V(x, y, d["ZC"](u) + z * common.end_round(u, 0.0, d["dome1"]) + 0.0004)

    for j in range(nv + 1):
        for i in range(nu + 1):
            x = -w / 2 + w * i / nu
            y = yc - h / 2 + h * j / nv
            verts.append(to_blender(back_point(x, y)))
            uvs.append((i / nu, j / nv))
    for j in range(nv):
        for i in range(nu):
            a = j * (nu + 1) + i
            faces.append((a, a + 1, a + nu + 2, a + nu + 1))  # facing out of the back
    me.from_pydata(verts, [], faces)
    uv = me.uv_layers.new(name="UVMap")
    for poly in me.polygons:
        for li in poly.loop_indices:
            uv.data[li].uv = uvs[me.loops[li].vertex_index]
    me.materials.append(common.get_mat("label"))
    me.polygons.foreach_set("use_smooth", [True] * len(me.polygons))
    ob = bpy.data.objects.new("ChestLabel", me)
    scene().collection.objects.link(ob)
    ob.parent = chest
    common.ALL.append(ob)
    return ob


def build_drummer():
    root = node("Drummer", None, V(0, 0, 0))
    pelvis = build_pelvis(root)
    # the waist ring: its bottom inside the pelvis's rim, its top inside Spine2 (9 mm clear of each other's inside)
    s1 = spine_band("Spine1", pelvis, _band_def(-0.008, 0.112, 0.27, 0.268, 0.168, 0.166, 0.0, 0.0))
    # over it, and inside the chest's lower rim
    s2 = spine_band("Spine2", s1, _band_def(-0.03, 0.104, 0.291, 0.286, 0.189, 0.187, -0.002, -0.004, flare=0.008))
    chest = build_chest(s2)
    neck = build_neck(chest)
    build_head(neck)
    build_label(chest)
    for s in ("R", "L"):
        build_arm(s, chest)
        build_leg(s, pelvis)
    return root


# -----------------------------------------------------------------------------
# Poses: rest, the grip's finger curl, a pose from the IK (--pose)
# -----------------------------------------------------------------------------
def objects_by_name():
    return {o.name: o for o in bpy.data.objects}


def set_rot(ob, R9):
    t = ob.matrix_basis.to_translation()
    R = Matrix(((R9[0], R9[1], R9[2]), (R9[3], R9[4], R9[5]), (R9[6], R9[7], R9[8])))
    ob.matrix_basis = Matrix.Translation(t) @ mat_to_blender(R)


def apply_pose(path):
    """a pose written by tools/drummer-pose.cjs from the IK: local rotations per node, the fingers' grip"""
    P = json.load(open(path))
    obs = objects_by_name()
    for name, R9 in P["local"].items():
        if name in obs:
            set_rot(obs[name], R9)
    for side, nodes in P["fingers"].items():
        for name, R9 in nodes.items():
            n = SPEC["hand"]["prefix"][side] + name
            if n in obs:
                set_rot(obs[n], R9)
    bpy.context.view_layer.update()
    return P


def spread_for_bake():
    """limbs apart so the bake sees each part on its own (contact shading between parts is left to the renderer)"""
    obs = objects_by_name()
    for s, sg in (("R", 1), ("L", -1)):
        set_pose(obs[f"UpperArm{s}"], off(f"UpperArm{s}"), rot_z(sg * 0.5).to_3x3())
        set_pose(obs[f"Thigh{s}"], off(f"Thigh{s}"), rot_y(-sg * 0.25).to_3x3())
    bpy.context.view_layer.update()


def reset_rest():
    for o in bpy.data.objects:
        if o.name in JS:
            o.matrix_basis = Matrix.Translation(o.matrix_basis.to_translation())
    bpy.context.view_layer.update()


def stick_wear(sticks):
    """the wood's wear into the masks' G: the tip and shoulder (strokes, crashes), a band where a rimshot or
    the hi-hat's edge catches the shaft, and the grip polished darker"""
    for ob in sticks:
        me = ob.data
        col = me.color_attributes.get("Col")
        if col is None:
            continue
        d = V(*GRIP["direction"])
        front = STICK["length"] - GRIP["fulcrumFromButt"]
        for li, loop in enumerate(me.loops):
            p = me.vertices[loop.vertex_index].co
            q = V(p.x, p.z, -p.y)  # blender -> three
            if ob.name.endswith("L"):
                q.x = -q.x  # the left stick is the right mirrored
            s = front - q.dot(d)
            tip = math.exp(-((s - 0.006) / 0.012) ** 2)
            shoulder = math.exp(-((s - 0.05) / 0.016) ** 2)
            band = 0.45 * math.exp(-((s - 0.135) / 0.02) ** 2)
            grip = 0.25 * math.exp(-((s - front) / 0.04) ** 2)
            c = list(col.data[li].color)
            c[1] = min(1.0, 0.75 * tip + 0.6 * shoulder + band + grip)
            col.data[li].color = c


def label_preview():
    """(previews only) the label's printing, as the runtime draws it: dark ink in the alpha of a canvas"""
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        return
    im = Image.new("RGBA", (1024, 384), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    try:
        big = ImageFont.truetype("DejaVuSans-Bold.ttf", 86)
        mid = ImageFont.truetype("DejaVuSans.ttf", 42)
        small = ImageFont.truetype("DejaVuSans.ttf", 32)
    except OSError:
        big = mid = small = ImageFont.load_default()
    d.rectangle((10, 10, 1014, 374), outline=(255, 255, 255, 255), width=5)
    d.text((54, 62), "VEY AUTOMATA", fill=(255, 255, 255, 255), font=big)
    d.text((56, 190), "DR-3  PERCUSSION UNIT", fill=(255, 255, 255, 255), font=mid)
    d.text((56, 276), "SN 0815-D     48 V     MADE BY HAND", fill=(255, 255, 255, 255), font=small)
    d.ellipse((838, 78, 962, 202), outline=(255, 255, 255, 255), width=6)
    path = os.path.join(os.path.dirname(OUT), ".label_preview.png")
    im.save(path)
    img = bpy.data.images.load(path)
    m = bpy.data.materials.get("label")
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    nt.links.new(tex.outputs["Alpha"], bsdf.inputs["Alpha"])
    m.blend_method = "BLEND" if hasattr(m, "blend_method") else None
    os.remove(path)


def preview(path, root):
    """studio renders in Cycles: the whole drummer on a stool, and the hands on the sticks"""
    sc = scene()
    # a stool and a floor
    fl = bpy.data.meshes.new("floor")
    s = 4
    fl.from_pydata([(-s, -s, 0), (s, -s, 0), (s, s, 0), (-s, s, 0)], [], [(0, 1, 2, 3)])
    flo = bpy.data.objects.new("floor", fl)
    m = bpy.data.materials.new("floor_mat")
    m.use_nodes = True
    m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.05, 0.045, 0.04, 1)
    m.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.6
    fl.materials.append(m)
    sc.collection.objects.link(flo)
    seat_y = 0.52
    bpy.ops.mesh.primitive_cylinder_add(radius=0.18, depth=0.08, location=to_blender(V(0, seat_y - 0.04, 0)))
    stool = bpy.context.active_object
    sm = bpy.data.materials.new("stool_mat")
    sm.use_nodes = True
    sm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.02, 0.02, 0.02, 1)
    sm.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.45
    stool.data.materials.append(sm)
    bpy.ops.mesh.primitive_cylinder_add(radius=0.02, depth=seat_y - 0.08, location=to_blender(V(0, (seat_y - 0.08) / 2, 0)))
    post = bpy.context.active_object
    post.data.materials.append(common.get_mat("chrome"))
    root.matrix_basis = Matrix.Translation(to_blender(V(0, seat_y, 0)))
    bpy.context.view_layer.update()
    cam_data = bpy.data.cameras.new("cam")
    cam = bpy.data.objects.new("cam", cam_data)
    sc.collection.objects.link(cam)
    sc.camera = cam
    for (p, e, size, col) in ((V(-1.6, 2.6, -2.0), 900, 1.6, (1.0, 0.86, 0.72)), (V(1.8, 2.0, 1.6), 380, 1.2, (0.7, 0.8, 1.0)),
                              (V(1.2, 0.9, -2.2), 120, 2.0, (0.9, 0.9, 1.0))):
        ld = bpy.data.lights.new(f"l{p.x}", "AREA")
        ld.energy = e
        ld.size = size
        ld.color = col
        lo = bpy.data.objects.new(f"l{p.x}", ld)
        lo.location = to_blender(p)
        dd = (to_blender(V(0, 0.9, -0.1)) - lo.location).normalized()
        lo.rotation_euler = dd.to_track_quat("-Z", "Y").to_euler()
        sc.collection.objects.link(lo)
    sc.world.color = (0.012, 0.013, 0.015)
    sc.render.engine = "CYCLES"
    sc.cycles.samples = int(os.environ.get("PREVIEW_SAMPLES", "48"))
    sc.cycles.use_denoising = True
    sc.render.resolution_x = int(os.environ.get("PREVIEW_W", "1200"))
    sc.render.resolution_y = int(os.environ.get("PREVIEW_H", "1500"))
    g = bpy.data.materials.get("glow")
    if g:
        g.node_tree.nodes["Principled BSDF"].inputs["Emission Strength"].default_value = 8.0
    label_preview()
    shots = os.environ.get("PREVIEW_SHOTS", "full").split(",")
    views = {
        "full": (V(1.25, 1.35, -2.25), V(0.0, 0.82, -0.12), 42, None),
        "side": (V(-2.3, 1.1, -0.25), V(0.0, 0.78, -0.08), 50, None),
        "back": (V(0.9, 1.5, 1.9), V(0.0, 0.95, 0.0), 45, None),
        "head": (V(0.35, 1.48, -0.75), V(0.0, 1.36, 0.02), 75, None),
        "waistSide": (V(-1.35, 0.92, 0.1), V(0.0, 0.78, 0.06), 55, None),
        "waistBack": (V(-0.95, 1.05, 0.95), V(0.0, 0.78, 0.05), 55, None),
        "waistFront": (V(0.95, 1.0, -0.9), V(0.0, 0.8, 0.0), 55, None),
        "hands": (None, None, 60, "hands"),
        "handR": (None, None, 80, "handR"),
    }
    obs = objects_by_name()
    for name in shots:
        loc, tgt, lens, special = views[name]
        if special:
            pr = obs["R_Palm"].matrix_world.to_translation()
            pl = obs["L_Palm"].matrix_world.to_translation()
            if special == "hands":
                tgt = (pr + pl) / 2
                loc = tgt + to_blender(V(0.25, 0.42, -0.75))
            else:
                # in the right palm's own frame: from the thumb's side, in front and a little above
                side = os.environ.get("HAND_VIEW", "thumb")
                eye = {"thumb": V(-0.24, 0.1, -0.2), "top": V(0.05, 0.3, -0.12), "under": V(-0.08, -0.25, -0.16),
                       "little": V(0.26, 0.04, -0.14), "front": V(-0.05, 0.02, -0.34)}[side]
                M = obs["R_Palm"].matrix_world
                # the hand on its own
                keep = set()
                stack = [obs["HandR"]]
                while stack:
                    o = stack.pop()
                    keep.add(o.name)
                    stack.extend(o.children)
                for o in bpy.data.objects:
                    if o.type == "MESH" and o.name not in keep:
                        o.hide_render = True
                tgt = M @ to_blender(V(-0.01, -0.03, -0.07))
                loc = M @ to_blender(eye)
            cam.location = loc
        else:
            cam.location = to_blender(loc)
            tgt = to_blender(tgt)
        cam_data.lens = lens
        d = (tgt - cam.location).normalized()
        cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
        sc.render.filepath = path.replace(".png", f"_{name}.png") if len(shots) > 1 else path
        bpy.ops.render.render(write_still=True)
    root.matrix_basis = Matrix()


# -----------------------------------------------------------------------------
# Checking the torso's overlaps through poses (--check-torso poses.json)
# -----------------------------------------------------------------------------
# For each pose (from tools/drummer-pose.cjs all), the torso's shells must not pass into each other (their
# porcelain and glass, as meshes), and each tucked rim must stay covered: the waist's bottom inside the pelvis's
# rim, its top inside Spine2, Spine2's top inside the chest.
JUNCTIONS = [
    # (outer, inner, the inner's rim that must stay covered: 0 = its bottom under the outer's top, 1 = its top
    #  above the outer's bottom)
    ("Pelvis", "Spine1", 0),
    ("Spine2", "Spine1", 1),
    ("Chest", "Spine2", 1),
]


def three_matrix(ob):
    """an object's world matrix in three.js axes"""
    return common.C4_INV @ ob.matrix_world @ common.C4


def shell_tris(ob, mats=("shell", "glass")):
    me = ob.data
    keep = {i for i, m in enumerate(me.materials) if m and m.name.split(".")[0] in mats}
    polys = [list(p.vertices) for p in me.polygons if p.material_index in keep]
    return [v.co.copy() for v in me.vertices], polys


def check_torso(path):
    from mathutils.bvhtree import BVHTree
    poses = json.load(open(path))
    obs = objects_by_name()
    data = {n: shell_tris(obs[n]) for n in ("Pelvis", "Spine1", "Spine2", "Chest")}
    worst_cover = {}
    worst_in = {}
    hits = []
    for P in poses:
        for name, R9 in P["local"].items():
            if name in obs:
                set_rot(obs[name], R9)
        bpy.context.view_layer.update()
        trees = {}
        for n, (vs, polys) in data.items():
            M = obs[n].matrix_world
            trees[n] = BVHTree.FromPolygons([M @ v for v in vs], polys)
        for outer, inner, rim in JUNCTIONS:
            pairs = trees[outer].overlap(trees[inner])
            if pairs:
                mo, mi = obs[outer].data, obs[inner].data
                po, pi = data[outer][1], data[inner][1]
                ko = [i for i, p in enumerate(mo.polygons) if p.material_index in
                      {j for j, m in enumerate(mo.materials) if m and m.name.split(".")[0] in ("shell", "glass")}]
                ki = [i for i, p in enumerate(mi.polygons) if p.material_index in
                      {j for j, m in enumerate(mi.materials) if m and m.name.split(".")[0] in ("shell", "glass")}]
                what = sorted({(mo.materials[mo.polygons[ko[a]].material_index].name.split(".")[0],
                                mi.materials[mi.polygons[ki[b]].material_index].name.split(".")[0]) for a, b in pairs})
                ys = [(obs[outer].matrix_world @ mo.vertices[mo.polygons[ko[a]].vertices[0]].co) for a, b in pairs[:200]]
                yl = sorted(c.z for c in ys)
                hits.append(f"{P['pose']}: {outer}/{inner} {len(pairs)} triangle pairs intersect {what} "
                            f"heights {yl[0]:.3f}..{yl[-1]:.3f}")
            # the inner shell's rim (and its tucked zone) in the outer's frame
            do, di = SHELLS[outer], SHELLS[inner]
            Mo = three_matrix(obs[outer]).inverted() @ three_matrix(obs[inner])
            cover = 1e9
            inside = 1e9
            for k in range(96):
                th = TAU * k / 96
                for uu in ((0.0, 0.08, 0.16) if rim == 0 else (1.0, 0.92, 0.86)):
                    p = Mo @ shell_point(di, uu, th, 0.0, lips=False)
                    # how far inside the outer's inner surface (positive: inside), where the outer is there
                    u_o = (p.y - do["y0"]) / (do["y1"] - do["y0"])
                    if not (0.0 <= u_o <= 1.0):
                        continue
                    ang = math.atan2(p.z - do["ZC"](u_o), p.x)
                    a = do["open"](u_o) if do.get("open") else 0.0
                    if a > 0.05 and abs(((ang + math.pi / 2 + math.pi) % TAU) - math.pi) < a:
                        continue  # in the outer's opening (seen through it, or behind its glass)
                    q = (abs(p.x) / (do["W"](u_o) / 2 - SHELL_T)) ** do["n"] + \
                        (abs(p.z - do["ZC"](u_o)) / (do["D"](u_o) / 2 - SHELL_T)) ** do["n"]
                    rr = math.hypot(p.x, p.z - do["ZC"](u_o))
                    inside = min(inside, (1 - q ** (1 / do["n"])) * rr)
                    if uu in (0.0, 1.0):
                        cover = min(cover, (do["y1"] - p.y) if rim == 0 else (p.y - do["y0"]))
            key = f"{outer}/{inner}"
            if cover < worst_cover.get(key, (1e9,))[0]:
                worst_cover[key] = (cover, P["pose"])
            if inside < worst_in.get(key, (1e9,))[0]:
                worst_in[key] = (inside, P["pose"])
    print(f"checked {len(poses)} poses")
    for key in worst_cover:
        c, cp = worst_cover[key]
        i, ip = worst_in[key]
        print(f"  {key}: rim covered by at least {c * 1000:.1f} mm ({cp}); inner shell at least {i * 1000:.1f} mm "
              f"inside the outer ({ip})")
    for h in hits[:20]:
        print("  INTERSECT", h)
    ok = not hits and all(v[0] > 0.004 for v in worst_cover.values()) and all(v[0] > 0.0 for v in worst_in.values())
    print("torso overlaps:", "OK" if ok else "FAIL")
    return ok


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = scene()
    if sc.world is None:
        sc.world = bpy.data.worlds.new("World")
    root = build_drummer()
    bpy.context.view_layer.update()
    objs = mesh_objects(root)
    if HAND_DETAIL < 1:
        for o in objs:
            if o.name[:2] in ("R_", "L_"):
                mod = o.modifiers.new("thin", "DECIMATE")
                mod.ratio = HAND_DETAIL
                mod.use_collapse_triangulate = True
                common.apply_modifiers(o)
                o.data.polygons.foreach_set("use_smooth", [True] * len(o.data.polygons))
                o.data.set_sharp_from_angle(angle=math.radians(40))
    print(f"objects: {len(objs)}  triangles: {tri_count(objs)}")
    if not os.environ.get("NO_BAKE"):
        spread_for_bake()
        hands = [o for o in objs if o.name[:2] in ("R_", "L_") or o.name.startswith("Stick")]
        body = [o for o in objs if o not in hands and o.name != "ChestLabel"]
        samples = int(os.environ.get("BAKE_SAMPLES", "32"))
        # the label floats a hair off the back: it must not shade the shell under it
        lab = bpy.data.objects.get("ChestLabel")
        if lab:
            lab.hide_render = True
        bake_masks(hands, distance=0.007, samples=samples)
        bake_masks(body, distance=0.02, samples=samples)
        if lab:
            lab.hide_render = False
        reset_rest()
    stick_wear([o for o in objs if o.name.startswith("Stick")])
    reset_rest()
    # export the rest pose (the rig poses everything): the drummer's hierarchy and nothing else
    bpy.ops.object.select_all(action="DESELECT")
    stack = [root]
    while stack:
        o = stack.pop()
        o.select_set(True)
        stack.extend(o.children)
    bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_apply=False,
                              export_yup=True, export_vertex_color="ACTIVE", export_all_vertex_colors=False,
                              export_normals=True, export_texcoords=True, export_materials="EXPORT",
                              export_extras=False, export_cameras=False, export_lights=False)
    print("wrote", OUT)
    if "--check-torso" in ARGS:
        ok = check_torso(ARGS[ARGS.index("--check-torso") + 1])
        reset_rest()
        if not ok:
            sys.exit(2)
    if POSE:
        apply_pose(POSE)
    if PREVIEW:
        preview(PREVIEW, root)


main()
