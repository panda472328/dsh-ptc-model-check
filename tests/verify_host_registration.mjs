/** 可传宿主 SDK 入口，用 Electron 的 Node 模式运行同一测试，验证真实 defineTool。 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { buildTools } from '../lib/tools.mjs'
import { assertNativeToolSchema } from './native_schema_contract.mjs'
import { createHostFixture } from './host_fixture.mjs'

const sdkPath = process.argv[2]
const defineTool = sdkPath
  ? (await import(pathToFileURL(sdkPath).href)).defineTool
  : assertNativeToolSchema
assert.equal(typeof defineTool, 'function')
const specs = buildTools({})
for (const spec of specs) assert.doesNotThrow(() => defineTool(spec), spec.name)

// 原故障必须可重现，确保测试不再以恒等函数绕过注册校验。
const loop = specs.find((t) => t.name === 'model_loop')
for (const keyword of ['minimum', 'maximum']) {
  assert.throws(() => defineTool({ ...loop, parameters: { ...loop.parameters,
    triangle_work_budget: { type: 'integer', [keyword]: 0 },
  } }), new RegExp('triangle_work_budget\\.' + keyword))
}
assert.throws(() => defineTool({ ...loop, parameters: {
  nested: { type: 'array', items: { type: 'number', minimum: 0 } },
} }), /minimum/, 'nested schemas are also validated')

const host = await createHostFixture([], { defineTool })
try {
  assert.equal(host.tools.size, 11, 'real plugin apply registers every tool without a scene connection')
  assert.ok(host.staticText.includes('探索') && host.staticText.includes('多个子代理'))
} finally { host.dispose() }
console.log('HOST_REGISTRATION_OK: 11 tools, plugin apply, and rejected regression cases; '
  + (sdkPath ? 'actual host SDK' : 'offline compatibility contract'))
