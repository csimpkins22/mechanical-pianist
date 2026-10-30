"""
The Mechanical Pianist: scripted Blender build of the upright piano's case.

    python tools/blender/build_piano.py public/assets/piano_case.glb [--preview out.png]

An older upright in near-black lacquered walnut: key slip, scrolled cheek
blocks on turned console legs, a nameboard with gilt lettering above a strip
of burgundy key felt, the folded fallboard, a music desk, panelled upper and
lower fronts, side panels, a moulded lid, brass candle sconces and pedals.

The 88 keys are not here: they are built in three.js from the shared keyboard
layout (src/core/keyboard.ts) so every key sits exactly where the fingering
model and the IK expect it. Coordinates match that file: white key tops at
y = 0, their front edges at z = 0, the keyboard centred on x = 0, the floor at
y = -0.72.
"""

import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(__file__))
from common import (MB, TAU, V, box, bake_masks, cyl_z, export_glb, lathe, lerp, mesh_objects, node, scene,  # noqa: E402
                    sphere, tr, rot_x, rot_y, tri_count, tube, torus_z)

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
args = sys.argv[1:]
OUT = next((a for a in args if a.endswith(".glb")), os.path.join(ROOT, "public", "assets", "piano_case.glb"))
PREVIEW = args[args.index("--preview") + 1] if "--preview" in args else None

KB = 52 * 0.0235 / 2  # half keyboard width, 0.611
ARM_W = 0.078
CASE_X = KB + ARM_W + 0.002  # outer face of the arms
FLOOR = -0.72
FRONT = -0.212  # front plane of the upper cabinet


def extrude_profile_x(mb, prof, x0, x1, mat):
    """Closed (z, y) profile extruded along X from x0 to x1."""
    n = len(prof)
    a = [mb.vert(V(x0, y, z)) for (z, y) in prof]
    b = [mb.vert(V(x1, y, z)) for (z, y) in prof]
    for i in range(n):
        j = (i + 1) % n
        mb.face([a[i], b[i], b[j], a[j]], mat)
    cz = sum(p[0] for p in prof) / n
    cy = sum(p[1] for p in prof) / n
    ca, cb = mb.vert(V(x0, cy, cz)), mb.vert(V(x1, cy, cz))
    for i in range(n):
        j = (i + 1) % n
        mb.face([ca, a[j], a[i]], mat)
        mb.face([cb, b[i], b[j]], mat)


def arc(cz, cy, r, a0, a1, n=12):
    return [(cz + r * math.cos(a0 + (a1 - a0) * i / n), cy + r * math.sin(a0 + (a1 - a0) * i / n)) for i in range(n + 1)]


def raised_panel(mb, x0, x1, y0, y1, z_front, depth, frame=0.045, mat="lacquer"):
    """A frame-and-panel front: four rails plus a slightly proud field."""
    t = 0.008
    box(mb, (x1 - x0, frame, depth), ((x0 + x1) / 2, y1 - frame / 2, z_front - depth / 2), mat)
    box(mb, (x1 - x0, frame, depth), ((x0 + x1) / 2, y0 + frame / 2, z_front - depth / 2), mat)
    box(mb, (frame, y1 - y0 - 2 * frame, depth), (x0 + frame / 2, (y0 + y1) / 2, z_front - depth / 2), mat)
    box(mb, (frame, y1 - y0 - 2 * frame, depth), (x1 - frame / 2, (y0 + y1) / 2, z_front - depth / 2), mat)
    inset = 0.012
    box(mb, (x1 - x0 - 2 * frame - 2 * inset, y1 - y0 - 2 * frame - 2 * inset, depth - t),
        ((x0 + x1) / 2, (y0 + y1) / 2, z_front - depth / 2 - t / 2 + 0.002), mat)
    box(mb, (x1 - x0 - 2 * frame + 0.002, y1 - y0 - 2 * frame + 0.002, depth - t - 0.004),
        ((x0 + x1) / 2, (y0 + y1) / 2, z_front - depth / 2 - t), mat)


