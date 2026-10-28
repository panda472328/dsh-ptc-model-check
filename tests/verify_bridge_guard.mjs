/**
 * 建模测试 32 的三个修复的回归：
 *   ① 断连可识别（`mcp-client(blender): server is disconnected`）→ 不能再报「就绪」
 *   ② 自建 socket / JSON-RPC 桥会被 pre-execute 拒绝
 *   ③ 启动期监督插件已接线（profile 层，先拉起服务器再让 mcp-client 连）
 *
 * 32 的事实：DSH 启动时服务器没起 → mcp-client 首次连接失败后停在 disconnected
 * → 插件探测全绿报「就绪 ✓」→ 模型自己写 Python 直连 addon 的 9876
 * → 146 次调用里 0 次 mcp__blender__*、0 次 model_loop。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { isMcpClientDisconnected, isNativeToolMissing, classifyEnv } from '../lib/blender-boot.mjs'
import { detectHandwrittenBridge } from '../lib/core/bridge-guard.mjs'

const disconnectedResult = {
  isError: true,
  error: { message: 'Error: mcp-client(blender): server is disconnected' },
}

console.log('=== 1. 断连识别（只认真实失败，不推断）===')
assert.equal(isMcpClientDisconnected('list_mcp_resources', disconnectedResult), true,
  '资源工具探到的断连也必须算')
assert.equal(isMcpClientDisconnected('mcp__blender__look', disconnectedResult), true)
assert.equal(isMcpClientDisconnected('mcp__blender__look', { isError: false }), false, '成功结果不能算断连')
assert.equal(isMcpClientDisconnected('mcp__blender__look', { isError: true, error: { message: 'timeout' } }), false,
  '超时不是断连')
assert.equal(isMcpClientDisconnected('pwsh', { isError: true, error: { message: 'mcp-client(blender): server is disconnected' } }),
  true, '不限工具名：模型常先用旁路工具探到')
/* 与「没找到工具」不能混淆：处理方式相反 */
assert.equal(isNativeToolMissing('mcp__blender__look', disconnectedResult), false,
  '断连不能被当成 tool not found（那会让人去重装插件）')
console.log('  ✓ 识别断连，且与 tool not found 分开')

console.log('\n=== 2. 环境分类：断连优先级高于 ok ===')
const online = { ok: true, launched: true, steps: ['MCP 服务器在线（12 个工具）', 'Blender addon 在线（端口 9876）'] }
assert.equal(classifyEnv({ ...online, mcpDisconnected: true }).kind, 'mcp-client-disconnected')
assert.equal(classifyEnv({ ...online, mcpDisconnected: true }).needsInstallDoc, false,
  '断连不该让人去读安装文档：装包救不了，要重启')
assert.equal(classifyEnv(online).kind, 'ok', '没有断连记录时仍是就绪')
console.log('  ✓ 断连压过 ok，且不指向安装文档')

console.log('\n=== 3. 状态文本：说清症状 / 唯一解法 / 禁止搭桥 ===')
{
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const start = src.indexOf('function buildStateText(')
  let depth = 0
  let i = src.indexOf('{', start)
  let end = i
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } }
  }
  const fn = src.slice(start, end)
  const buildStateText = new Function('PLUGIN_VERSION', 'buildDetailGuidance', 'classifyEnv',
    fn + '\nreturn buildStateText')('test', () => '', classifyEnv)

  const state = {
    version: 'test', todo: null, phase: {}, modeling: null, research: null, review: null, memoryText: '',
    blenderReady: { ...online, mcpDisconnected: true, lastNativeCall: 'list_mcp_resources' },
  }
  const txt = buildStateText(state)
  assert.match(txt, /MCP 客户端已断连/, '要说清是断连')
  assert.match(txt, /server is disconnected/, '要给原始报文，让模型能对上')
  assert.match(txt, /完全退出 DSH 再启动/, '要给唯一有效的解法')
  assert.match(txt, /禁止自己搭桥/, '必须明确禁止搭桥')
  assert.match(txt, /9876|8765/, '要点名不能直连的端口')
  assert.match(txt, /建模测试 32/, '要给出真实后果，否则模型不当回事')
  assert.doesNotMatch(txt, /MCP 服务器可达，但没接进 DSH/, '断连不能套用「没注册」的文案')
  console.log('  ✓ 断连文案完整，且没有串到「没注册」分支')
}

