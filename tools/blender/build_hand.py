"""
The Mechanical Pianist: scripted Blender build of the robotic right hand.

    pip install bpy==5.2.3                 # Blender as a Python module
    python tools/blender/build_hand.py public/assets/robot_hand.glb [--preview out.png]

Every dimension comes from src/core/hand_spec.json, the same file the IK and
the fingering model read, so the rig the planner reasons about is the rig on
screen. Each articulated part is its own node with its origin on the joint
pivot; the left hand is this hand mirrored at runtime.

Design language: porcelain-white dorsal shells over a graphite inner frame;
narrow seams reveal chrome tendon rods; every joint is a chrome barrel whose
top is hooded by the parent segment's shell, cut high at the sides so the
pin caps show. Cyan light marks the knuckles (MCP), the middle joints (PIP),
the thumb base and the wrist. Fingertips end in a soft elastomer pad shaped as a sphere
of `tipRadius` around the IK's contact centre.

Node hierarchy (three.js names):
    Hand (wrist pivot)
      Forearm            aims at the elbow, mesh along +Z
      WristRing1/2       share the wrist rotation (a segmented spine)
      WristCore
      Palm
        F2_0 > F2_1 > F2_2 > F2_tip     index: MCP, PIP, DIP, tip centre
        F3_*, F4_*, F5_*
        T_0 > T_1 > T_2 > T_tip         thumb: CMC, MCP, IP, tip centre
"""

import json
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(__file__))
from common import (MB, TAU, V, box, bake_masks, cyl_x, cyl_z, export_glb, lathe, lerp, mesh_objects, node, pill,  # noqa: E402
                    scene, set_pose, sphere, tr, rot_x, rot_y, rot_z, torus_z, tri_count, tube, grid_surface, ALL)

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
SPEC = json.load(open(os.path.join(ROOT, "src", "core", "hand_spec.json")))
args = [a for a in sys.argv[1:]]
OUT = next((a for a in args if a.endswith(".glb")), os.path.join(ROOT, "public", "assets", "robot_hand.glb"))
PREVIEW = args[args.index("--preview") + 1] if "--preview" in args else None

SEAM = 0.0007


def m3(m4):
    return m4.to_3x3()


# -----------------------------------------------------------------------------
# Joint hardware
# -----------------------------------------------------------------------------
def barrel(mb, w, rb, band=False, side_glow=(False, False)):
    """Chrome joint barrel along X on the joint axis, almost the full width of
    the segment. Optional cyan band around its middle (knuckles) and cyan rings
    around the pin caps on its side faces."""
    hw = w / 2 - 0.0005
    m = MB()
    if band:
        g = 0.0010
        cyl_x(m, rb, -hw, -g, "chrome", 32, chamfer=0.0006)
        cyl_x(m, rb, g, hw, "chrome", 32, chamfer=0.0006)
        cyl_x(m, rb * 0.84, -g - 0.0003, g + 0.0003, "graphite", 32)
        cyl_x(m, rb * 0.93, -g * 0.6, g * 0.6, "glow", 32)
    else:
        cyl_x(m, rb, -hw, hw, "chrome", 32, chamfer=0.0006)
    for s, glow in ((-1, side_glow[0]), (1, side_glow[1])):
        face = s * hw
        # recessed graphite ring, then the pin cap proud of the face
        x0, x1 = (face - 0.0002, face + 0.0001) if s > 0 else (face - 0.0001, face + 0.0002)
        lathe(m, [(rb * 0.50, x1), (rb * 0.80, x1), (rb * 0.80, x0), (rb * 0.50, x0), (rb * 0.50, x1)], "glow" if glow else "graphite", 32,
              rot_y(math.pi / 2))
        cx0, cx1 = (face - 0.0002, face + 0.00045) if s > 0 else (face - 0.00045, face + 0.0002)
        cyl_x(m, rb * 0.44, cx0, cx1, "chrome", 24, chamfer=0.0002)
    mb.extend(m)