def gilt_text(text, size, pos, font_path=None, extrude=0.0002):
    """Text as a mesh lying on a vertical board facing +Z (three space)."""
    bpy.ops.object.text_add()
    ob = bpy.context.object
    ob.data.body = text
    ob.data.size = size
    ob.data.align_x = "CENTER"
    ob.data.align_y = "CENTER"
    ob.data.extrude = extrude
    if font_path and os.path.exists(font_path):
        ob.data.font = bpy.data.fonts.load(font_path)
    bpy.ops.object.convert(target="MESH")
    me = ob.data
    mb = MB()
    # blender text lies in the XY plane facing +Z (blender); in three space a
    # vertical board facing the player is the XY plane facing +Z: x->x, y->y
    for v in me.vertices:
        mb.v.append(V(pos[0] + v.co.x, pos[1] + v.co.y, pos[2] + v.co.z))
    for p in me.polygons:
        mb.f.append(tuple(p.vertices))
        mb.fm.append("gold_leaf")
    bpy.data.objects.remove(ob)
    return mb


def baluster(mb, x, z, y0, y1, mat="lacquer"):
    """A turned console leg from y0 (floor) to y1."""
    H = y1 - y0
    prof = [(0.0, 1.0), (0.032, 1.0), (0.034, 0.985), (0.03, 0.97), (0.024, 0.95), (0.028, 0.90), (0.022, 0.86),
            (0.018, 0.80), (0.017, 0.62), (0.022, 0.52), (0.034, 0.36), (0.040, 0.26), (0.036, 0.19), (0.026, 0.15),
            (0.022, 0.12), (0.03, 0.09), (0.034, 0.06), (0.034, 0.02), (0.03, 0.0), (0.0, 0.0)]
    # lathe works around Z: rotate so the axis is +Y
    pts = [(r, y0 + H * t) for (r, t) in prof]
    lathe(mb, [(r, yy) for (r, yy) in pts], mat, 28, tr(x, 0, z) @ rot_x(-math.pi / 2))


