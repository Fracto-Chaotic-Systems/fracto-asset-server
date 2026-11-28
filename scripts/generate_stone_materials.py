"""Generate the weathered-stone construction materials (pillar, lintel, wall blocks).

Writes runtime/<name>.glb into each asset folder under models/ingredients/. Pure
NumPy + Pillow, deterministic (fixed seeds), meters, Y up, grounded and centred.
Two tileable texture sets (base color, normal, roughness), embedded as JPEG so
each GLB is self-contained: darker weathered granite for the wall blocks, and a
pale, finer limestone for the pillars and lintel so the doorway frame stands out.

    python servers/fracto-asset-server/scripts/generate_stone_materials.py [--only id ...]
"""
import argparse
import io
import json
import struct
from pathlib import Path

import numpy as np
from PIL import Image

MODELS = Path(__file__).resolve().parents[1] / "models" / "ingredients"
TEXTURE_SIZE = 1024
TEXTURE_METERS = 1.6  # one texture tile covers 1.6 m of stone surface

# id: (file stem, width x, height y, depth z, edge radius, top taper, face bulge, chip depth, seed, uv offset, style)
PIECES = {
    "stone-pillar": ("stone_pillar", 1.0, 2.5, 0.8, 0.045, 0.06, 0.006, 0.035, 11, (0.13, 0.41), "pale_limestone"),
    "stone-lintel": ("stone_lintel", 5.2, 0.55, 0.95, 0.05, 0.0, 0.008, 0.04, 23, (0.57, 0.08), "pale_limestone"),
    "stone-wall-block-large": ("stone_wall_block_large", 1.8, 0.7, 0.6, 0.04, 0.0, 0.012, 0.03, 31, (0.31, 0.72), "weathered_granite"),
    "stone-wall-block-medium": ("stone_wall_block_medium", 1.2, 0.7, 0.6, 0.04, 0.0, 0.012, 0.03, 37, (0.84, 0.25), "weathered_granite"),
    "stone-wall-block-small": ("stone_wall_block_small", 0.75, 0.7, 0.6, 0.04, 0.0, 0.012, 0.03, 41, (0.46, 0.93), "weathered_granite"),
}

# Texture styles: color and weathering weights (all fields used by stone_textures).
STYLES = {
    "weathered_granite": dict(seed=7, base=(0.60, 0.585, 0.55), variation=1.0, grime=0.22, dark_specks=0.45,
                              light_specks=0.25, lichen=0.7, pale=0.6, cracks=0.35, relief=1.0),
    "pale_limestone": dict(seed=19, base=(0.86, 0.82, 0.73), variation=0.6, grime=0.10, dark_specks=0.12,
                           light_specks=0.08, lichen=0.22, pale=0.25, cracks=0.12, relief=0.75),
}


# ---------------------------------------------------------------- textures
def filtered_noise(rng, scale, stretch=1.0, size=TEXTURE_SIZE):
    """Tileable unit-variance noise with features about `scale` pixels wide."""
    white = rng.standard_normal((size, size))
    fy = np.fft.fftfreq(size)[:, None]
    fx = np.fft.fftfreq(size)[None, :]
    sigma = 1.0 / (2 * np.pi * scale)
    out = np.real(np.fft.ifft2(np.fft.fft2(white) * np.exp(-((fx * stretch) ** 2 + fy**2) / (2 * sigma**2))))
    out -= out.mean()
    return out / (out.std() + 1e-9)


