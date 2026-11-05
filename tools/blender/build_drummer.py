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
def build_pelvis(parent):
    shell, core, hw, glow = MB(), MB(), MB(), MB()
    # the pelvic shell wraps the back and sides, open at the front below the abdomen where the thighs leave
    W = lambda u: lerp(0.305, 0.262, smooth01(u))
    Dp = lambda u: lerp(0.205, 0.172, u)
    Z = lambda u: lerp(0.034, 0.052, u)
    pill(shell, "shell", 0.072, -0.108, W, Dp, n=2.6, e0=0.3, e1=0.0, th=(-0.62, math.pi + 0.62), yoff=Z, xf=xf_up(),
         nu=30, nv=72)
    pill(core, "graphite", 0.06, -0.10, lambda u: W(u) * 0.86, lambda u: Dp(u) * 0.82, n=2.8, e0=0.25, e1=0.0, yoff=Z,
         xf=xf_up(), nu=16, nv=40)
    # the belt: a chrome band along the top edge, a line of light below it
    ring_y(hw, 0.106, 0.133, 0.088, 0.0042, "chrome", cz=0.052)
    ring_y(glow, 0.094, 0.1355, 0.0905, 0.0011, "glow", cz=0.051)
    # the hip joints: chrome balls in graphite sockets, a ring of light on the outer cap
    for s in (1, -1):
        c = V(s * DS.HIP_HALF, 0.0, 0.0)
        sphere(core, 0.058, "graphite", 32, 16, center=tuple(c + V(s * 0.012, 0, 0.006)))
        ball_joint(hw, glow, 0.05, tr(*c), ring_axis=V(s, 0, 0), ring_at=0.62)
    return node("Pelvis", [(shell, {"solid": 0.004, "bevel": 0.0012, "bseg": 2}), (core, {}), (hw, {}), (glow, {})],
                off("Pelvis"), parent)


def spine_band(name, parent, y0, y1, w0, w1, d0, d1, top_band=False):
    """one segment of the abdomen: a porcelain band round the back and sides, glass over the lit spine
    mechanics at the front, a chrome vertebra at the joint"""
    shell, glass, core, hw, glow = MB(), MB(), MB(), MB(), MB()
    W = lambda u: lerp(w0, w1, u)
    Dd = lambda u: lerp(d0, d1, u)
    Z = -0.058
    pill(shell, "shell", -y0, -y1, W, Dd, n=2.6, e0=0, e1=0, th=(-0.75, math.pi + 0.75), yoff=Z, xf=xf_up(), nu=6,
         nv=64)
    pill(glass, "glass", -y0 - 0.004, -y1 + 0.004, lambda u: W(u) * 1.004, lambda u: Dd(u) * 1.004, n=2.6, e0=0,
         e1=0, th=(math.pi + 0.66, TAU - 0.66), yoff=Z, xf=xf_up(), nu=4, nv=32)
    # inside: a graphite column, chrome actuator rods and lines of light
    pill(core, "graphite", -y0 + 0.004, -y1 - 0.004, lambda u: W(u) * 0.62, lambda u: Dd(u) * 0.6, n=3.0, e0=0,
         e1=0, yoff=Z + 0.008, xf=xf_up(), nu=4, nv=32)
    for x in (-0.05, 0.05):
        cyl_z(hw, 0.0055, y0, y1, "chrome", 20, center=(x, 0.0), xf=tr(0, 0, Z - 0.052) @ rot_x(-math.pi / 2))
    for x in (-0.026, 0.0, 0.026):
        glow_line(glow, [V(x, y0 + 0.006, Z - 0.056), V(x, y1 - 0.006, Z - 0.056)], 0.0016)
    # the vertebra at this joint (its bottom), with a ring of light
    lathe(hw, [(0.0, 0.011), (0.03, 0.011), (0.034, 0.006), (0.034, -0.006), (0.03, -0.011), (0.0, -0.011)], "chrome",
          48, rot_x(math.pi / 2))
    torus_z(glow, 0.036, 0.0016, "glow", 72, 8, rot_x(math.pi / 2))
    cyl_z(core, 0.024, 0.0, y1, "graphite", 32, xf=rot_x(-math.pi / 2))
    parts = [(shell, {"solid": 0.0035, "bevel": 0.001}), (glass, {"solid": 0.0016, "bevel": 0.0005}), (core, {}),
             (hw, {}), (glow, {})]
    return node(name, parts, off(name), parent)


