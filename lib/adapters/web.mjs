/**
 * 网页建模适配器：与页面里跑着的 three.js / Babylon / 自研引擎通信。
 *
 * 两条通道，自动择优：
 *   1. WS  —— 页面开一个 WebSocket 服务（three.js 里很常见），按行 JSON 收发。**推荐**。
 *   2. CDP —— 用 Chrome/Edge 的 --remote-debugging-port，向页面注入一段采集脚本，
 *             直接遍历 THREE 场景或自定义 window 钩子，把三角网格取回来。
 *
 * 页面侧只需要实现两个 op：
 *   ping   → { engine: 'three', ... }
 *   extract → { meshes: [{ id, part, positions(base64 Float32), indices(base64 Uint32) }] }
 * runtime/browser-agent.js 是给页面用的参考实现（粘贴即可）。
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { makeMesh } from '../core/geometry.mjs'

function decodeFloat32(b64) {
  const buf = Buffer.from(b64, 'base64')
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
}

function decodeUint32(b64) {
  const buf = Buffer.from(b64, 'base64')
  return new Uint32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
}

function toMeshes(raw) {
  const list = (raw && raw.meshes) || []
  return list.map((m) => makeMesh(
    String(m.id || m.part || 'mesh'),
    String(m.part || m.id || 'mesh'),
    decodeFloat32(m.positions),
    decodeUint32(m.indices),
    { materials: m.materials || [], hidden: !!m.hidden, center: m.center, source: 'web' },
  ))
}

/* ───────────────────────────── WS 通道 ───────────────────────────── */

export class WebSocketSession {
  constructor({ url, timeoutMs = 60000, log }) {
    this.url = url
    this.timeoutMs = timeoutMs
    this.log = log || (() => {})
    this.ws = null
    this.seq = 0
    this.pending = new Map()
  }

  async start() {
    if (this.ws && this.ws.readyState === 1) return
    const { WebSocket } = globalThis
    if (!WebSocket) throw new Error('当前 Node 没有内置 WebSocket（需要 Node 22+）')
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url)
      const timer = setTimeout(() => reject(new Error('连接网页桥超时：' + this.url)), 10000)
      ws.addEventListener('open', () => { clearTimeout(timer); resolve() })
      ws.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error('网页桥连接失败：' + this.url + ' ' + String(e && e.message || ''))) })
      ws.addEventListener('message', (ev) => this.onMessage(ev.data))
      ws.addEventListener('close', () => {
        for (const [, p] of this.pending) p.reject(new Error('网页桥已断开'))
        this.pending.clear()
        this.ws = null
      })
      this.ws = ws
    })
  }

  onMessage(data) {
    let msg
    try { msg = JSON.parse(typeof data === 'string' ? data : String(data)) } catch { return }
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    if (msg.ok === false) p.reject(new Error(String(msg.error || '网页桥返回错误')))
    else p.resolve(msg.result ?? msg)
  }

  async call(op, args = {}) {
    await this.start()
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('网页桥调用超时：' + op)) }, this.timeoutMs)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      this.ws.send(JSON.stringify({ id, op, args }))
    })
  }

  async extract(opts = {}) {
    const raw = await this.call('extract', opts)
    return { meshes: toMeshes(raw), skipped: raw.skipped || [], ms: raw.ms }
  }

  async info() {
    return this.call('info', {})
  }

  async dispose() {
    try { if (this.ws) this.ws.close() } catch { /* ignore */ }
    this.ws = null
  }
}

/* ──────────────────────────── CDP 通道 ──────────────────────────── */

async function listTargets(port) {
  const res = await fetch('http://127.0.0.1:' + port + '/json/list')
  if (!res.ok) throw new Error('CDP /json/list 失败：' + res.status)
  return res.json()
}

export class CdpSession {
  constructor({ port, targetMatch, packageDir, timeoutMs = 60000, log }) {
    this.port = port
    this.targetMatch = targetMatch || ''
    this.packageDir = packageDir
    this.timeoutMs = timeoutMs
    this.log = log || (() => {})
    this.ws = null
    this.seq = 0
    this.pending = new Map()
    this.sessionId = null
  }

  async start() {
    if (this.ws && this.ws.readyState === 1) return
    const targets = await listTargets(this.port)
    const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    if (pages.length === 0) throw new Error('CDP 端口 ' + this.port + ' 上没有可调试页面')
    const pick = this.targetMatch
      ? pages.find((p) => (p.url || '').includes(this.targetMatch))
      : pages[0]
    if (!pick) throw new Error('CDP 未找到匹配 targetMatch="' + this.targetMatch + '" 的页面')
    this.log('CDP 目标：' + pick.url)
    const { WebSocket } = globalThis
    if (!WebSocket) throw new Error('当前 Node 没有内置 WebSocket（需要 Node 22+）')
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(pick.webSocketDebuggerUrl)
      const timer = setTimeout(() => reject(new Error('CDP 连接超时')), 10000)
      ws.addEventListener('open', () => { clearTimeout(timer); resolve() })
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP 连接失败')) })
      ws.addEventListener('message', (ev) => this.onMessage(ev.data))
      ws.addEventListener('close', () => { this.ws = null })
      this.ws = ws
    })
  }

  onMessage(data) {
    let msg
    try { msg = JSON.parse(typeof data === 'string' ? data : String(data)) } catch { return }
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    if (msg.error) p.reject(new Error('CDP 错误：' + JSON.stringify(msg.error)))
    else p.resolve(msg.result)
  }

  send(method, params = {}) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP 调用超时：' + method)) }, this.timeoutMs)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: false,
    })
    if (r && r.exceptionDetails) {
      throw new Error('页面执行异常：' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text))
    }
    return r && r.result ? r.result.value : undefined
  }

  async agentSource() {
    const p = path.join(this.packageDir, 'runtime', 'browser-agent.js')
    return readFile(p, 'utf8')
  }

  async ensureAgent() {
    const has = await this.evaluate('!!(window.__PTC_BRIDGE__ && window.__PTC_BRIDGE__.extract)')
    if (has) return
    const src = await this.agentSource()
    await this.evaluate('(function(){ ' + src + '\n; true })()')
    const ok = await this.evaluate('!!(window.__PTC_BRIDGE__ && window.__PTC_BRIDGE__.extract)')
    if (!ok) throw new Error('页面注入后仍找不到 __PTC_BRIDGE__：页面可能禁止 eval 或建模库不在全局')
  }

  async extract(opts = {}) {
    await this.start()
    await this.ensureAgent()
    const raw = await this.evaluate('window.__PTC_BRIDGE__.extract(' + JSON.stringify(opts) + ')')
    return { meshes: toMeshes(raw), skipped: (raw && raw.skipped) || [], ms: raw && raw.ms }
  }

  async info() {
    await this.start()
    await this.ensureAgent()
    return this.evaluate('window.__PTC_BRIDGE__.info()')
  }

  async call(op, args = {}) {
    if (op !== 'rename') throw new Error('CDP 网页桥不支持操作：' + op)
    if (!Array.isArray(args)) throw new TypeError('CDP rename 参数必须是 assignments 数组')
    await this.start()
    await this.ensureAgent()
    const assignments = JSON.stringify(args)
    return this.evaluate('window.__PTC_BRIDGE__.rename(' + assignments + ')')
  }

  async screenshot() {
    await this.start()
    const r = await this.send('Page.captureScreenshot', { format: 'png' })
    return Buffer.from(r.data, 'base64')
  }

  async dispose() {
    try { if (this.ws) this.ws.close() } catch { /* ignore */ }
    this.ws = null
  }
}