def stone_textures(seed=7, base=(0.60, 0.585, 0.55), variation=1.0, grime=0.22, dark_specks=0.45,
                   light_specks=0.25, lichen=0.7, pale=0.6, cracks=0.35, relief=1.0):
    rng = np.random.default_rng(seed)
    w_grime, w_dark, w_light, w_lichen, w_pale, w_cracks = grime, dark_specks, light_specks, lichen, pale, cracks
    broad = filtered_noise(rng, 110)
    mid = filtered_noise(rng, 22)
    fine = filtered_noise(rng, 5)
    grain = filtered_noise(rng, 1.2)
    # Granite speckle: sparse dark and light crystals.
    speck = filtered_noise(rng, 1.6)
    dark_specks = np.clip(speck - 1.6, 0, 1)
    light_specks = np.clip(-speck - 1.9, 0, 1)
    # Crack network: zero crossings of a mid-scale field, shown only in places.
    crack_field = filtered_noise(rng, 60, stretch=0.4) + 0.3 * filtered_noise(rng, 7)
    crack_mask = np.clip((filtered_noise(rng, 160) - 0.9) * 1.5, 0, 1)
    cracks = np.exp(-((crack_field / 0.05) ** 2)) * crack_mask
    # Weathering: grime in broad low areas, pale lichen colonies.
    grime = np.clip(-broad * 0.6 - mid * 0.25 - 0.2, 0, 1)
    lichen_field = filtered_noise(rng, 26) + 0.45 * filtered_noise(rng, 6)
    lichen = np.clip((lichen_field - 1.25) * 1.6, 0, 1)
    pale = np.clip((filtered_noise(rng, 12) + 0.3 * fine - 1.7) * 2.0, 0, 1)

    value = 1 + variation * (0.07 * broad + 0.07 * mid + 0.05 * fine + 0.05 * grain)
    base = np.array(base)
    rgb = value[..., None] * base
    rgb *= (1 - w_grime * grime)[..., None]
    rgb = rgb * (1 - w_dark * dark_specks[..., None]) + light_specks[..., None] * w_light
    rgb = rgb * (1 - lichen[..., None] * w_lichen) + lichen[..., None] * w_lichen * np.array([0.66, 0.67, 0.56]) * (1 + 0.1 * fine[..., None])
    rgb = rgb * (1 - pale[..., None] * w_pale) + pale[..., None] * w_pale * np.array([0.80, 0.79, 0.75])
    rgb *= (1 - w_cracks * cracks)[..., None]
    base_color = np.clip(rgb, 0, 1)

    height = 0.35 * mid + 0.25 * fine + 0.12 * grain - 1.6 * cracks - 0.5 * dark_specks + 0.25 * lichen
    dx = (np.roll(height, -1, 1) - np.roll(height, 1, 1)) / 2
    dy = (np.roll(height, -1, 0) - np.roll(height, 1, 0)) / 2
    strength = 0.9 * relief
    n = np.dstack([-dx * strength, dy * strength, np.ones_like(height)])
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    normal = n * 0.5 + 0.5

    rough = np.clip(0.86 + 0.05 * fine + 0.05 * lichen - 0.04 * light_specks, 0, 1)
    mr = np.dstack([np.ones_like(rough), rough, np.zeros_like(rough)])  # glTF: G roughness, B metal

    def jpeg(array, quality):
        image = Image.fromarray((np.clip(array, 0, 1) * 255).round().astype(np.uint8), "RGB")
        buffer = io.BytesIO()
        image.save(buffer, "JPEG", quality=quality, optimize=True)
        return buffer.getvalue(), image

    return {
        "base": jpeg(base_color, 88),
        "normal": jpeg(normal, 92),
        "roughness": jpeg(mr, 85),
    }


# ---------------------------------------------------------------- geometry
def _hash3(ix, iy, iz, seed):
    h = (ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791) ^ (seed * 2654435761)
    h = (h ^ (h >> 13)) * 1274126177
    return ((h ^ (h >> 16)) & 0xFFFFFF) / float(0xFFFFFF)


def value_noise3(p, seed):
    """Smooth 3D value noise in [-1, 1] for points p (N, 3)."""
    base = np.floor(p).astype(np.int64)
    f = p - base
    w = f * f * (3 - 2 * f)
    total = np.zeros(len(p))
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                corner = _hash3(base[:, 0] + dx, base[:, 1] + dy, base[:, 2] + dz, seed)
                weight = (w[:, 0] if dx else 1 - w[:, 0]) * (w[:, 1] if dy else 1 - w[:, 1]) * (w[:, 2] if dz else 1 - w[:, 2])
                total += corner * weight
    return total * 2 - 1


def fbm3(p, seed, octaves=4):
    total, amplitude, scale = np.zeros(len(p)), 0.5, 1.0
    for octave in range(octaves):
        total += amplitude * value_noise3(p * scale, seed + octave * 101)
        amplitude *= 0.5
        scale *= 2.03
    return total