def build():
    case = node("PianoCase", None, V(0, 0, 0))

    # --- key slip: the rail in front of the keys --------------------------
    ks = MB()
    prof = [(0.004, -0.074), (0.026, -0.074)] + arc(0.019, -0.020, 0.007, -math.pi / 2 + 0.6, math.pi / 2, 8) + \
           [(0.004, -0.0128)]
    prof = [(0.004, -0.074), (0.024, -0.074), (0.026, -0.070), (0.026, -0.024), (0.0245, -0.0165), (0.020, -0.0128),
            (0.004, -0.0128)]
    extrude_profile_x(ks, prof, -KB - 0.001, KB + 0.001, "lacquer")
    node("KeySlip", [(ks, {"bevel": 0.0018, "bseg": 3})], V(0, 0, 0), case)

    # --- keybed, key frame cavity -------------------------------------------
    kb = MB()
    box(kb, (2 * KB, 0.022, 0.42), (0, -0.087, -0.19), "lacquer")
    box(kb, (2 * KB, 0.006, 0.40), (0, -0.034, -0.18), "cloth")  # key frame cloth, seen between keys
    node("Keybed", [(kb, {"bevel": 0.002, "bseg": 2})], V(0, 0, 0), case)

    # --- cheek blocks (arms), each a scrolled profile ----------------------
    for s in (-1, 1):
        arm = MB()
        prof = [(0.032, -0.086), (0.032, -0.034)]
        prof += arc(0.0, -0.034, 0.032, 0.0, math.pi / 2, 10)  # rounded front-top, to (0, -0.002)
        prof = [(0.030, -0.088), (0.030, 0.006)] + arc(-0.006, 0.006, 0.036, 0.0, math.pi * 0.5, 12)[1:] + \
               [(-0.06, 0.042), (-0.12, 0.045), (-0.17, 0.048), (FRONT + 0.004, 0.05), (FRONT + 0.004, -0.088)]
        x0, x1 = (KB + 0.001, KB + 0.001 + ARM_W) if s > 0 else (-KB - 0.001 - ARM_W, -KB - 0.001)
        extrude_profile_x(arm, prof, x0, x1, "lacquer")
        node(f"Arm{'R' if s > 0 else 'L'}", [(arm, {"bevel": 0.004, "bseg": 4})], V(0, 0, 0), case)
        leg = MB()
        baluster(leg, s * (KB + ARM_W / 2), 0.004, FLOOR + 0.03, -0.088)
        box(leg, (ARM_W, 0.03, 0.09), (s * (KB + ARM_W / 2), FLOOR + 0.015, -0.01), "lacquer")
        node(f"Leg{'R' if s > 0 else 'L'}", [(leg, {"bevel": 0.002, "bseg": 2})], V(0, 0, 0), case)

    # --- nameboard, felt, folded fallboard ---------------------------------
    nb = MB()
    prof = [(-0.1525, -0.006), (-0.1525, 0.060)] + arc(-0.1625, 0.060, 0.010, 0.0, math.pi * 0.5, 8)[1:] + \
           [(-0.185, 0.070), (-0.185, -0.006)]
    extrude_profile_x(nb, prof, -KB - 0.001, KB + 0.001, "lacquer")
    fb = MB()  # the fallboard folded back, its rounded lip on top
    prof = [(-0.150, 0.078)] + arc(-0.163, 0.081, 0.013, 0.0, math.pi * 0.95, 10)[1:] + \
           [(-0.215, 0.118), (-0.226, 0.112), (-0.18, 0.068), (-0.152, 0.068)]
    extrude_profile_x(fb, prof, -KB - 0.001, KB + 0.001, "lacquer")
    felt = MB()
    box(felt, (2 * KB, 0.009, 0.0026), (0, 0.0035, -0.1512), "felt")
    gl = gilt_text("Halloran & Vey", 0.017, (0, 0.034, -0.1524), "/usr/share/fonts/truetype/liberation/LiberationSerif-Italic.ttf")
    gl2 = gilt_text("LONDON", 0.0055, (0, 0.019, -0.1524), "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf")
    line = MB()
    for y in (0.0105, 0.0115):
        pass
    box(line, (2 * KB - 0.02, 0.0007, 0.0003), (0, 0.0115, -0.1523), "gold_leaf")
    node("Nameboard", [(nb, {"bevel": 0.0025, "bseg": 3}), (fb, {"bevel": 0.002, "bseg": 3}), (felt, {"bevel": 0.0006, "bseg": 2}),
                       (gl, {"recalc": False}), (gl2, {"recalc": False}), (line, {})], V(0, 0, 0), case)

    # --- music desk and upper panel ------------------------------------------
    up = MB()
    raised_panel(up, -KB - 0.001, KB + 0.001, 0.118, 0.52, FRONT, 0.024)
    desk = MB()
    prof = [(FRONT, 0.118), (FRONT + 0.05, 0.122), (FRONT + 0.056, 0.13), (FRONT + 0.056, 0.142), (FRONT + 0.05, 0.146),
            (FRONT, 0.146)]
    extrude_profile_x(desk, prof, -KB + 0.06, KB - 0.06, "lacquer")
    node("UpperPanel", [(up, {"bevel": 0.0025, "bseg": 3}), (desk, {"bevel": 0.003, "bseg": 3})], V(0, 0, 0), case)

    # --- side panels, lid, lower front, plinth --------------------------------
    sides = MB()
    for s in (-1, 1):
        x = s * (CASE_X - 0.011)
        box(sides, (0.022, 0.545 - FLOOR, 0.44), (x, (0.545 + FLOOR) / 2, FRONT - 0.20), "lacquer")
        # a pilaster where the side panel meets the front
        box(sides, (0.03, 0.42, 0.03), (s * (CASE_X - 0.015), 0.33, FRONT - 0.005), "lacquer")
    lid = MB()
    box(lid, (2 * CASE_X + 0.03, 0.022, 0.475), (0, 0.556, FRONT - 0.205), "lacquer")
    box(lid, (2 * CASE_X + 0.012, 0.018, 0.46), (0, 0.537, FRONT - 0.205), "lacquer")
    low = MB()
    raised_panel(low, -KB - 0.001, KB + 0.001, FLOOR + 0.06, -0.098, -0.13, 0.022, frame=0.05)
    pl = MB()
    box(pl, (2 * CASE_X, 0.06, 0.06), (0, FLOOR + 0.03, -0.145), "lacquer")
    node("Body", [(sides, {"bevel": 0.004, "bseg": 3}), (lid, {"bevel": 0.006, "bseg": 4}), (low, {"bevel": 0.0025, "bseg": 3}),
                  (pl, {"bevel": 0.004, "bseg": 3})], V(0, 0, 0), case)

    # --- brass: pedals and candle sconces ---------------------------------
    br = MB()
    for x in (-0.075, 0.0, 0.075):
        pts = [V(x, FLOOR + 0.05, -0.13), V(x, FLOOR + 0.052, -0.09), V(x, FLOOR + 0.058, -0.05)]
        tube(br, pts, lambda u: 0.011 - 0.003 * u, "brass", 14)
        sphere(br, 0.012, "brass", 18, 9, center=(x, FLOOR + 0.058, -0.048))
    for s in (-1, 1):
        x = s * 0.47
        base = V(x, 0.30, FRONT)
        lathe(br, [(0, 0.004), (0.028, 0.004), (0.03, 0.0), (0.0, 0.0)], "brass", 24, tr(x, 0.30, FRONT + 0.002))
        arm = [V(x, 0.30, FRONT + 0.004), V(x + s * 0.01, 0.285, FRONT + 0.05), V(x + s * 0.03, 0.27, FRONT + 0.09),
               V(x + s * 0.045, 0.285, FRONT + 0.12), V(x + s * 0.05, 0.30, FRONT + 0.125)]
        tube(br, arm, 0.005, "brass", 10)
        cup = tr(x + s * 0.05, 0.30, FRONT + 0.125) @ rot_x(-math.pi / 2)
        lathe(br, [(0.0, 0.026), (0.024, 0.026), (0.028, 0.03), (0.026, 0.022), (0.012, 0.012), (0.008, 0.0), (0.0, 0.0)],
              "brass", 24, cup)
    node("Brass", [(br, {})], V(0, 0, 0), case)
    return case


