const URL = 'http://127.0.0.1:8765/mcp'
let seq = 0
async function call(name, args = {}) {
  const r = await fetch(URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name, arguments: args } }),
  }).then((x) => x.json())
  const c = (r.result && r.result.content) || []
  return { isError: !!r.result?.isError, text: c.map((x) => x.text || '').join(' ') }
}

const probe = `
import bpy
mat = bpy.data.materials.new('__probe__')
mat.use_nodes = True
nt = mat.node_tree
print('NODES:', [(n.name, n.type) for n in nt.nodes])
bsdf = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
print('BY_TYPE_FOUND:', bsdf is not None)
if bsdf:
    print('INPUTS:', [(i.name, i.identifier) for i in bsdf.inputs if i.name in ('Base Color','Metallic','Roughness','Alpha','Emission Color','Emission Strength')])
bpy.data.materials.remove(mat)

# 渲染引擎探测：正确 vs 错误做法
import bpy
try:
    from bpy.types import RenderEngine
    print('ENGINE_CLASSES_FAIL:', type(RenderEngine).__name__)
except Exception as e:
    print('ENGINE_CLASSES_FAIL:', e)
print('ENGINE_ENUM:', [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items])
`

const r = await call('execute_python', { code: probe })
console.log('isError:', r.isError)
console.log(r.text.slice(0, 2500))
