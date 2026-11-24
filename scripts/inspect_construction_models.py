"""Read-only Blender measurement of catalog runtime geometry at its default pose.

Run with --background --factory-startup --disable-autoexec --threads 2 --python
this_file -- <library> <report.json> <asset-id> [...]. Never saves source models.
Reports meter extents in the Three.js loader's Y-up frame, before stage centering.
"""
import json
import hashlib
import struct
import sys
from pathlib import Path

import bpy
import numpy as np

# Blender 3.4's bundled glTF importer predates NumPy 1.24's alias removal.
if 'bool' not in np.__dict__:
    np.bool = np.bool_


def inspect_asset(library, entry):
    record_file = (library / entry['record']).resolve()
    record_file.relative_to(library)
    record = json.loads(record_file.read_text(encoding='utf-8-sig'))
    root = record_file.parent
    runtime = record['runtime']
    source = (root / runtime['path']).resolve()
    source.relative_to(root)
    if runtime['path'] not in runtime.get('files', [runtime['path']]):
        raise ValueError('unregistered_runtime')
    bpy.ops.wm.read_factory_settings(use_empty=True)
    fmt = runtime['format']
    units_cm = None
    gltf = None
    if fmt in ('glb', 'gltf'):
        bpy.ops.import_scene.gltf(filepath=str(source))
        if fmt == 'glb':
            with source.open('rb') as stream:
                header = stream.read(20)
                if header[:4] != b'glTF' or header[16:20] != b'JSON':
                    raise ValueError('invalid_glb')
                gltf = json.loads(stream.read(struct.unpack_from('<I', header, 12)[0]))
    elif fmt == 'fbx':
        from io_scene_fbx import parse_fbx
        tree, _ = parse_fbx.parse(str(source))
        settings = next(elem for elem in tree.elems if elem.id == b'GlobalSettings')
        properties = next(elem for elem in settings.elems if elem.id == b'Properties70')
        units_cm = next(elem.props[-1] for elem in properties.elems if elem.props[0] == b'UnitScaleFactor')
        bpy.ops.import_scene.fbx(filepath=str(source), use_anim=False)
    else:
        raise ValueError('unsupported_runtime')
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    lower = np.full(3, np.inf)
    upper = np.full(3, -np.inf)
    uv_lower = np.full(2, np.inf)
    uv_upper = np.full(2, -np.inf)
    meshes = vertices = 0
    for obj in bpy.context.scene.objects:
        if obj.type != 'MESH':
            continue
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        try:
            if not len(mesh.vertices):
                continue
            coords = np.empty(len(mesh.vertices) * 3, dtype=np.float64)
            mesh.vertices.foreach_get('co', coords)
            matrix = np.array(evaluated.matrix_world)
            world = coords.reshape((-1, 3)) @ matrix[:3, :3].T + matrix[:3, 3]
            # Blender uses Z-up; glTF/Three.js loader output uses Y-up.
            y_up = world[:, [0, 2, 1]] * [1, 1, -1]
            lower = np.minimum(lower, y_up.min(axis=0))
            upper = np.maximum(upper, y_up.max(axis=0))
            meshes += 1
            vertices += len(mesh.vertices)
            if mesh.uv_layers.active:
                uv = np.array([tuple(item.uv) for item in mesh.uv_layers.active.data])
                if len(uv):
                    uv_lower = np.minimum(uv_lower, uv.min(axis=0))
                    uv_upper = np.maximum(uv_upper, uv.max(axis=0))
        finally:
            evaluated.to_mesh_clear()
    if not np.isfinite(lower).all():
        raise ValueError('no_mesh')
    digest = hashlib.sha256()
    with source.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    result = dict(id=entry['id'], format=fmt, runtime_path=runtime['path'], runtime_sha256=digest.hexdigest(),
                  meters_per_unit=1 if units_cm is None else units_cm / 100,
                  min_m=lower.tolist(), max_m=upper.tolist(), dimensions_m=(upper-lower).tolist(),
                  ground_anchor_m=[float((lower[0]+upper[0])/2), float(lower[1]), float((lower[2]+upper[2])/2)],
                  footprint_m=[float(upper[0]-lower[0]), float(upper[2]-lower[2])],
                  meshes=meshes, vertices=vertices, animations=len(bpy.data.actions),
                  uv_min=uv_lower.tolist() if np.isfinite(uv_lower).all() else None,
                  uv_max=uv_upper.tolist() if np.isfinite(uv_upper).all() else None)
    if gltf:
        result['images'] = [dict(index=i, mime_type=image.get('mimeType'), embedded='bufferView' in image) for i, image in enumerate(gltf.get('images', []))]
        result['materials'] = [dict(base_color=material.get('pbrMetallicRoughness', {}).get('baseColorTexture'),
                                    spec_gloss_diffuse=material.get('extensions', {}).get('KHR_materials_pbrSpecularGlossiness', {}).get('diffuseTexture')) for material in gltf.get('materials', [])]
    return result


if __name__ == '__main__':
    args = sys.argv[sys.argv.index('--') + 1:]
    library = Path(args[0]).resolve()
    report_file = Path(args[1])
    index = json.loads((library / 'catalog.json').read_text(encoding='utf-8-sig'))
    results = []
    for identifier in args[2:]:
        entry = next(item for item in index['assets'] if item['id'] == identifier)
        results.append(inspect_asset(library, entry))
        report_file.parent.mkdir(parents=True, exist_ok=True)
        report_file.write_text(json.dumps(results, indent=2), encoding='utf-8')
        print('Measured ' + identifier, flush=True)