# -----------------------------------------------------------------------------
# Phalanges
# -----------------------------------------------------------------------------
def phalanx(name, f, k, parent, pos, is_thumb=False):
    """Segment k of finger spec f, origin on its proximal joint. The dorsal
    shell's distal end becomes a hood over the next joint's barrel, cut high at
    the sides so the barrel's lit pin caps show."""
    L = f["segments"][k]
    w = f["widths"][k]
    h = f["heights"][k]
    last = k == 2
    rt = f["tipRadius"]
    w2 = f["widths"][k + 1] if not last else 2 * rt
    h2 = f["heights"][k + 1] if not last else 2 * rt
    rb = 0.38 * h
    rb2 = 0.38 * h2
    shell, pad, core, hw, glow, tend = MB(), MB(), MB(), MB(), MB(), MB()

    if is_thumb and k == 0:
        # CMC: a chrome ball socket with a light ring around the thumb's axis
        sphere(hw, 0.0092, "chrome", 32, 16)
        torus_z(glow, 0.0099, 0.0008, "glow", 48, 8, tr(0, 0, -0.0036))
        torus_z(hw, 0.0102, 0.0012, "graphite", 48, 8, tr(0, 0, -0.0055))
        z0 = -0.0058
    else:
        joint = ["mcp", "pip", "dip"][k] if not is_thumb else ["cmc", "mcp", "ip"][k]
        band = joint == "mcp" and not is_thumb
        side = joint in ("pip",) or (is_thumb and joint == "mcp")
        idx_side = (f.get("id") == 2, f.get("id") == 5)  # outer knuckles of the hand glow on their open side
        side_glow = (side, side) if side else ((idx_side[0], idx_side[1]) if joint == "mcp" else (False, False))
        barrel(hw, w, rb, band=band, side_glow=side_glow)
        z0 = -(rb + 0.0009)
    wf = lambda u: lerp(w, w2, u)
    hf = lambda u: lerp(h, h2, u)
    if last:
        z1 = -(L + rt)
        e1 = rt / abs(z1 - z0)
        # distal: a tapering porcelain nail-shell above, an elastomer pad that
        # wraps the rounded tip below; rounder toward the tip
        n_of = lambda u: 2.4 - 0.4 * max(0.0, (u - 0.4) / 0.6)
        wt = lambda u: lerp(w, 2 * rt, min(1.0, u * 1.15)) * (1 - 0.05 * math.sin(math.pi * min(1.0, u * 1.15)))
        ht = lambda u: lerp(h, 2 * rt, min(1.0, u * 1.15))
        pill(shell, "shell", z0, z1, wt, ht, n=n_of, e0=0.14, e1=e1, th=(-0.42, math.pi + 0.42), nu=36, nv=30)
        pill(pad, "rubber", z0 - 0.0008, z1, lambda u: wt(u) * 0.965, lambda u: ht(u) * 0.99, n=n_of, e0=0.12, e1=e1,
             th=(math.pi + 0.56, TAU - 0.56), nu=36, nv=14)
    else:
        z1 = -(L - 0.0003)

        def th_of(u):
            q = max(0.0, (u - 0.62) / 0.38)
            q = q * q * (3 - 2 * q)
            return (lerp(-0.5, 0.5, q), lerp(math.pi + 0.5, math.pi - 0.5, q))

        pill(shell, "shell", z0, z1, wf, lambda u: hf(u) * (1 + 0.06 * u), n=2.8, e0=0.16, e1=0.0, th=th_of,
             nu=34, nv=30, yoff=lambda u: 0.0006 * u)
        pill(pad, "shell", z0 - 0.0012, -(L - rb2 - 0.0014), lambda u: wf(u) * 0.92, lambda u: hf(u) * 0.985, n=2.8,
             e0=0.22, e1=0.22, th=(math.pi + 0.95, TAU - 0.95), nu=24, nv=12)
        for s in (-1, 1):  # tendon rods through the side seams
            cyl_z(tend, 0.00042, z0 - 0.0004, -(L - rb2 - 0.0008), "chrome", 8, center=(s * w * 0.35, -h * 0.25))
    # graphite inner frame, its ends buried in the barrels
    pill(core, "graphite", -rb * 0.4, (-(L + rt * 0.1) if last else -(L - rb2 * 0.4)), lambda u: wf(u) * 0.64,
         lambda u: hf(u) * 0.6, n=3.6, e0=0.08, e1=0.12, yoff=-h * 0.04, nu=16, nv=24)
    parts = [(shell, {"solid": 0.0010, "bevel": 0.0003, "bseg": 2}),
             (pad, {"solid": 0.0009, "bevel": 0.00028, "bseg": 2}),
             (core, {}), (hw, {}), (glow, {}), (tend, {})]
    return node(name, parts, pos, parent)


