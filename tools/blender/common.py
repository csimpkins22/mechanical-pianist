"""
Shared Blender helpers for the scripted asset builds.

All geometry is written in three.js space (metres, +Y up, -Z forward) and
converted to Blender space (Z up) on the way in; the glTF exporter converts
back, so every number in the build scripts matches the TypeScript side.
"""

import bpy
import bmesh
import math
from mathutils import Vector, Matrix

TAU = math.tau
C = Matrix(((1, 0, 0), (0, 0, -1), (0, 1, 0)))  # three -> blender
C4 = C.to_4x4()
C4_INV = C4.inverted()


def V(x, y, z):
    return Vector((x, y, z))


def to_blender(v):
    return Vector((v[0], -v[2], v[1]))


def mat_to_blender(m3):
    """Rotation matrix in three space -> the same rotation in blender space."""
    return (C @ m3 @ C.transposed()).to_4x4()


def rot_x(a):
    return Matrix.Rotation(a, 4, "X")


def rot_y(a):
    return Matrix.Rotation(a, 4, "Y")


def rot_z(a):
    return Matrix.Rotation(a, 4, "Z")


def tr(x, y, z):
    return Matrix.Translation((x, y, z))


def lerp(a, b, t):
    return a + (b - a) * t


def smooth01(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


# -----------------------------------------------------------------------------
# Materials (three.js replaces these by name with tuned shaders)
# -----------------------------------------------------------------------------
MATS = {
    "shell": ((0.92, 0.91, 0.88), 0.0, 0.3, None),
    "shell_inner": ((0.62, 0.61, 0.6), 0.0, 0.55, None),
    "chrome": ((0.9, 0.9, 0.92), 1.0, 0.08, None),
    "steel": ((0.72, 0.74, 0.77), 1.0, 0.3, None),
    "graphite": ((0.09, 0.095, 0.105), 0.7, 0.45, None),
    "rubber": ((0.12, 0.125, 0.13), 0.0, 0.7, None),
    "glow": ((0.3, 0.95, 1.0), 0.0, 0.3, (0.3, 0.95, 1.0)),
    "lacquer": ((0.03, 0.02, 0.015), 0.0, 0.15, None),
    "walnut": ((0.12, 0.06, 0.03), 0.0, 0.35, None),
    "brass": ((0.85, 0.65, 0.35), 1.0, 0.3, None),
    "felt": ((0.35, 0.05, 0.06), 0.0, 0.95, None),
    "wood_raw": ((0.45, 0.32, 0.2), 0.0, 0.7, None),
    "gold_leaf": ((0.9, 0.7, 0.35), 1.0, 0.35, None),
    "cloth": ((0.2, 0.17, 0.15), 0.0, 0.9, None),
}


def get_mat(name):
    if name in bpy.data.materials:
        return bpy.data.materials[name]
    col, met, rough, emit = MATS[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*col, 1.0)
    bsdf.inputs["Metallic"].default_value = met
    bsdf.inputs["Roughness"].default_value = rough
    if emit:
        bsdf.inputs["Emission Color"].default_value = (*emit, 1.0)
        bsdf.inputs["Emission Strength"].default_value = 3.0
    if name == "shell":
        bsdf.inputs["Coat Weight"].default_value = 0.6
        bsdf.inputs["Coat Roughness"].default_value = 0.1
    return m


# -----------------------------------------------------------------------------
# Mesh builder (three.js space)
# -----------------------------------------------------------------------------
class MB:
    def __init__(self):
        self.v = []
        self.f = []
        self.fm = []

    def vert(self, p):
        self.v.append(Vector(p))
        return len(self.v) - 1

    def face(self, idx, mat):
        self.f.append(tuple(idx))
        self.fm.append(mat)

    def extend(self, other, xf=None):
        off = len(self.v)
        for p in other.v:
            self.v.append((xf @ p) if xf else p.copy())
        for f, m in zip(other.f, other.fm):
            self.f.append(tuple(i + off for i in f))
            self.fm.append(m)


def grid_surface(mb, fn, nu, nv, mat, closed_v=False, flip=False, pole0=None, pole1=None):
    """Parametric surface fn(u, v) -> point, u in [0,1] (rows), v in [0,1] (cols).
    pole0 / pole1: optional points closing the u=0 / u=1 ends with a fan."""
    cols = nv if closed_v else nv + 1
    rows = []
    for i in range(nu + 1):
        u = i / nu
        rows.append([mb.vert(fn(u, j / nv)) for j in range(cols)])
    for i in range(nu):
        for j in range(nv):
            j2 = (j + 1) % cols if closed_v else j + 1
            q = [rows[i][j], rows[i][j2], rows[i + 1][j2], rows[i + 1][j]]
            mb.face(q[::-1] if flip else q, mat)
    for pole, row, rev in ((pole0, rows[0], True), (pole1, rows[-1], False)):
        if pole is None:
            continue
        c = mb.vert(pole)
        for j in range(nv):
            j2 = (j + 1) % cols if closed_v else j + 1
            tri = [c, row[j2], row[j]] if rev else [c, row[j], row[j2]]
            mb.face(tri[::-1] if flip else tri, mat)
    return rows


def superellipse(theta, a, b, n):
    c, s = math.cos(theta), math.sin(theta)
    x = a * math.copysign(abs(c) ** (2.0 / n), c)
    y = b * math.copysign(abs(s) ** (2.0 / n), s)
    return x, y


def end_round(u, e0, e1, minr=0.0):
    """Cross-section scale for rounded (elliptic) ends."""
    s = 1.0
    if e0 > 0 and u < e0:
        q = (e0 - u) / e0
        s = math.sqrt(max(0.0, 1 - q * q))
    if e1 > 0 and u > 1 - e1:
        q = (u - (1 - e1)) / e1
        s = min(s, math.sqrt(max(0.0, 1 - q * q)))
    return max(s, minr)


def pill(mb, mat, z0, z1, w, h, n=2.6, e0=0.3, e1=0.3, th=(0.0, TAU), yoff=None, nu=28, nv=36, xf=None,
         xoff=None, sag=None):
    """Superellipsoid 'pill' along -Z from z0 to z1 (z1 < z0).
    w(u), h(u): full width/height (callables or constants); e0/e1: fraction of
    the length taken by each rounded end; th: angular range of the cross-section
    (theta from +X toward +Y), the full circle for a closed pill. Rows are
    spaced densely toward rounded ends and the ends close in a fan."""
    xf = xf or Matrix()
    W = w if callable(w) else (lambda u: w)
    H = h if callable(h) else (lambda u: h)
    Y = yoff if callable(yoff) else (lambda u: yoff or 0.0)
    X = xoff if callable(xoff) else (lambda u: xoff or 0.0)
    TH = th if callable(th) else (lambda u: th)
    full = (not callable(th)) and abs((th[1] - th[0]) - TAU) < 1e-6
    NN = n if callable(n) else (lambda u: n)
    lo = 0.0015 if e0 > 0 else 0.0
    hi = 1 - 0.0015 if e1 > 0 else 1.0

    def umap(t):
        # dense near rounded ends
        a = t
        if e0 > 0 and e1 > 0:
            a = 0.5 - 0.5 * math.cos(math.pi * t)
        elif e0 > 0:
            a = 1 - math.cos(0.5 * math.pi * t)
        elif e1 > 0:
            a = math.sin(0.5 * math.pi * t)
        return lo + (hi - lo) * a

    def fn(t, v):
        u = umap(t)
        s = end_round(u, e0, e1, 0.0)
        a = W(u) * 0.5 * s
        b = H(u) * 0.5 * s
        t0, t1 = TH(u)
        ang = t0 + (t1 - t0) * v
        x, y = superellipse(ang, a, b, NN(u))
        if sag:
            y += sag(u, v, x, y)
        z = z0 + (z1 - z0) * u
        return xf @ V(x + X(u), y + Y(u), z)

    p0 = xf @ V(X(0), Y(0), z0) if e0 > 0 else None
    p1 = xf @ V(X(1), Y(1), z1) if e1 > 0 else None
    grid_surface(mb, fn, nu, nv, mat, closed_v=full, flip=True, pole0=p0, pole1=p1)


def lathe(mb, prof, mat, segs=32, xf=None):
    """Revolve (radius, z) profile around the Z axis (three space). Profile
    ordered from +z to -z gives outward normals."""
    xf = xf or Matrix()
    rings = []
    for (r, z) in prof:
        if r < 1e-7:
            rings.append(("p", mb.vert(xf @ V(0, 0, z))))
        else:
            rings.append(("r", [mb.vert(xf @ V(r * math.cos(TAU * j / segs), r * math.sin(TAU * j / segs), z))
                                for j in range(segs)]))
    for i in range(len(prof) - 1):
        A, B = rings[i], rings[i + 1]
        for j in range(segs):
            j2 = (j + 1) % segs
            if A[0] == "p" and B[0] == "p":
                continue
            if A[0] == "p":
                mb.face([A[1], B[1][j], B[1][j2]], mat)
            elif B[0] == "p":
                mb.face([A[1][j], B[1], A[1][j2]], mat)
            else:
                mb.face([A[1][j], B[1][j], B[1][j2], A[1][j2]], mat)


def cyl_x(mb, r, x0, x1, mat, segs=24, center=(0, 0, 0), chamfer=0.0):
    """Cylinder along X from x0 to x1 (x0 < x1)."""
    cx, cy, cz = center
    xf = tr(cx, cy, cz) @ rot_y(math.pi / 2)  # lathe axis Z -> X
    c = chamfer
    prof = [(0, x1), (r - c, x1), (r, x1 - c), (r, x0 + c), (r - c, x0), (0, x0)] if c > 0 else \
        [(0, x1), (r, x1), (r, x0), (0, x0)]
    # rot_y(+90): local z -> +x ... lathe profile in z, ordered +z..-z
    lathe(mb, prof, mat, segs, xf)


def cyl_z(mb, r, z0, z1, mat, segs=24, center=(0, 0), chamfer=0.0, xf=None):
    """Cylinder along Z, z0 > z1 ordering not required."""
    hi, lo = max(z0, z1), min(z0, z1)
    c = chamfer
    prof = [(0, hi), (r - c, hi), (r, hi - c), (r, lo + c), (r - c, lo), (0, lo)] if c > 0 else \
        [(0, hi), (r, hi), (r, lo), (0, lo)]
    lathe(mb, prof, mat, segs, (xf or Matrix()) @ tr(center[0], center[1], 0))


def ring_x(mb, r_in, r_out, x0, x1, mat, segs=32, center=(0, 0, 0)):
    """Annular ring (tube) along X: outer and inner walls plus faces."""
    cx, cy, cz = center
    xf = tr(cx, cy, cz) @ rot_y(math.pi / 2)
    prof = [(r_in, x1), (r_out, x1), (r_out, x0), (r_in, x0), (r_in, x1)]
    lathe(mb, prof, mat, segs, xf)


def torus_z(mb, R, r, mat, segs=48, rsegs=10, xf=None):
    """Torus around the Z axis."""
    xf = xf or Matrix()
    grid = []
    for j in range(segs):
        a = TAU * j / segs
        row = []
        for k in range(rsegs):
            b = TAU * k / rsegs
            rr = R + r * math.cos(b)
            row.append(mb.vert(xf @ V(rr * math.cos(a), rr * math.sin(a), r * math.sin(b))))
        grid.append(row)
    for j in range(segs):
        j2 = (j + 1) % segs
        for k in range(rsegs):
            k2 = (k + 1) % rsegs
            mb.face([grid[j][k], grid[j2][k], grid[j2][k2], grid[j][k2]], mat)


def box(mb, size, center, mat, xf=None):
    xf = (xf or Matrix()) @ Matrix.Translation(center)
    sx, sy, sz = (s / 2 for s in size)
    p = [V(-sx, -sy, -sz), V(sx, -sy, -sz), V(sx, sy, -sz), V(-sx, sy, -sz),
         V(-sx, -sy, sz), V(sx, -sy, sz), V(sx, sy, sz), V(-sx, sy, sz)]
    ids = [mb.vert(xf @ q) for q in p]
    for f in [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (2, 3, 7, 6), (1, 2, 6, 5), (0, 4, 7, 3)]:
        mb.face([ids[i] for i in f], mat)


def sphere(mb, r, mat, segs=24, rings=12, center=(0, 0, 0), xf=None):
    prof = [(r * math.sin(math.pi * i / rings), r * math.cos(math.pi * i / rings)) for i in range(rings + 1)]
    prof[0] = (0, r)
    prof[-1] = (0, -r)
    lathe(mb, prof, mat, segs, (xf or Matrix()) @ Matrix.Translation(center))


def tube(mb, pts, rad, mat, segs=10):
    """Sweep a circle along a polyline (three space)."""
    pts = [Vector(p) for p in pts]
    n = len(pts)
    T = [(pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]).normalized() for i in range(n)]
    up = V(0, 1, 0) if abs(T[0].y) < 0.9 else V(1, 0, 0)
    N = [T[0].cross(up).normalized()]
    for i in range(1, n):
        b = T[i - 1].cross(T[i])
        nn = N[-1].copy()
        if b.length > 1e-9:
            ang = math.acos(max(-1, min(1, T[i - 1].dot(T[i]))))
            nn = Matrix.Rotation(ang, 3, b.normalized()) @ nn
        N.append(nn.normalized())
    B = [T[i].cross(N[i]) for i in range(n)]
    rings = []
    for i in range(n):
        r = rad(i / (n - 1)) if callable(rad) else rad
        rings.append([mb.vert(pts[i] + (N[i] * math.cos(TAU * k / segs) + B[i] * math.sin(TAU * k / segs)) * r)
                      for k in range(segs)])
    for i in range(n - 1):
        for k in range(segs):
            k2 = (k + 1) % segs
            mb.face([rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]], mat)
    for ring, p, rev in ((rings[0], pts[0], True), (rings[-1], pts[-1], False)):
        c = mb.vert(p)
        for k in range(segs):
            k2 = (k + 1) % segs
            mb.face([c, ring[k], ring[k2]] if rev else [c, ring[k2], ring[k]], mat)


