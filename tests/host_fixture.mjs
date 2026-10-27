/** 执行真实宿主入口，只替换 SDK 绑定、环境启动和场景读取；不写 node_modules。 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { assertNativeToolSchema } from './native_schema_contract.mjs'

let sequence = 0
export async function createHostFixture(meshes, options = {}) {
  const indexUrl = new URL('../lib/index.js', import.meta.url)
  const key = '__ptc_host_fixture_' + (++sequence)
  const schemaKey = key + '_defineTool'
  globalThis[schemaKey] = options.defineTool || assertNativeToolSchema
  globalThis[key] = class {
    describe() { return 'offline-fixture' }
    async resolve() { return 'blender' }
    async extract() { return { meshes, skipped: [] } }
    async renderShots(shots) { return { shots: shots.map((shot) => ({ ...shot, path: null })) } }
    async dispose() {}
  }
  let source = readFileSync(indexUrl, 'utf8')
    .replace("import { defineTool } from '@deepseek-ai/dsh-tools'", 'const defineTool = globalThis[' + JSON.stringify(schemaKey) + ']')
    .replace("import { SceneSource } from './adapters/index.mjs'", 'const SceneSource = globalThis[' + JSON.stringify(key) + ']')
    .replace("import { ensureBlenderStack } from './blender-boot.mjs'",
      'const ensureBlenderStack = async () => ({ ok: true, steps: [] })')
    .replace(/from '(\.\/[^']+)'/g, (_match, relative) => 'from ' + JSON.stringify(new URL(relative, indexUrl).href))
    .replaceAll('import.meta.url', JSON.stringify(indexUrl.href))
  const module = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
  delete globalThis[key]
  delete globalThis[schemaKey]
  const handlers = new Map()
  const tools = new Map()
  const disposers = []
  let staticText = ''
  let contextText = () => ''
  const ctx = {
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
    on(event, handler) { handlers.set(event, handler); return () => handlers.delete(event) },
    get(name) { return name === 'systemPrompt' ? ctx.systemPrompt : name === 'tools' ? ctx.tools : undefined },
    tools: { register(spec) { tools.set(spec.name, spec) } },
    logger: () => () => {},
    systemPrompt: {
      section(info) { staticText = info.text },
      context(info) { contextText = info.text },
    },
  }
  module.apply(ctx, { autoBootBlender: false })
  return {
    tools, staticText,
    runtime: () => contextText(),
    emit: (event, ...args) => handlers.get(event)?.(...args),
    native: (name, args = {}) => handlers.get('tools/pre-execute')(
      { name: 'mcp__blender__' + name, arguments: args }, () => ({ kind: 'next' })),
    dispose() { for (const dispose of disposers.reverse()) dispose() },
    entryPath: fileURLToPath(indexUrl),
  }
}
