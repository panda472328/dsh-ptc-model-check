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

// 问：能不能通过 execute_python 把网格数据取出来？
const probe = `
import bpy, json, base64
import numpy as np

out = []
for o in bpy.context.scene.objects:
    if o.type != 'MESH':
        continue
    me = o.data
    nv = len(me.vertices)
    nt = len(me.loop_triangles) if hasattr(me, 'loop_triangles') else 0
    out.append({'name': o.name, 'verts': nv, 'tris': nt})

print('OBJECTS:', json.dumps(out, ensure_ascii=False))
print('HAS_NUMPY:', np is not None)
print('TOTAL_MESHES:', len(out))
`
const r = await call('execute_python', { code: probe })
console.log('isError:', r.isError)
console.log(r.text.slice(0, 1200))