def thick_patch(mb, surf, nu, nv, thick, mat, edge_mat=None):
    """Grid patch surf(u,v)->(point, outward normal), extruded inward by thick."""
    top, bot = [], []
    for i in range(nu + 1):
        rt, rb = [], []
        for j in range(nv + 1):
            p, nrm = surf(i / nu, j / nv)
            rt.append(mb.vert(p))
            rb.append(mb.vert(p - nrm * thick))
        top.append(rt)
        bot.append(rb)
    em = edge_mat or mat
    for i in range(nu):
        for j in range(nv):
            mb.face([top[i][j], top[i][j + 1], top[i + 1][j + 1], top[i + 1][j]], mat)
            mb.face([bot[i][j], bot[i + 1][j], bot[i + 1][j + 1], bot[i][j + 1]], em)
    for i in range(nu):
        mb.face([top[i + 1][0], bot[i + 1][0], bot[i][0], top[i][0]], em)
        mb.face([bot[i][nv], bot[i + 1][nv], top[i + 1][nv], top[i][nv]], em)
    for j in range(nv):
        mb.face([bot[0][j], bot[0][j + 1], top[0][j + 1], top[0][j]], em)
        mb.face([top[nu][j + 1], bot[nu][j + 1], bot[nu][j], top[nu][j]], em)


