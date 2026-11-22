"""Build a static, bounded preview scene without saving the source Blender file."""
import math


def prepare_scene(bpy, report, triangle_budget=500000, instance_limit=256):
    source_scene = bpy.context.scene
    graph = bpy.context.evaluated_depsgraph_get()
    instances = [(item.object.original, item.matrix_world.copy())
                 for item in graph.object_instances if item.is_instance and item.object.type == 'MESH']
    donors = {system.settings.instance_object for obj in source_scene.objects
              for system in obj.particle_systems if system.settings.instance_object}
    largest = max((sum(len(face.vertices) - 2 for face in obj.data.polygons)
                   for obj in {item[0] for item in instances}), default=1)
    limit = min(instance_limit, max(1, triangle_budget // max(1, largest)))
    chosen = instances
    if len(instances) > limit:
        chosen = [instances[math.floor(i * len(instances) / limit)] for i in range(limit)]
        report['warnings'].append(
            f'Particle preview density reduced from {len(instances)} evaluated instances to {len(chosen)} '
            'for interactive rendering. The original Blender particle systems are unchanged.')
    report['particles'] = {'configured_particles': sum(system.settings.count for obj in source_scene.objects
        for system in obj.particle_systems), 'evaluated_instances': len(instances),
        'preview_instances': len(chosen), 'triangle_budget': triangle_budget}
    scene = bpy.data.scenes.new('Inventory static preview')
    scene.unit_settings.system = source_scene.unit_settings.system
    scene.unit_settings.scale_length = source_scene.unit_settings.scale_length
    meshes = {}

    def add(obj, matrix):
        if obj not in meshes:
            meshes[obj] = bpy.data.meshes.new_from_object(obj.evaluated_get(graph), depsgraph=graph)
        copy = bpy.data.objects.new(obj.name + ' preview', meshes[obj])
        copy.matrix_world = matrix
        scene.collection.objects.link(copy)

    for obj in source_scene.objects:
        if obj.type == 'MESH' and not obj.hide_render and obj not in donors:
            add(obj, obj.matrix_world.copy())
    for obj, matrix in chosen:
        add(obj, matrix)
    bpy.context.window.scene = scene
    return list(scene.objects)