def axis_samples(half, radius, step, segments=4):
    core = np.linspace(-(half - radius), half - radius, max(2, int(np.ceil(2 * (half - radius) / step)) + 1))
    band = (half - radius) + radius * np.arange(1, segments + 1) / segments
    return np.concatenate([-band[::-1], core, band])


def stone_block(size, radius, taper, bulge, chip, seed, uv_offset, step=0.035):
    """Rounded, weathered block: per-face grids projected onto a rounded box,
    then displaced along the surface normal (face bulge, edge chips)."""
    half = np.array(size) / 2
    positions, normals_in, uvs, faces = [], [], [], []
    offset = 0
    for axis in range(3):
        u_axis, v_axis = [a for a in range(3) if a != axis]
        su = axis_samples(half[u_axis], radius, step)
        sv = axis_samples(half[v_axis], radius, step)
        for sign in (-1, 1):
            uu, vv = np.meshgrid(su, sv, indexing="ij")
            q = np.zeros(uu.shape + (3,))
            q[..., axis] = sign * half[axis]
            q[..., u_axis] = uu
            q[..., v_axis] = vv
            q = q.reshape(-1, 3)
            inner = np.clip(q, -(half - radius), half - radius)
            d = q - inner
            length = np.linalg.norm(d, axis=1, keepdims=True)
            direction = d / np.maximum(length, 1e-12)
            p = inner + direction * radius
            # Texture: planar projection of the face in meters, mirrored so it reads outward.
            uv = np.stack([q[:, u_axis] * sign * (1 if axis != 1 else 1), q[:, v_axis]], 1)
            if axis == 2:
                uv = np.stack([q[:, 0] * sign, q[:, 1]], 1)
            elif axis == 0:
                uv = np.stack([-q[:, 2] * sign, q[:, 1]], 1)
            else:
                uv = np.stack([q[:, 0], q[:, 2] * sign], 1)
            positions.append(p)
            normals_in.append(direction)
            uvs.append(uv / TEXTURE_METERS + np.array(uv_offset))
            nu, nv = len(su), len(sv)
            idx = np.arange(nu * nv).reshape(nu, nv) + offset
            a, b = idx[:-1, :-1].ravel(), idx[1:, :-1].ravel()
            c, d2 = idx[1:, 1:].ravel(), idx[:-1, 1:].ravel()
            tris = np.concatenate([np.stack([a, b, c], 1), np.stack([a, c, d2], 1)])
            # Wind outward: check one triangle against the face direction.
            v0, v1, v2 = q[tris[0] - offset]
            if np.dot(np.cross(v1 - v0, v2 - v0), np.eye(3)[axis] * sign) < 0:
                tris = tris[:, [0, 2, 1]]
            faces.append(tris)
            offset += nu * nv
    p = np.concatenate(positions)
    n0 = np.concatenate(normals_in)
    uv = np.concatenate(uvs)
    f = np.concatenate(faces)

    # Weathering displacement along the rounded-box normal.
    edge = 1 - np.max(np.abs(n0), axis=1)  # 0 on flat faces, ~0.42 on edges, ~0.42+ at corners
    edge_weight = np.clip(edge / 0.3, 0, 1)
    near_edge = np.clip(1 - np.min(half[None, :] - np.abs(p) + (np.abs(n0) < 0.99) * 9, axis=1) / (radius * 3), 0, 1)
    face_noise = fbm3(p * 1.7, seed)
    chips = np.clip(fbm3(p * 9.0, seed + 7) * 1.6 + 0.1, 0, None) ** 1.5
    displacement = bulge * face_noise - chip * chips * np.maximum(edge_weight, 0.55 * near_edge)
    p = p + n0 * displacement[:, None]

    if taper:
        t = (p[:, 1] + half[1]) / (2 * half[1])
        k = 1 - taper * t
        p[:, 0] *= k
        p[:, 2] *= k

    # Ground and centre.
    p[:, 1] -= p[:, 1].min()
    p[:, 0] -= (p[:, 0].min() + p[:, 0].max()) / 2
    p[:, 2] -= (p[:, 2].min() + p[:, 2].max()) / 2

    # Smooth normals welded across face seams (duplicate positions on shared edges).
    tri = p[f]
    face_normal = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    key = np.round(p * 1e5).astype(np.int64)
    _, weld = np.unique(key, axis=0, return_inverse=True)
    weld = weld.ravel()
    acc = np.zeros((weld.max() + 1, 3))
    for corner in range(3):
        np.add.at(acc, weld[f[:, corner]], face_normal)
    normals = acc[weld]
    normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-12)
    return p.astype(np.float32), normals.astype(np.float32), uv.astype(np.float32), f.astype(np.uint32)


