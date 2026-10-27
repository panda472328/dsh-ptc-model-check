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

// 1) 记住当前场景
const before = await call('get_scene_info', { detail: 'brief' })
console.log('当前场景:', before.text.slice(0, 200))

// 2) 活场景里加一个只有 MCP 能看到的对象（不存盘）
const mark = 'LIVE_MARK_' + Date.now().toString(36)
const add = await call('execute_python', {
  code: `import bpy\nbpy.ops.mesh.primitive_cube_add(size=0.3, location=(9,9,9))\no=bpy.context.view_layer.objects.active\no.name='${mark}'\nprint('added', o.name)`,
})
console.log('活场景加了:', mark, '→', add.isError ? '失败' : '成功')

// 3) 用 MCP 立刻查——应该能看到
const live = await call('get_scene_info', { detail: 'brief' })
console.log('MCP 查活场景含标记:', live.text.includes(mark))

console.log('\n结论：MCP 看的是活场景。')
console.log('但插件的 model_loop 是另开 blender -b 读磁盘文件，')
console.log('所以只要模型不 save_blend，检查结果就是旧的。')