def build_chest(parent):
    shell, glass, core, hw, glow = MB(), MB(), MB(), MB(), MB()
    Z = -0.062

    def W(u):
        # waist to shoulders: out to the ribs, in to the shoulders' yoke
        return 0.262 + 0.05 * math.sin(math.pi * min(1.0, u * 1.05)) - 0.06 * smooth01((u - 0.7) / 0.3)

    def Dd(u):
        return 0.178 + 0.03 * math.sin(math.pi * u * 0.9) - 0.04 * smooth01((u - 0.72) / 0.28)

    y0, y1 = 0.0, 0.205
    win = 0.36
    pill(shell, "shell", -y0, -y1, W, Dd, n=2.5, e0=0, e1=0.2, th=(-math.pi / 2 + win, 3 * math.pi / 2 - win),
         yoff=Z, xf=xf_up(), nu=36, nv=80)
    pill(glass, "glass", -y0 - 0.006, -y1 + 0.004, lambda u: W(u) * 1.006, lambda u: Dd(u) * 1.006, n=2.5, e0=0,
         e1=0.2, th=(3 * math.pi / 2 - win - 0.05, 3 * math.pi / 2 + win + 0.05), yoff=Z, xf=xf_up(), nu=24, nv=24)
    pill(core, "graphite", -y0, -y1 + 0.01, lambda u: W(u) * 0.84, lambda u: Dd(u) * 0.8, n=2.8, e0=0, e1=0.18,
         yoff=Z + 0.006, xf=xf_up(), nu=16, nv=40)
    # the lit core behind the sternum: a ring of light round a chrome hub, lines of light up to the collar
    zc = Z - Dd(0.5) / 2 * 0.8 - 0.004
    for rr, mat, w in ((0.03, "glow", 0.0018), (0.022, "chrome", 0.003)):
        torus_z(glow if mat == "glow" else hw, rr, w, mat, 72, 8, tr(0, 0.11, zc))
    cyl_z(hw, 0.013, zc - 0.004, zc + 0.006, "chrome", 32, center=(0.0, 0.11))
    for x in (-0.012, 0.012):
        glow_line(glow, [V(x, 0.03, zc + 0.004), V(x * 0.6, 0.08, zc), V(x * 0.5, 0.14, zc + 0.002), V(x * 2.2, 0.185, zc + 0.02)])
    # a fine line of light round the ribs' lower edge
    pts = []
    for i in range(97):
        a = TAU * i / 96
        x, z = superellipse(a, W(0.03) / 2 * 1.003, Dd(0.03) / 2 * 1.003, 2.5)
        if abs(math.atan2(z, x) + math.pi / 2) < win:
            continue
        pts.append(V(x, 0.012, z + Z))
    glow_line(glow, pts, 0.0010)
    # the sternoclavicular joints
    for s in (1, -1):
        sphere(hw, 0.017, "chrome", 32, 16, center=tuple(V(*JS["ClavicleR"]["offset"]) * 1 if s > 0 else V(*JS["ClavicleL"]["offset"])))
    parts = [(shell, {"solid": 0.004, "bevel": 0.0012}), (glass, {"solid": 0.0018, "bevel": 0.0006}), (core, {}),
             (hw, {}), (glow, {})]
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
    prof = [(0.0, 0.07), *[(0.07 * math.sin(a), 0.07 * math.cos(a)) for a in [i * 0.115 for i in range(1, 14)]]]
    lathe(cap, prof, "shell", 64, orient(V(-0.45, -1, 0.05).normalized()) @ tr(0, 0, 0.0))
    shell.extend(cap, tr(0.006, 0.004, 0.0))
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
    """the maker's label, printed on the upper back: a thin curved decal with UVs"""
    Z = -0.062
    me = bpy.data.meshes.new("Label")
    verts, faces, uvs = [], [], []
    nu, nv = 24, 6
    w, h = 0.14, 0.0525
    yc = 0.135

    def back_z(x, y):
        # the chest's back surface (as build_chest's shell), a hair proud of it
        u = y / 0.205
        Wd = 0.262 + 0.05 * math.sin(math.pi * min(1.0, u * 1.05)) - 0.06 * smooth01((u - 0.7) / 0.3)
        Dd = 0.178 + 0.03 * math.sin(math.pi * u * 0.9) - 0.04 * smooth01((u - 0.72) / 0.28)
        a = Wd / 2
        b = Dd / 2
        t = min(0.999, abs(x) / a)
        return Z + b * (1 - t ** 2.5) ** (1 / 2.5) + 0.0004

    for j in range(nv + 1):
        for i in range(nu + 1):
            x = -w / 2 + w * i / nu
            y = yc - h / 2 + h * j / nv
            verts.append(to_blender(V(x, y, back_z(x, y))))
            uvs.append((1 - i / nu, j / nv))
    for j in range(nv):
        for i in range(nu):
            a = j * (nu + 1) + i
            faces.append((a, a + nu + 1, a + nu + 2, a + 1))
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
    s1 = spine_band("Spine1", pelvis, 0.012, 0.118, 0.272, 0.264, 0.18, 0.172)
    s2 = spine_band("Spine2", s1, 0.012, 0.122, 0.266, 0.27, 0.174, 0.18)
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
    shots = os.environ.get("PREVIEW_SHOTS", "full").split(",")
    views = {
        "full": (V(1.25, 1.35, -2.25), V(0.0, 0.82, -0.12), 42, None),
        "side": (V(-2.3, 1.1, -0.25), V(0.0, 0.78, -0.08), 50, None),
        "back": (V(0.9, 1.5, 1.9), V(0.0, 0.95, 0.0), 45, None),
        "head": (V(0.35, 1.48, -0.75), V(0.0, 1.36, 0.02), 75, None),
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
        bake_masks(hands, distance=0.007, samples=samples)
        bake_masks(body, distance=0.02, samples=samples)
        reset_rest()
    stick_wear([o for o in objs if o.name.startswith("Stick")])
    if POSE:
        apply_pose(POSE)
    if PREVIEW:
        preview(PREVIEW, root)
    reset_rest()
    # export the rest pose with the fingers as built (the rig poses everything)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=False, export_apply=False,
                              export_yup=True, export_vertex_color="ACTIVE", export_all_vertex_colors=False,
                              export_normals=True, export_texcoords=True, export_materials="EXPORT",
                              export_extras=False)
    print("wrote", OUT)


main()