# -----------------------------------------------------------------------------
# Palm
# -----------------------------------------------------------------------------
FINGERS = SPEC["fingers"]
THUMB = SPEC["thumb"]


def knuckle_line():
    """Quadratic z(x) through the index, middle and little MCP centres."""
    pts = [(FINGERS[0]["mcp"][0], FINGERS[0]["mcp"][2]), (FINGERS[1]["mcp"][0], FINGERS[1]["mcp"][2]),
           (FINGERS[3]["mcp"][0], FINGERS[3]["mcp"][2])]
    (x0, z0), (x1, z1), (x2, z2) = pts
    d = (x0 - x1) * (x0 - x2) * (x1 - x2)
    A = (x2 * (z1 - z0) + x1 * (z0 - z2) + x0 * (z2 - z1)) / d
    B = (x2 * x2 * (z0 - z1) + x1 * x1 * (z2 - z0) + x0 * x0 * (z1 - z2)) / d
    Cc = (x1 * x2 * (x1 - x2) * z0 + x2 * x0 * (x2 - x0) * z1 + x0 * x1 * (x0 - x1) * z2) / d
    return lambda x: A * x * x + B * x + Cc


def build_palm(parent):
    zk = knuckle_line()
    shells, core, hw, pad, collar, rods, thenar = MB(), MB(), MB(), MB(), MB(), MB(), MB()
    xa_w, xb_w = -0.0285, 0.0335  # palm edges at the wrist end
    xa_k, xb_k = -0.0405, 0.0475  # and at the knuckles
    z_w = -0.0150

    # three dorsal panels separated by seams that follow the metacarpals
    def dorsal(u, v):
        # u: wrist -> knuckles, v: thumb side -> ulnar side
        xa = lerp(xa_w, xa_k, u)
        xb = lerp(xb_w, xb_k, u)
        xc = (xa + xb) / 2
        a = (xb - xa) / 2
        ang = math.pi + 0.22 - (math.pi + 0.44) * v
        c, s = math.cos(ang), math.sin(ang)
        n = 2.5
        x = xc + a * math.copysign(abs(c) ** (2 / n), c)
        dome = lerp(0.0112, 0.0104, u)
        y = 0.0012 + dome * math.copysign(abs(s) ** (2 / n), s)
        # the panel ends follow the knuckle arc, scalloped over each knuckle
        zend = zk(x) + 0.0042
        sc = 0.0
        for f in FINGERS:
            d = (x - f["mcp"][0]) / 0.0085
            sc += 0.0028 * math.exp(-d * d)
        zend -= sc
        z = lerp(z_w, zend, u)
        # the back of the hand arches: high over the metacarpals, falling to the wrist
        y += 0.0030 * math.sin(math.pi * min(1.0, u * 0.9)) - 0.0010 * (1 - u) ** 2
        # metacarpal ridges, very soft
        for f in FINGERS:
            d = (x - lerp(f["mcp"][0] * 0.45, f["mcp"][0], u)) / 0.006
            y += 0.0006 * u * math.exp(-d * d)
        return V(x, y, z)

    def patch(v0, v1, nv):
        def surf(u, v):
            p = dorsal(u, v0 + (v1 - v0) * v)
            e = 1e-3
            pu = dorsal(min(1, u + e), v0 + (v1 - v0) * v) - dorsal(max(0, u - e), v0 + (v1 - v0) * v)
            pv = dorsal(u, min(1, v0 + (v1 - v0) * v + e)) - dorsal(u, max(0, v0 + (v1 - v0) * v - e))
            nrm = pv.cross(pu).normalized()
            if nrm.y < 0 and abs(nrm.y) > 0.3:
                nrm = -nrm
            # outward from the palm's centre line
            centre = V((xa_w + xb_w) / 2, -0.004, p.z)
            if nrm.dot(p - centre) < 0:
                nrm = -nrm
            return p, nrm
        from common import thick_patch
        thick_patch(shells, surf, 30, nv, 0.0013, "shell", "shell_inner")

    patch(0.0, 0.285, 10)
    patch(0.295, 0.705, 16)
    patch(0.715, 1.0, 10)

    # graphite body under the panels
    pill(core, "graphite", -0.004, -0.088, lambda u: lerp(0.058, 0.080, u), 0.024, n=3.4, e0=0.06, e1=0.08,
         yoff=-0.0025, xoff=lambda u: lerp(0.0025, 0.0035, u), nu=18, nv=28)
    # palmar plate
    pill(pad, "shell", -0.020, -0.084, lambda u: lerp(0.062, 0.078, u), 0.036, n=2.6, e0=0.18, e1=0.25,
         th=(math.pi + 0.55, TAU - 0.55), yoff=0.0, xoff=0.004, nu=24, nv=18)
    # tendon guides fanning from the wrist to each finger
    for f in FINGERS:
        m = f["mcp"]
        tube(rods, [V(m[0] * 0.35 + 0.002, -0.0125, -0.012), V(m[0] * 0.8, -0.0135, -0.05), V(m[0], -0.0105, m[2] + 0.006)],
             0.0006, "chrome", 8)
    # knuckle bar behind the MCP joints
    xs = [xa_k + 0.003 + (xb_k - xa_k - 0.006) * i / 24 for i in range(25)]
    tube(hw, [V(x, 0.0006, zk(x) + 0.0068) for x in xs], 0.0042, "steel", 16)
    # thumb-side socket for the CMC, and a thenar fairing that carries the
    # palm's surface down toward the thumb
    tc = THUMB["cmc"]
    sphere(hw, 0.0112, "graphite", 24, 12, center=tuple(tc))
    pill(thenar, "shell", -0.004, -0.050, lambda u: lerp(0.020, 0.016, u), lambda u: lerp(0.026, 0.018, u), n=2.4,
         e0=0.25, e1=0.35, th=(math.pi * 0.55, math.pi * 1.6), xoff=lambda u: lerp(-0.0215, -0.030, u),
         yoff=lambda u: lerp(-0.004, -0.004, u), nu=24, nv=20)
    # wrist collar
    pill(collar, "shell", 0.0035, -0.022, lambda u: lerp(0.058, 0.064, u), lambda u: lerp(0.036, 0.034, u), n=2.6,
         e0=0, e1=0, xoff=0.0025, yoff=-0.002, nu=8, nv=40, th=(0, TAU))
    parts = [(shells, {"bevel": 0.00045, "bseg": 2, "recalc": False}), (core, {}), (pad, {"solid": 0.0012, "bevel": 0.0004}),
             (rods, {}), (hw, {}), (thenar, {"solid": 0.0014, "bevel": 0.0004}), (collar, {"solid": 0.0016, "bevel": 0.0005})]
    return node("Palm", parts, V(0, 0, 0), parent)


