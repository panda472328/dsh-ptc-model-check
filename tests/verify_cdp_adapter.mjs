import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { CdpSession } from '../lib/adapters/web.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const originalFetch = globalThis.fetch
const originalWebSocket = globalThis.WebSocket
const sockets = []
let targets = []
const renameExpressions = []
const sceneObjects = [{ name: 'mesh-1', uuid: 'mesh-1', userData: {} }]
const pageWindow = {
  __PTC_SCENE__: { traverse(callback) { sceneObjects.forEach(callback) } },
}

class FakeWebSocket {
  constructor(url) {
    this.url = url
    this.readyState = 0
    this.listeners = new Map()
    sockets.push(this)
    queueMicrotask(() => {
      this.readyState = 1
      this.emit('open')
    })
  }

  addEventListener(name, handler) {
    const handlers = this.listeners.get(name) || []
    handlers.push(handler)
    this.listeners.set(name, handlers)
  }

  emit(name, event = {}) {
    for (const handler of this.listeners.get(name) || []) handler(event)
  }

  send(payload) {
    const request = JSON.parse(payload)
    const expression = request.params.expression
    let value
    try {
      value = runInNewContext(expression, { window: pageWindow })
    } catch (error) {
      this.emit('message', {
        data: JSON.stringify({
          id: request.id,
          result: { exceptionDetails: { text: error.message } },
        }),
      })
      return
    }
    if (expression.includes('.rename(')) {
      renameExpressions.push(expression)
    }
    queueMicrotask(() => this.emit('message', {
      data: JSON.stringify({
        id: request.id,
        result: { result: { type: typeof value, value } },
      }),
    }))
  }

  close() {
    this.readyState = 3
    this.emit('close')
  }
}

try {
  globalThis.fetch = async () => ({ ok: true, json: async () => targets })
  globalThis.WebSocket = FakeWebSocket
  const agentSource = await readFile(path.resolve(HERE, '..', 'runtime', 'browser-agent.js'), 'utf8')
  runInNewContext(agentSource, { window: pageWindow })

  targets = [
    { type: 'page', url: 'https://example.test/other', webSocketDebuggerUrl: 'ws://other' },
    { type: 'page', url: 'https://example.test/model-viewer', webSocketDebuggerUrl: 'ws://model' },
  ]
  const session = new CdpSession({
    port: 9222,
    targetMatch: 'model-viewer',
    packageDir: path.resolve(HERE, '..'),
  })
  const assignments = [{ id: 'mesh-1', part: 'part"; window.location = "unsafe' }]
  const result = await session.call('rename', assignments)

  assert.equal(sockets.at(-1).url, 'ws://model', 'targetMatch selects the matching page')
  assert.equal(result.applied[0].from, 'mesh-1', 'CDP rename returns the bridge result')
  assert.equal(result.applied[0].part, assignments[0].part, 'the bridge receives the assignment payload')
  assert.equal(sceneObjects[0].name, assignments[0].part, 'the browser bridge applies the rename')
  assert.equal(
    renameExpressions.at(-1),
    'window.__PTC_BRIDGE__.rename(' + JSON.stringify(assignments) + ')',
    'rename assignments are JSON encoded as a single bridge argument',
  )
  await session.dispose()

  const createdBeforeMismatch = sockets.length
  const mismatch = new CdpSession({
    port: 9222,
    targetMatch: 'missing-page',
    packageDir: path.resolve(HERE, '..'),
  })
  await assert.rejects(mismatch.start(), /未找到匹配 targetMatch/)
  assert.equal(sockets.length, createdBeforeMismatch, 'a target mismatch opens no CDP socket')
  await assert.rejects(mismatch.call('unsupported', []), /不支持操作/)

  console.log('CDP adapter checks passed')
} finally {
  globalThis.fetch = originalFetch
  if (originalWebSocket === undefined) delete globalThis.WebSocket
  else globalThis.WebSocket = originalWebSocket
}
