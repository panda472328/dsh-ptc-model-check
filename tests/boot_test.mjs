/**
 * 环境自检/自启测试。
 *
 * 不依赖 DSH，直接测 blender-boot.mjs：
 *   node tests/boot_test.mjs            # 只检查，不启动
 *   node tests/boot_test.mjs --launch   # 真的拉起 Blender 验证
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  probePort, probeMcp, detectBlender, blenderRunning,
  waitForPort, ensureBlenderStack,
} from '../lib/blender-boot.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = path.resolve(HERE, '..')
const SERVER = 'D:/dsh插件制作/blender-mcp/src/server.mjs'

let failed = 0
function expect(label, cond, detail) {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')) }
}

console.log('=== 基础探测 ===')
const mcp = await probeMcp('http://127.0.0.1:8765/mcp')
console.log('  MCP:', JSON.stringify(mcp))
expect('probeMcp 返回结构化结果', typeof mcp.ok === 'boolean')

const addonUp = await probePort(9876, '127.0.0.1', 800)
console.log('  addon 端口 9876:', addonUp)
expect('probePort 返回布尔', typeof addonUp === 'boolean')

const running = await blenderRunning()
console.log('  Blender 进程:', running)
expect('blenderRunning 返回布尔', typeof running === 'boolean')

const exe = detectBlender('')
console.log('  blender.exe:', exe)
expect('找到 blender.exe', !!exe, '未找到')
if (exe) expect('blender.exe 路径存在', existsSync(exe))

console.log('\n=== 只检查模式（autoLaunch=false）===')
const dry = await ensureBlenderStack({
  mcpUrl: 'http://127.0.0.1:8765/mcp',
  mcpPort: 8765,
  blenderPort: 9876,
  serverScript: SERVER,
  autoLaunch: false,
})
console.log('  ok=' + dry.ok + ' action=' + dry.action)
for (const s of dry.steps) console.log('    · ' + s)
expect('只检查时不启动任何东西', dry.action === 'none' || dry.action === 'need-manual-start',
  String(dry.action))

if (process.argv.includes('--launch')) {
  console.log('\n=== 自动启动模式（会真的拉起 Blender）===')
  const before = await blenderRunning()
  console.log('  启动前 Blender 在跑:', before)

  const res = await ensureBlenderStack({
    mcpUrl: 'http://127.0.0.1:8765/mcp',
    mcpPort: 8765,
    blenderPort: 9876,
    serverScript: SERVER,
    autoLaunch: true,
  })
  console.log('  ok=' + res.ok + ' action=' + res.action)
  for (const s of res.steps) console.log('    · ' + s)
  if (res.hint) console.log('  hint: ' + res.hint)

  expect('自启后环境就绪', res.ok, 'action=' + res.action)
  expect('Blender 进程已启动', await blenderRunning())
  expect('addon 端口已监听', await probePort(9876))

  /* 启动后真的能通过 MCP 调工具吗 */
  const j = await fetch('http://127.0.0.1:8765/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'ping', arguments: {} },
    }),
  }).then((r) => r.json()).catch((e) => ({ error: String(e.message) }))
  const txt = (j.result?.content || []).map((c) => c.text).join(' ')
  console.log('  MCP ping →', txt.slice(0, 120))
  expect('自启后 MCP 能调到 Blender', /pong/.test(txt), txt.slice(0, 200))
} else {
  console.log('\n（跳过真实启动测试；加 --launch 会真的打开 Blender）')
}

console.log('\n' + (failed === 0 ? 'BOOT_OK' : 'BOOT_FAILED ' + failed))
process.exitCode = failed === 0 ? 0 : 1