# ---------------------------------------------------------------- glTF
def write_glb(path, name, mesh, textures, style="weathered_granite"):
    positions, normals, uvs, indices = mesh
    blobs, views, accessors = [], [], []

    def add_view(data, target=None):
        offset = sum(len(b) for b in blobs)
        pad = (-offset) % 4
        if pad:
            blobs.append(b"\0" * pad)
            offset += pad
        blobs.append(data)
        view = {"buffer": 0, "byteOffset": offset, "byteLength": len(data)}
        if target:
            view["target"] = target
        views.append(view)
        return len(views) - 1

    def add_accessor(array, kind, component, target, bounds=False):
        view = add_view(array.tobytes(), target)
        accessor = {"bufferView": view, "componentType": component, "count": len(array), "type": kind}
        if bounds:
            accessor["min"] = array.min(0).tolist()
            accessor["max"] = array.max(0).tolist()
        accessors.append(accessor)
        return len(accessors) - 1

    attributes = {
        "POSITION": add_accessor(positions, "VEC3", 5126, 34962, bounds=True),
        "NORMAL": add_accessor(normals, "VEC3", 5126, 34962),
        "TEXCOORD_0": add_accessor(uvs, "VEC2", 5126, 34962),
    }
    index = add_accessor(indices.ravel(), "SCALAR", 5125, 34963)
    images = []
    for key in ("base", "normal", "roughness"):
        images.append({"bufferView": add_view(textures[key][0]), "mimeType": "image/jpeg", "name": f"{style}_{key}"})
    gltf = {
        "asset": {"version": "2.0", "generator": "fracto generate_stone_materials.py"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": name}],
        "meshes": [{"name": name, "primitives": [{"attributes": attributes, "indices": index, "material": 0}]}],
        "materials": [{
            "name": style,
            "pbrMetallicRoughness": {
                "baseColorTexture": {"index": 0},
                "metallicRoughnessTexture": {"index": 2},
                "metallicFactor": 0.0,
                "roughnessFactor": 1.0,
            },
            "normalTexture": {"index": 1, "scale": 1.0},
        }],
        "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}],
        "textures": [{"sampler": 0, "source": i} for i in range(3)],
        "images": images,
        "bufferViews": views,
        "accessors": accessors,
    }
    binary = b"".join(blobs)
    binary += b"\0" * ((-len(binary)) % 4)
    gltf["buffers"] = [{"byteLength": len(binary)}]
    text = json.dumps(gltf, separators=(",", ":")).encode()
    text += b" " * ((-len(text)) % 4)
    body = struct.pack("<II", len(text), 0x4E4F534A) + text + struct.pack("<II", len(binary), 0x004E4942) + binary
    path.write_bytes(struct.pack("<III", 0x46546C67, 2, 12 + len(body)) + body)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", nargs="*", default=None)
    parser.add_argument("--texture-preview", type=Path, default=None)
    args = parser.parse_args()
    textures = {name: stone_textures(**style) for name, style in STYLES.items()}
    if args.texture_preview:
        for name, maps in textures.items():
            maps["base"][1].save(args.texture_preview.with_name(f"{args.texture_preview.stem}_{name}.png"))
    for asset_id, (stem, sx, sy, sz, radius, taper, bulge, chip, seed, uv_offset, style) in PIECES.items():
        if args.only and asset_id not in args.only:
            continue
        mesh = stone_block((sx, sy, sz), radius, taper, bulge, chip, seed, uv_offset)
        out = MODELS / asset_id / "runtime" / f"{stem}.glb"
        out.parent.mkdir(parents=True, exist_ok=True)
        write_glb(out, stem, mesh, textures[style], style)
        p = mesh[0]
        size = p.max(0) - p.min(0)
        print(f"{asset_id}: {out.name} {len(p)} vertices {len(mesh[3])} triangles "
              f"size {size.round(3).tolist()} m, {out.stat().st_size // 1024} KiB")


if __name__ == "__main__":
    main()
