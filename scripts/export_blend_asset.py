"""Called only by the trusted Blender conversion wrapper; never saves the .blend."""
import json
import sys
from pathlib import Path
import bpy
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from blend_preview_scene import prepare_scene


def convert(source, output, report_path, asset_root):
    report = {"blender_version": bpy.app.version_string, "warnings": []}
    try:
        bpy.ops.wm.open_mainfile(filepath=str(source), load_ui=False, use_scripts=False)
        meshes = prepare_scene(bpy, report)
        used_materials = {material for obj in meshes for material in obj.data.materials if material}
        used_images = {node.image for material in used_materials if material.use_nodes
            for node in material.node_tree.nodes if node.type == 'TEX_IMAGE' and node.image}
        files = [file for file in (asset_root / 'source').rglob('*') if file.is_file()]
        missing = []
        assigned = set()
        for image in used_images:
            if image.source != 'FILE' or image.packed_file:
                continue
            name = image.filepath.replace('\\', '/').rsplit('/', 1)[-1]
            matches = [file for file in files if file.name.lower() == name.lower()]
            relative = Path(bpy.path.abspath(image.filepath)).resolve()
            if relative.is_relative_to(asset_root / 'source') and relative.is_file():
                matches = [relative]
            if len(matches) == 1:
                image.filepath = str(matches[0])
                image.reload()
                assigned.add(matches[0])
            else:
                missing.append(image)
        remaining = [file for file in files if file.suffix.lower() in {'.png', '.jpg', '.jpeg', '.tga', '.bmp', '.webp', '.tif', '.tiff', '.exr', '.hdr'} and file not in assigned]
        if len(missing) == 1 and len(remaining) == 1:
            image = missing.pop()
            report['warnings'].append(f'Relinked one missing texture to the sole supplied image, {remaining[0].name}; review the material.')
            image.filepath = str(remaining[0])
            image.reload()
        if missing:
            report['error'] = 'blender_missing_textures'
            report['missing_textures'] = [image.name for image in missing]
            raise RuntimeError('blender_missing_textures')
        # glTF can represent Principled directly. Simple Diffuse materials can
        # retain their color/texture by connecting them to a temporary Principled.
        for material in used_materials:
            if not material.use_nodes:
                continue
            nodes = material.node_tree.nodes
            if any(node.type == 'BSDF_PRINCIPLED' for node in nodes):
                continue
            outputs = [node for node in nodes if node.type == 'OUTPUT_MATERIAL' and node.is_active_output]
            if not outputs or not outputs[0].inputs['Surface'].is_linked:
                continue
            shader = outputs[0].inputs['Surface'].links[0].from_node
            if shader.type == 'BSDF_DIFFUSE':
                principled = nodes.new('ShaderNodeBsdfPrincipled')
                color = shader.inputs['Color']
                principled.inputs['Base Color'].default_value = color.default_value
                if color.is_linked:
                    material.node_tree.links.new(color.links[0].from_socket, principled.inputs['Base Color'])
                principled.inputs['Roughness'].default_value = 1
                material.node_tree.links.new(principled.outputs['BSDF'], outputs[0].inputs['Surface'])
                report['warnings'].append('Adapted a Diffuse material for glTF; original Blender file unchanged.')
            else:
                report['warnings'].append('A non-Principled material may require baking or manual adjustment.')
        if not meshes:
            report['error'] = 'blender_no_mesh'
            raise RuntimeError('blender_no_mesh')
        output.parent.mkdir(parents=True, exist_ok=True)
        bpy.ops.export_scene.gltf(filepath=str(output), export_format='GLB',
            export_apply=False, export_animations=False, export_cameras=False,
            export_lights=False, export_extras=False, export_yup=True, use_active_scene=True)
        report.update({"mesh_objects": len(meshes), "materials": len(bpy.data.materials),
            "source_unit_scale": bpy.context.scene.unit_settings.scale_length,
            "source_unit_system": bpy.context.scene.unit_settings.system,
            "export": "glb", "original_saved": False})
    finally:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    args = sys.argv[sys.argv.index('--') + 1:]
    convert(*(Path(arg).resolve() for arg in args))
