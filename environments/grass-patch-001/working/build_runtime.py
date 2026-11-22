"""Rebuild this asset from the preserved OBJ and PNGs; Python standard library."""
import json
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def build():
    positions, normals, uvs, faces = [], [], [], []
    material = None
    source = ROOT / 'source/extracted/OBJ/Grass_Plane_001.obj'
    for line in source.read_text().splitlines():
        words = line.split()
        if not words:
            continue
        if words[0] == 'v':
            positions.append([float(v) * 0.01 for v in words[1:4]])
        elif words[0] == 'vn':
            normals.append([float(v) for v in words[1:4]])
        elif words[0] == 'vt':
            uvs.append([float(v) for v in words[1:3]])
        elif words[0] == 'usemtl':
            material = int(words[1]) - 1
        elif words[0] == 'f':
            faces.append((material, [[int(v) - 1 for v in w.split('/')]
                                     for w in words[1:]]))
    assert len(positions) == 16 and len(faces) == 4
    binary = bytearray()
    doc = {
        'asset': {'version': '2.0', 'generator': 'Fracto grass OBJ conversion'},
        'scene': 0, 'scenes': [{'nodes': [0]}],
        'nodes': [{'name': 'grass-patch-001', 'mesh': 0}],
        'meshes': [{'primitives': []}], 'bufferViews': [], 'accessors': [],
        'images': [], 'textures': [], 'materials': [],
        'samplers': [{'magFilter': 9729, 'minFilter': 9987,
                      'wrapS': 33071, 'wrapT': 33071}],
    }

    def view(data, target=None):
        while len(binary) % 4:
            binary.append(0)
        result = {'buffer': 0, 'byteOffset': len(binary), 'byteLength': len(data)}
        if target:
            result['target'] = target
        doc['bufferViews'].append(result)
        binary.extend(data)
        return len(doc['bufferViews']) - 1

    def accessor(values, width, kind, bounds=False):
        flat = [v for row in values for v in row]
        entry = {'bufferView': view(struct.pack('<' + 'f' * len(flat), *flat), 34962),
                 'componentType': 5126, 'count': len(values), 'type': kind}
        if bounds:
            entry['min'] = [min(row[i] for row in values) for i in range(width)]
            entry['max'] = [max(row[i] for row in values) for i in range(width)]
        doc['accessors'].append(entry)
        return len(doc['accessors']) - 1

    for number in range(1, 5):
        texture_ids = {}
        for role in ['D', 'N', 'R']:
            data = (ROOT / f'source/extracted/Texture/Plane_{number}_{role}.png').read_bytes()
            doc['images'].append({'bufferView': view(data), 'mimeType': 'image/png'})
            texture_ids[role] = len(doc['textures'])
            doc['textures'].append({'sampler': 0, 'source': len(doc['images']) - 1})
        doc['materials'].append({
            'name': f'grass-plane-{number}', 'doubleSided': True,
            'alphaMode': 'MASK', 'alphaCutoff': 0.5,
            'pbrMetallicRoughness': {
                'baseColorTexture': {'index': texture_ids['D']},
                'metallicFactor': 0, 'roughnessFactor': 1,
                'metallicRoughnessTexture': {'index': texture_ids['R']},
            }, 'normalTexture': {'index': texture_ids['N']},
        })
    for material, face in faces:
        # Triangulate the source winding and flip V for glTF image coordinates.
        vertices = [face[i] for i in [0, 1, 2, 0, 2, 3]]
        attrs = {
            'POSITION': accessor([positions[v[0]] for v in vertices], 3, 'VEC3', True),
            'NORMAL': accessor([normals[v[2]] for v in vertices], 3, 'VEC3'),
            'TEXCOORD_0': accessor([[uvs[v[1]][0], 1 - uvs[v[1]][1]]
                                    for v in vertices], 2, 'VEC2'),
        }
        doc['meshes'][0]['primitives'].append({'attributes': attrs, 'material': material})
    doc['buffers'] = [{'byteLength': len(binary)}]
    metadata = json.dumps(doc, separators=(',', ':')).encode()
    metadata += b' ' * (-len(metadata) % 4)
    binary.extend(b'\0' * (-len(binary) % 4))
    result = struct.pack('<III', 0x46546C67, 2, 28 + len(metadata) + len(binary))
    result += struct.pack('<II', len(metadata), 0x4E4F534A) + metadata
    result += struct.pack('<II', len(binary), 0x004E4942) + binary
    output = ROOT / 'runtime/grass-patch-001.glb'
    output.write_bytes(result)
    print(f'Built {output}: {len(result)} bytes, 8 triangles, 4 materials')


if __name__ == '__main__':
    build()