# -----------------------------------------------------------------------------
# Wrist and forearm
# -----------------------------------------------------------------------------
def ellipse_torus(mb, cx, cy, z, ax, ay, r, mat, segs=64, rsegs=8):
    """Thin torus around the Z axis, stretched to an ellipse (ax, ay)."""
    t = MB()
    torus_z(t, 1.0, r, mat, segs, rsegs)
    xf = tr(cx, cy, z) @ Matrix.Diagonal((ax, ay, 1.0, 1.0))
    t.v = [xf @ p for p in t.v]
    mb.extend(t)


def build_wrist(parent):
    core, glow = MB(), MB()
    # chrome universal-joint housing, ringed with light where the hand meets the arm
    pill(core, "chrome", 0.012, -0.010, 0.050, 0.030, n=2.4, e0=0.35, e1=0.35, nu=20, nv=36, xoff=0.0025, yoff=-0.002)
    ellipse_torus(glow, 0.0025, -0.002, 0.004, 0.0262, 0.0162, 0.0009, "glow")
    wc = node("WristCore", [(core, {}), (glow, {})], V(0, 0, 0), parent)
    rings = []
    for i, z in enumerate((0.0135, 0.0215)):
        band = MB()
        pill(band, "steel", z + 0.0032, z - 0.0032, 0.056 + 0.004 * i, 0.035 + 0.003 * i, n=2.4, e0=0, e1=0,
             xoff=0.0025, yoff=-0.002, nu=4, nv=48)
        edge = MB()
        for zz in (z + 0.0033, z - 0.0033):
            ellipse_torus(edge, 0.0025, -0.002, zz, 0.0282 + 0.002 * i, 0.0177 + 0.0015 * i, 0.0009, "chrome")
        rings.append(node(f"WristRing{i + 1}", [(band, {"solid": 0.002, "bevel": 0.0005}), (edge, {})], V(0, 0, 0), parent))
    return wc, rings