console.log('\n=== 4. 搭桥拦截：命中要拦，别误杀 ===')
/* 32 真实写的那类脚本：Python 直连 addon socket */
const realBridge = `
import socket, json
s = socket.create_connection(('127.0.0.1', 9876), timeout=10)
s.sendall((json.dumps({'type': 'execute_code', 'code': code}) + '\\n').encode())
print(s.recv(65536).decode())
`
assert.ok(detectHandwrittenBridge('write', { file_path: 'D:/x/bpy_send.py', content: realBridge }),
  '写直连 9876 的 Python 必须拦')
assert.ok(detectHandwrittenBridge('pwsh', { command: 'python -c "import socket; socket.create_connection((\'127.0.0.1\',9876))"' }),
  '命令行里内联 socket 也必须拦')
assert.ok(detectHandwrittenBridge('pwsh', {
  command: "$r = Invoke-WebRequest -Method Post -Uri 'http://127.0.0.1:8765/mcp' -Body '{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\"}'",
}), '手写 JSON-RPC 打 8765 必须拦')
assert.ok(detectHandwrittenBridge('edit', { new_string: 's = socket.create_connection(("127.0.0.1", 9876))' }),
  'edit 里塞桥接代码也要拦')

/* 不该拦的 */
assert.equal(detectHandwrittenBridge('pwsh', { command: 'Test-NetConnection 127.0.0.1 -Port 9876' }), null,
  '探端口不是搭桥')
assert.equal(detectHandwrittenBridge('pwsh', { command: 'Select-String -Path src/server.mjs -Pattern 9876' }), null,
  '读源码不是搭桥')
assert.equal(detectHandwrittenBridge('write', { content: 'blender-mcp 的 addon 在 9876 端口监听。' }), null,
  '写文档提到端口不拦')
assert.equal(detectHandwrittenBridge('read', { file_path: 'D:/x/bpy_send.py' }), null, '读不拦')
assert.equal(detectHandwrittenBridge('pwsh', { command: 'node src/server.mjs --port 8765' }), null,
  '自己起服务器（不带手写 JSON-RPC）不算搭桥')
console.log('  ✓ 5 类命中全拦，5 类正常操作不误杀')

console.log('\n=== 5. 启动期监督已接线 ===')
{
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /id: ptc-blender-supervisor/, 'patch 里必须有监督行')
  assert.match(patch, /name: '@local\/ptc-model-check\/supervisor'/, '必须指向子路径导出')
  /* 监督必须在 preset 之前：否则它随预设加载，又变成「会话创建才执行」 */
  const supAt = patch.indexOf('ptc-blender-supervisor')
  const presetAt = patch.indexOf('id: preset-modeling')
  assert.ok(supAt > 0 && supAt < presetAt, '监督行必须排在 preset 之前（profile 层先执行）')

  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.exports['./supervisor'], './lib/supervisor.mjs', 'package.json 要导出 supervisor 子路径')

  /* 真加载一次：导出 name + apply，apply 能注册 effect 且不抛 */
  const mod = await import('../lib/supervisor.mjs')
  assert.equal(typeof mod.apply, 'function')
  assert.equal(mod.name, 'ptc-blender-supervisor')
  let effectInstalled = false
  mod.apply({
    logger: () => () => {},
    effect: (fn) => { effectInstalled = true; const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
  }, { mcpPort: 8799, blenderPort: 9876 })
  assert.equal(effectInstalled, true, 'apply 必须注册 effect')
  console.log('  ✓ 监督行在 preset 之前、导出可用、apply 不抛')
}

console.log('\n=== 6. mcp-client 重连策略已放宽 ===')
{
  const mcpPatch = readFileSync(new URL('../../blender-mcp/cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(mcpPatch, /maxAttempts:\s*100000/, '重连次数要放开（30 次会过早放弃，32 的起因）')
  assert.match(mcpPatch, /maxDelayMs:\s*5000/, '间隔上限压到 5s，服务器一出现就接上')
  console.log('  ✓ 重连：100000 次 × 最长 5s')
}

console.log('\nBRIDGE_GUARD_OK')
