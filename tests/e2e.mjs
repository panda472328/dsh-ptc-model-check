/**
 * 端到端自测（不需要 DSH 宿主）：直接调 tools.mjs 里的工具定义。
 *   node tests/e2e.mjs <blend文件> [--keep]
 */
import { SceneSource } from '../lib/adapters/index.mjs'
import { buildTools } from '../lib/tools.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = path.resolve(HERE, '..')

const blend = process.argv[2]
if (!blend) {
  console.error('用法：node tests/e2e.mjs <blend文件>')
  process.exit(2)
}

const cfg = {
  source: 'blender', blend, obj: '', url: '', cdpPort: 0, targetMatch: '', blenderPath: '',
  minDepth: 0.0005, minRatio: 0.005, minGap: 0.01, minGapRatio: 0.02,
  maxObjects: 3000, maxTriangles: 2000000,
}
const sessions = new Map()
const sourceFor = (overrides = {}) => {
  const opts = {
    source: overrides.source || cfg.source,
    blend: overrides.blend || cfg.blend,
    blenderPath: cfg.blenderPath,
    maxObjects: cfg.maxObjects, maxTriangles: cfg.maxTriangles,
  }
  const key = JSON.stringify(opts)
  if (!sessions.has(key)) sessions.set(key, new SceneSource(opts, { packageDir: PACKAGE_DIR, log: (m) => console.error('[src]', m) }))
  return sessions.get(key)
}
const state = {}
const attachedImages = []
const hostCtx = {
  get: (key) => (key === 'attachments' ? {
    imageLimits: { mediaTypes: ['image/png'] },
    async saveImage({ data, mediaType, name }) {
      attachedImages.push({ name, bytes: data.length, mediaType })
      return { attachmentId: 'att-' + attachedImages.length, mediaType, bytes: data.length, width: 320, height: 320, name }
    },
  } : undefined),
}
const tools = buildTools({ sourceFor, config: () => cfg, remember: (k, v) => { state[k] = v }, hostCtx })
const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
const exec = { signal: new AbortController().signal }

async function call(name, args) {
  const t0 = Date.now()
  const v = await byName[name].execute(args, exec)
  const blocks = byName[name].output.render(args, v)
  const texts = blocks.filter((b) => b.type === 'text').map((b) => b.text)
  const images = blocks.filter((b) => b.type === 'image')
  return { value: v, texts, images, ms: Date.now() - t0 }
}

function head(s, n = 14) {
  const lines = s.split('\n')
  return lines.slice(0, n).join('\n') + (lines.length > n ? '\n…(共 ' + lines.length + ' 行)' : '')
}

try {
  console.log('=== model_source status ===')
  const src = await call('model_source', { action: 'status' })
  console.log(head(src.texts[0]), '\n')

  console.log('=== model_naming scan ===')
  const scan = await call('model_naming', { action: 'scan', limit: 8 })
  console.log(head(scan.texts[0]), '\n')

  console.log('=== model_interference ===')
  const inter = await call('model_interference', {})
  console.log(head(inter.texts[0]), '\n')

  console.log('=== model_isolation ===')
  const iso = await call('model_isolation', {})
  console.log(head(iso.texts[0]), '\n')

  console.log('=== model_check ===')
  const chk = await call('model_check', {})
  console.log(head(chk.texts[0], 20), '\n')

  console.log('=== model_screenshot (scene) ===')
  const shot = await call('model_screenshot', { target: 'scene', resolution: 320, purpose: '自测' })
  console.log(head(shot.texts[0]), 'images:', shot.images.length, '\n')

  if (state.check && state.check.interference.items.length) {
    const p = state.check.interference.items[0].a
    console.log('=== model_screenshot (part ' + p + ') ===')
    const s2 = await call('model_screenshot', { target: p, resolution: 320 })
    console.log(head(s2.texts[0]), 'images:', s2.images.length, '\n')
  }

  console.log('ALL_OK')
} catch (e) {
  console.error('FAILED:', e && e.stack || e)
  process.exitCode = 1
} finally {
  for (const [, s] of sessions) { try { await s.dispose() } catch { /* ignore */ } }
}
