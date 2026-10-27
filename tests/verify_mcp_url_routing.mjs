import assert from 'node:assert/strict'
import { unlink } from 'node:fs/promises'
import { SceneSource } from '../lib/adapters/index.mjs'
import { findOwnedBlenderPid, mcpPortFromUrl } from '../lib/blender-boot.mjs'
import { buildTools } from '../lib/tools.mjs'

const customUrl = 'http://127.0.0.1:9911/custom/mcp'
const originalFetch = globalThis.fetch
const calls = []
globalThis.fetch = async (url, init) => {
  const request = JSON.parse(init.body)
  const name = request.params?.name
  calls.push({ url: String(url), name })
  let result
  if (request.method === 'tools/list') result = { tools: [{ name: 'ping' }] }
  else if (name === 'ping') result = { content: [{ type: 'text', text: 'pong' }] }
  else if (name === 'export_geometry') {
    result = { content: [{ type: 'text', text: JSON.stringify({ meshes: [], skipped: [] }) }] }
  } else if (name === 'look') {
    result = { content: [{ type: 'image', mimeType: 'image/png', data: 'AA==' }] }
  } else throw new Error('unexpected MCP call: ' + name)
  return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: request.id, result }) }
}

try {
  assert.equal(mcpPortFromUrl(customUrl, 8765), 9911)
  assert.equal(mcpPortFromUrl('https://localhost/mcp', 8765), 443)
  assert.equal(mcpPortFromUrl('not a URL', 8765), 8765)

  const source = new SceneSource({ source: 'live', mcpUrl: customUrl })
  await source.extract()
  const rendered = await source.renderShots([{ view: 'front', ortho: true }])
  assert.ok(calls.some((call) => call.name === 'ping' && call.url === customUrl), 'probe uses the selected URL')
  assert.ok(calls.some((call) => call.name === 'export_geometry' && call.url === customUrl), 'extract uses the selected URL')
  assert.ok(calls.some((call) => call.name === 'look' && call.url === customUrl), 'render uses the selected URL')
  for (const shot of rendered.shots) if (shot.path) await unlink(shot.path).catch(() => {})
  await source.dispose()

  const expectedExe = 'C:/Blender/blender.exe'
  const owned = new Map([[111, expectedExe], [222, expectedExe]])
  const verified = await findOwnedBlenderPid(expectedExe, owned, async (pid) => (
    pid === 111 ? 'c:/blender/BLENDER.exe' : 'C:/Other/blender.exe'
  ))
  assert.equal(verified, 111, 'restart candidates must still resolve to the launched executable')

  const mismatched = new Map([[222, expectedExe]])
  assert.equal(await findOwnedBlenderPid(expectedExe, mismatched, async () => 'C:/Other/blender.exe'), null)
  assert.equal(mismatched.has(222), false, 'a PID with a different executable is discarded')

  const unverifiable = new Map([[333, expectedExe]])
  assert.equal(await findOwnedBlenderPid(expectedExe, unverifiable, async () => null), null)
  assert.equal(unverifiable.size, 0, 'an unverifiable PID is never eligible for restart')

  let selectedMcpUrl = null
  let configuredMcpUrl = 'http://127.0.0.1:8765/mcp'
  const readyTools = buildTools({
    sourceFor: () => { throw new Error('source adapter should not be used by blender_ready') },
    setMcpUrl(url) { selectedMcpUrl = url },
    config: () => ({
      mcpUrl: configuredMcpUrl, mcpPort: 8765,
      blenderPort: 9876, autoBootBlender: false, maxObjects: 20, maxTriangles: 1000,
    }),
  })
  const readyTool = readyTools.find((tool) => tool.name === 'blender_ready')
  const endpointMismatch = await readyTool.execute({
    mcp_url: customUrl,
    auto_launch: false,
  }, {})
  assert.equal(selectedMcpUrl, customUrl, 'blender_ready selects the endpoint for subsequent source tools')
  assert.equal(endpointMismatch.mcpUrl, customUrl)
  assert.equal(endpointMismatch.mcpPort, 9911, 'the server port follows the custom MCP URL')
  assert.equal(endpointMismatch.ready, false, 'a per-call URL cannot reconfigure the native DSH client')
  assert.equal(endpointMismatch.nativeEndpointAligned, false)

  configuredMcpUrl = customUrl
  const aligned = await readyTool.execute({ mcp_url: customUrl, auto_launch: false }, {})
  assert.equal(aligned.nativeEndpointAligned, true)

  console.log('MCP URL routing and Blender ownership checks passed')
} finally {
  globalThis.fetch = originalFetch
}