def build_forearm(parent):
    fa = SPEC["forearm"]
    L = fa["length"]
    z0, z1 = 0.026, L
    a0, b0 = fa["wristRadius"]
    a1, b1 = fa["elbowRadius"]
    wf = lambda u: 2 * lerp(a0, a1, u ** 0.8)
    hf = lambda u: 2 * lerp(b0, b1, u ** 0.8)
    dorsal, side, ventral, core, hw, glow = MB(), MB(), MB(), MB(), MB(), MB()
    X = lambda u: 0.0025
    Y = lambda u: -0.002 + 0.004 * u
    # note: pill runs along -Z; build along -Z then mirror z -> -z
    def P(mb, mat, th, scale=1.0, e0=0.05, nv=24):
        pill(mb, mat, -z0, -z1, lambda u: wf(u) * scale, lambda u: hf(u) * scale, n=2.4, e0=e0, e1=0, th=th,
             xoff=X, yoff=Y, nu=40, nv=nv)
    P(dorsal, "shell", (0.42, math.pi - 0.42), nv=28)
    P(side, "shell", (-0.62, 0.36), nv=14)
    P(side, "shell", (math.pi - 0.36, math.pi + 0.62), nv=14)
    P(ventral, "graphite", (math.pi + 0.7, TAU - 0.7), 0.985, nv=16)
    P(core, "graphite", (0, TAU), 0.9, e0=0.02, nv=28)
    # pistons and cables underneath
    for s in (-1, 1):
        cyl_z(hw, 0.0042, -0.06, -0.30, "chrome", 20, center=(0.0025 + s * 0.012, -0.002 - b0 * 0.92), chamfer=0.0006)
        cyl_z(hw, 0.0052, -0.045, -0.07, "graphite", 20, center=(0.0025 + s * 0.012, -0.002 - b0 * 0.92))
        tube(hw, [V(0.0025 + s * 0.021, -0.002 - b0 * 0.7 - 0.003 * k, -0.04 - 0.27 * k / 8) for k in range(9)], 0.0011,
             "steel", 8)
    # wrist collar and a thin seam of light along the outer side
    ellipse_torus(hw, 0.0025, -0.002, -0.0275, 0.0305, 0.0222, 0.0021, "chrome", 64, 10)
    tube(glow, [V(0.0025 + lerp(a0, a1, (k / 20) ** 0.8) * 0.985 * math.cos(0.39), -0.002 + lerp(b0, b1, (k / 20) ** 0.8) * 0.985 * math.sin(0.39) ** (2 / 2.4),
                  -(0.07 + 0.2 * k / 20)) for k in range(21)], 0.0006, "glow", 6)
    parts = []
    for mb, o in ((dorsal, {"solid": 0.0018, "bevel": 0.0005}), (side, {"solid": 0.0018, "bevel": 0.0005}),
                  (ventral, {"solid": 0.0015}), (core, {}), (hw, {}), (glow, {})):
        # flip z: the forearm extends toward +Z (back toward the elbow)
        flipped = MB()
        for p in mb.v:
            flipped.v.append(V(p.x, p.y, -p.z))
        for f, m in zip(mb.f, mb.fm):
            flipped.f.append(tuple(reversed(f)))
            flipped.fm.append(m)
        parts.append((flipped, o))
    return node("Forearm", parts, V(0, 0, 0), parent)