# -----------------------------------------------------------------------------
# Objects
# -----------------------------------------------------------------------------
def scene():
    return bpy.context.scene


def mesh_from_mb(name, mb, mat_names):
    me = bpy.data.meshes.new(name)
    verts = [to_blender(v) for v in mb.v]
    me.from_pydata([tuple(v) for v in verts], [], mb.f)
    me.update()
    for m in mat_names:
        me.materials.append(get_mat(m))
    idx = {m: i for i, m in enumerate(mat_names)}
    me.polygons.foreach_set("material_index", [idx[m] for m in mb.fm])
    me.validate()
    return me


def apply_modifiers(obj):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(ev)
    obj.modifiers.clear()
    old = obj.data
    obj.data = me
    bpy.data.meshes.remove(old)


def fix_normals(obj):
    """Consistent winding, then each connected piece turned to face away from
    its own centroid (right for closed parts and for open shells alike)."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-7)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.faces.ensure_lookup_table()
    seen = set()
    for f in bm.faces:
        if f.index in seen:
            continue
        comp = []
        stack = [f]
        seen.add(f.index)
        while stack:
            g = stack.pop()
            comp.append(g)
            for e in g.edges:
                for h in e.link_faces:
                    if h.index not in seen:
                        seen.add(h.index)
                        stack.append(h)
        area = sum(g.calc_area() for g in comp) or 1.0
        cen = sum((g.calc_center_median() * g.calc_area() for g in comp), Vector()) / area
        score = sum((g.calc_center_median() - cen).dot(g.normal) * g.calc_area() for g in comp)
        if score < 0:
            bmesh.ops.reverse_faces(bm, faces=comp)
    bm.to_mesh(obj.data)
    bm.free()


def build_part(name, parts):
    """parts: list of (MB, opts) with opts keys:
        solid: shell thickness (solidify inward) or 0
        bevel: bevel width, bseg: bevel segments
        recalc: recalc normals (closed meshes)
    Returns a mesh datablock whose geometry is in the MB's own frame."""
    mat_names = []
    for mb, _ in parts:
        for m in mb.fm:
            if m not in mat_names:
                mat_names.append(m)
    bm = bmesh.new()
    for pi, (mb, o) in enumerate(parts):
        if not mb.f:
            continue
        me = mesh_from_mb(f"{name}_tmp{pi}", mb, mat_names)
        ob = bpy.data.objects.new(f"{name}_tmp{pi}", me)
        scene().collection.objects.link(ob)
        if o.get("recalc", True):
            fix_normals(ob)
        if o.get("solid", 0) > 0:
            mod = ob.modifiers.new("solid", "SOLIDIFY")
            mod.thickness = o["solid"]
            mod.offset = -1
            mod.use_even_offset = True
            mod.use_rim = True
            mod.material_offset_rim = 0
            apply_modifiers(ob)
        if o.get("bevel", 0) > 0:
            mod = ob.modifiers.new("bevel", "BEVEL")
            mod.width = o["bevel"]
            mod.segments = o.get("bseg", 2)
            mod.limit_method = "ANGLE"
            mod.angle_limit = math.radians(o.get("bangle", 35))
            mod.use_clamp_overlap = True
            apply_modifiers(ob)
        bm.from_mesh(ob.data)
        bpy.data.objects.remove(ob)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in mat_names:
        me.materials.append(get_mat(m))
    me.polygons.foreach_set("use_smooth", [True] * len(me.polygons))
    me.set_sharp_from_angle(angle=math.radians(40))
    return me