def preview(path, case):
    from common import to_blender
    sc = scene()
    cam_data = bpy.data.cameras.new("cam")
    cam_data.lens = 50
    cam = bpy.data.objects.new("cam", cam_data)
    sc.collection.objects.link(cam)
    sc.camera = cam
    loc = to_blender(V(0.95, 0.25, 0.75))
    target = to_blender(V(0.1, -0.05, -0.15))
    cam.location = loc
    cam.rotation_euler = (target - loc).normalized().to_track_quat("-Z", "Y").to_euler()
    for (p, e, size, col) in (((-1.5, 1.0, 1.5), 300, 1.5, (1.0, 0.85, 0.7)), ((1.5, 1.5, 1.0), 80, 2.0, (0.7, 0.8, 1.0))):
        ld = bpy.data.lights.new("l", "AREA")
        ld.energy = e
        ld.size = size
        ld.color = col
        lo = bpy.data.objects.new("l", ld)
        lo.location = to_blender(V(*p))
        lo.rotation_euler = (Vector((0, 0, 0)) - lo.location).normalized().to_track_quat("-Z", "Y").to_euler()
        sc.collection.objects.link(lo)
    sc.world.color = (0.03, 0.03, 0.035)
    sc.render.engine = "CYCLES"
    sc.cycles.samples = 32
    sc.cycles.use_denoising = True
    sc.render.resolution_x = 900
    sc.render.resolution_y = 600
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam)


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = scene()
    if sc.world is None:
        sc.world = bpy.data.worlds.new("World")
    case = build()
    bpy.context.view_layer.update()
    objs = mesh_objects(case)
    print(f"objects: {len(objs)}  triangles: {tri_count(objs)}")
    if not os.environ.get("NO_BAKE"):
        bake_masks(objs, distance=0.03, samples=24)
    if PREVIEW:
        preview(PREVIEW, case)
    export_glb(OUT)
    print("wrote", OUT)


main()