# -----------------------------------------------------------------------------
# Assembly
# -----------------------------------------------------------------------------
def flexm(a):
    return rot_x(-a).to_3x3()


def build_hand():
    hand = node("Hand", None, V(0, 0, 0))
    forearm = build_forearm(hand)
    wrist, rings = build_wrist(hand)
    palm = build_palm(hand)
    fingers = []
    for f in FINGERS:
        fid = f["id"]
        p0 = phalanx(f"F{fid}_0", f, 0, palm, V(*f["mcp"]))
        p1 = phalanx(f"F{fid}_1", f, 1, p0, V(0, 0, -f["segments"][0]))
        p2 = phalanx(f"F{fid}_2", f, 2, p1, V(0, 0, -f["segments"][1]))
        tip = node(f"F{fid}_tip", None, V(0, 0, -f["segments"][2]), p2)
        fingers.append((f, p0, p1, p2))
    t = THUMB
    base = (rot_y(t["baseYaw"]) @ rot_x(t["basePitch"]) @ rot_z(t["opposition"])).to_3x3()
    t0 = phalanx("T_0", t, 0, palm, V(*t["cmc"]), is_thumb=True)
    t1 = phalanx("T_1", t, 1, t0, V(0, 0, -t["segments"][0]), is_thumb=True)
    t2 = phalanx("T_2", t, 2, t1, V(0, 0, -t["segments"][1]), is_thumb=True)
    node("T_tip", None, V(0, 0, -t["segments"][2]), t2)
    return hand, forearm, palm, fingers, (t0, t1, t2), base


def pose_rest(fingers, thumb, base):
    for f, p0, p1, p2 in fingers:
        a, b, c = f["rest"]
        set_pose(p0, V(*f["mcp"]), (rot_y(f["baseYaw"] + f["restAbduction"]).to_3x3() @ flexm(a)))
        set_pose(p1, V(0, 0, -f["segments"][0]), flexm(b))
        set_pose(p2, V(0, 0, -f["segments"][1]), flexm(c))
    t = THUMB
    t0, t1, t2 = thumb
    sw, a, b, c = t["rest"]
    set_pose(t0, V(*t["cmc"]), rot_y(sw).to_3x3() @ base @ flexm(a))
    set_pose(t1, V(0, 0, -t["segments"][0]), flexm(b))
    set_pose(t2, V(0, 0, -t["segments"][1]), flexm(c))