ALL = []


def node(name, parts, pos, parent=None, rot3=None):
    """Object with origin at pos (three space, relative to parent), optional
    rest rotation (3x3 in three space)."""
    me = build_part(name, parts) if parts else None
    ob = bpy.data.objects.new(name, me)
    scene().collection.objects.link(ob)
    M = mat_to_blender(rot3) if rot3 is not None else Matrix()
    ob.matrix_basis = Matrix.Translation(to_blender(pos)) @ M
    if parent is not None:
        ob.parent = parent
    ALL.append(ob)
    return ob


def set_pose(ob, pos, rot3):
    ob.matrix_basis = Matrix.Translation(to_blender(pos)) @ (mat_to_blender(rot3) if rot3 is not None else Matrix())


def mesh_objects(root):
    out = []

    def walk(o):
        if o.type == "MESH":
            out.append(o)
        for c in o.children:
            walk(c)

    walk(root)
    return out


def bake_masks(objs, distance=0.008, samples=48):
    """R = baked ambient occlusion, G = convex curvature, B = concave curvature."""
    sc = scene()
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = samples
    sc.render.bake.target = "VERTEX_COLORS"
    if sc.world is None:
        sc.world = bpy.data.worlds.new("World")
    sc.world.light_settings.distance = distance
    for o in objs:
        me = o.data
        for a in list(me.color_attributes):
            me.color_attributes.remove(a)
        ca = me.color_attributes.new("AO", "BYTE_COLOR", "CORNER")
        me.color_attributes.active_color = ca
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.bake(type="AO", target="VERTEX_COLORS", use_clear=True)
    for o in objs:
        me = o.data
        nv = len(me.vertices)
        curv = [0.0] * nv
        cnt = [0] * nv
        co = [v.co.copy() for v in me.vertices]
        no = [v.normal.copy() for v in me.vertices]
        for e in me.edges:
            a, b = e.vertices
            d = co[b] - co[a]
            l2 = d.length_squared
            if l2 < 1e-14:
                continue
            k = (no[b] - no[a]).dot(d) / l2
            curv[a] += k
            curv[b] += k
            cnt[a] += 1
            cnt[b] += 1
        curv = [curv[i] / cnt[i] if cnt[i] else 0.0 for i in range(nv)]
        ao = me.color_attributes["AO"]
        col = me.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
        for li, loop in enumerate(me.loops):
            k = curv[loop.vertex_index]
            a = ao.data[li].color[0]
            col.data[li].color = (a, max(0.0, min(1.0, k / 900.0)), max(0.0, min(1.0, -k / 900.0)), 1.0)
        me.color_attributes.remove(ao)
        me.color_attributes.active_color = me.color_attributes["Col"]
        me.color_attributes.render_color_index = 0


def export_glb(path):
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=False, export_apply=False,
                              export_yup=True, export_vertex_color="ACTIVE", export_all_vertex_colors=False,
                              export_normals=True, export_texcoords=False, export_materials="EXPORT",
                              export_extras=False)


def tri_count(objs):
    return sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objs if o.data)
