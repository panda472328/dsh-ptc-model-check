# -*- coding: utf-8 -*-
"""造一个已知答案的测试场景：tests/fixture.blend

  CubeA   (0,0,0)      尺寸 2        与 CubeB 重叠 0.4（深度）
  CubeB   (1.6,0,0)    尺寸 2        → 沿 X 方向插进 CubeA 0.4
  CubeC   (0,0,3)      尺寸 2        与 CubeA 不接触（间距 1）
  Floater (20,0,0)     尺寸 2        孤岛，最近间距 ≈19
  ThinPlate (-6,0,0)   尺寸 0.02 x 4 x 4   薄板，用于验证强制视角
  Cube.001 / Cube.002 / Cube.003：默认名，用于验证命名工具
"""
import bpy
import os

bpy.ops.wm.read_factory_settings(use_empty=True)


def cube(name, loc, scale):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=loc)
    o = bpy.context.active_object
    o.name = name
    o.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return o


cube('CubeA', (0, 0, 0), (2, 2, 2))
cube('CubeB', (1.6, 0, 0), (2, 2, 2))
cube('CubeC', (0, 0, 3), (2, 2, 2))
cube('Floater', (20, 0, 0), (2, 2, 2))
cube('ThinPlate', (-6, 0, 0), (0.02, 4, 4))
cube('Cube.001', (0, 6, 0), (1, 1, 1))
cube('Cube.002', (0, 8, 0), (1, 1, 1))
cube('Cube.003', (0, 10, 0), (1, 1, 1))

# ── 建物品组 ──
# 新规则要求「一个完整物品 = 一个 Collection」。
# 这里把 fixture 里的对象都归入一个组，模拟真实建模后的状态；
# 否则分组被判定为「不可靠」，检查永远不通过。
# （CubeA/B 相互穿透，用「插入」语义——它们属于同一个物品的零件。）
group = bpy.data.collections.new('测试物品')
bpy.context.scene.collection.children.link(group)
for name in ['CubeA', 'CubeB', 'CubeC', 'Floater', 'ThinPlate',
             'Cube.001', 'Cube.002', 'Cube.003']:
    o = bpy.data.objects.get(name)
    if o is None:
        continue
    if o.name in bpy.context.scene.collection.objects:
        bpy.context.scene.collection.objects.unlink(o)
    group.objects.link(o)

here = os.path.dirname(os.path.abspath(__file__))
path = os.path.join(here, 'fixture.blend')
bpy.ops.wm.save_as_mainfile(filepath=path)
print('SAVED', path)