def preview(path, hand):
    """Studio render of the hand at rest, over a key-like surface."""
    from common import get_mat, to_blender
    sc = scene()
    hand.matrix_basis = Matrix.Translation(to_blender(V(0, 0.062, 0.0)))
    me = bpy.data.meshes.new("floor")
    s = 0.6
    me.from_pydata([(-s, -s, 0), (s, -s, 0), (s, s, 0), (-s, s, 0)], [], [(0, 1, 2, 3)])
    fl = bpy.data.objects.new("floor", me)
    mat = bpy.data.materials.new("floor_mat")
    mat.use_nodes = True
    mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.75, 0.7, 0.6, 1)
    mat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.35
    me.materials.append(mat)
    sc.collection.objects.link(fl)
    cam_data = bpy.data.cameras.new("cam")
    cam_data.lens = 85
    cam = bpy.data.objects.new("cam", cam_data)
    sc.collection.objects.link(cam)
    shots = [
        ("", to_blender(V(0.30, 0.20, -0.30)), to_blender(V(0.0, 0.03, -0.09)), 50),
        ("_close", to_blender(V(0.16, 0.045, -0.20)), to_blender(V(0.0, 0.025, -0.13)), 70),
        ("_top", to_blender(V(-0.05, 0.42, -0.12)), to_blender(V(0.0, 0.0, -0.09)), 60),
        ("_thumb", to_blender(V(-0.30, 0.10, -0.26)), to_blender(V(-0.02, 0.02, -0.08)), 60),
    ]
    sc.camera = cam
    for (x, y, z, e, size, col) in ((-0.6, 0.6, 0.5, 60, 0.6, (1.0, 0.85, 0.7)), (0.5, -0.3, 0.4, 12, 0.8, (0.7, 0.8, 1.0))):
        ld = bpy.data.lights.new(f"l{x}", "AREA")
        ld.energy = e
        ld.size = size
        ld.color = col
        lo = bpy.data.objects.new(f"l{x}", ld)
        lo.location = (x, y, z)
        dd = (Vector((0, 0, 0.05)) - lo.location).normalized()
        lo.rotation_euler = dd.to_track_quat("-Z", "Y").to_euler()
        sc.collection.objects.link(lo)
    sc.world.color = (0.02, 0.022, 0.025)
    sc.render.engine = "CYCLES"
    sc.cycles.samples = int(os.environ.get("PREVIEW_SAMPLES", "48"))
    sc.cycles.use_denoising = True
    sc.render.resolution_x = int(os.environ.get("PREVIEW_W", "960"))
    sc.render.resolution_y = int(os.environ.get("PREVIEW_H", "640"))
    sc.render.filepath = path
    # emissive rings glow in the preview too
    g = bpy.data.materials.get("glow")
    if g:
        g.node_tree.nodes["Principled BSDF"].inputs["Emission Strength"].default_value = 6.0
    for suffix, loc, target, lens in shots:
        if suffix and not os.environ.get("PREVIEW_ALL"):
            continue
        cam.location = loc
        cam_data.lens = lens
        d = (target - loc).normalized()
        cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
        sc.render.filepath = path.replace(".png", suffix + ".png")
        bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(fl)
    bpy.data.objects.remove(cam)
    hand.matrix_basis = Matrix()


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = scene()
    if sc.world is None:
        sc.world = bpy.data.worlds.new("World")
    hand, forearm, palm, fingers, thumb, base = build_hand()
    pose_rest(fingers, thumb, base)
    bpy.context.view_layer.update()
    objs = mesh_objects(hand)
    print(f"objects: {len(objs)}  triangles: {tri_count(objs)}")
    if not os.environ.get("NO_BAKE"):
        bake_masks(objs, distance=0.007, samples=int(os.environ.get("BAKE_SAMPLES", "32")))
    if PREVIEW:
        preview(PREVIEW, hand)
    export_glb(OUT)
    print("wrote", OUT)


main()
