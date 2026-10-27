/**
 * 适配器门面：统一 `extract / naming / render / info`，让工具层不关心是哪个引擎。
 */

import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { WebSocketSession, CdpSession } from './web.mjs'
import { loadObjFile, sceneInfoFromMeshes } from './obj.mjs'
import { extractLive, probeLive, renderLive } from './live.mjs'
import { makeMesh } from '../core/geometry.mjs'

export class AdapterError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'AdapterError'
    this.code = code || 'ADAPTER_ERROR'
  }
}

/**
 * @param {object} opts
 * @param {string} [opts.source]  'auto' | 'live' | 'web' | 'file'
 * @param {string} [opts.blend]   启动 Blender 时打开哪个 .blend（**不是**读取源，见 resolve）
 * @param {string} [opts.obj]     .obj 路径
 * @param {string} [opts.url]     ws:// 网页桥
 * @param {number} [opts.cdpPort] Chrome 调试端口
 * @param {string} [opts.targetMatch] CDP 目标页 URL 片段
 */
export class SceneSource {
  constructor(opts = {}, deps = {}) {
    this.opts = opts
    this.log = deps.log || (() => {})
    this.packageDir = deps.packageDir || process.cwd()
    this.probeLive = deps.probeLive || probeLive
    this.cache = new Map()
    this.lastExtract = null
    this.resolvedKind = null
  }

  describe() {
    const o = this.opts
    if (this.resolvedKind === 'live') return 'live:blender-mcp'
    if (this.resolvedKind === 'web-ws') return 'web-ws:' + o.url
    if (this.resolvedKind === 'web-cdp') return 'web-cdp:' + o.cdpPort
    if (this.resolvedKind === 'file-obj') return 'file-obj:' + o.obj
    if ((o.source || 'auto') === 'auto') return 'auto (live > web > file)'
    if (o.source === 'live') return 'live:blender-mcp'
    if (o.url) return 'web-ws:' + o.url
    if (o.cdpPort) return 'web-cdp:' + o.cdpPort
    if (o.obj) return 'file-obj:' + o.obj
    return 'auto'
  }

  async resolve() {
    const o = this.opts
    const mode = o.source || 'auto'

    /* live：通过 MCP 读**正在运行的 Blender**。
     *
     * 这是解决「建模改活场景、检查读磁盘」割裂的关键路径。
     * 优先于其它所有源：只要 MCP 通着，就用它。
     */
    if (mode === 'live') {
      const probe = await this.probeLive({ mcpUrl: o.mcpUrl })
      if (!probe.ok) {
        throw new AdapterError(
          'live 模式要求 Blender MCP 正在运行，但连不上：' + probe.detail
          + ' 先调 blender_ready 确认环境，或改用 source: \'file\' 读 .obj。',
          'LIVE_UNAVAILABLE',
        )
      }
      return 'live'
    }

    if (mode === 'web') {
      if (o.url) return 'web-ws'
      if (o.cdpPort) return 'web-cdp'
      throw new AdapterError('指定了 web 引擎但没给 url（ws://）或 cdpPort', 'WEB_NO_ENDPOINT')
    }
    if (mode === 'file') {
      if (!o.obj) throw new AdapterError('指定了 file 引擎但没给 obj 路径', 'FILE_NO_PATH')
      return 'file-obj'
    }
    if (mode === 'blender') {
      /* 磁盘 .blend 读取模式已下线。
       *
       * 原因：它依赖 runtime/blender_bridge.py 通过 `blender -b --python <脚本>` 通信，
       * 而那个桥接脚本从未随包发布过（全部分发包与历史备份里都没有）。
       * 留着它只会让用户 spawn 一个参数指向不存在文件的 Blender 进程，一直卡到超时。
       *
       * 需要检查磁盘文件时改用：source: 'file' + obj 路径（只读），
       * 或让 Blender 开着并走 live（功能完整）。 */
      throw new AdapterError(
        '磁盘 .blend 读取模式已下线（缺少桥接脚本，历史上也未随包发布）。'
        + '改用 live 连接正在运行的 Blender，或用 source: \'file\' 读 .obj。',
        'BLEND_MODE_REMOVED',
      )
    }
    if (mode !== 'auto') throw new AdapterError('未知建模源：' + mode, 'UNKNOWN_SOURCE')

    /* auto 优先级：活场景 > 网页 > 文件。
     *
     * 活场景排第一是有意的：模型正在改的就是活场景，
     * 检查它才有意义。磁盘文件可能是几分钟前的旧状态。
     * 注意 o.blend 只用于「启动 Blender 时打开哪个文件」，不再作为读取源。 */
    if (o.preferLive !== false) {
      const probe = await this.probeLive({ mcpUrl: o.mcpUrl })
      if (probe.ok) return 'live'
    }
    if (o.obj) return 'file-obj'
    if (o.url) return 'web-ws'
    if (o.cdpPort) return 'web-cdp'
    throw new AdapterError(
      '没有可用的建模源：Blender MCP 连不上，也没有可读取的 .obj 或网页端点。'
      + '先调 blender_ready 连接正在建模的场景，或在 model_source.use 显式指定文件/网页端点。',
      'NO_SOURCE',
    )
  }

  async session() {
    const kind = await this.resolve()
    this.resolvedKind = kind
    const key = kind + '|' + (this.opts.blend || this.opts.obj || this.opts.url || this.opts.cdpPort || '')
    if (this.cache.has(key)) return this.cache.get(key)
    let s
    if (kind === 'live') {
      /* live 没有长驻会话：每次 extract 都通过 MCP 现取，
       * 因为活场景随时在变，缓存反而会给出过期数据。 */
      s = { kind: 'live' }
    } else if (kind === 'web-ws') {
      s = new WebSocketSession({ url: this.opts.url, log: this.log })
    } else if (kind === 'web-cdp') {
      s = new CdpSession({
        port: this.opts.cdpPort,
        targetMatch: this.opts.targetMatch,
        packageDir: this.packageDir,
        log: this.log,
      })
    } else {
      s = { kind: 'file-obj' }
    }
    s.kind = kind
    this.cache.set(key, s)
    return s
  }

  async extract(extractOpts = {}) {
    const s = await this.session()
    if (s.kind === 'live') {
      const raw = await extractLive({
        scope: extractOpts.scope,
        maxObjects: extractOpts.maxObjects,
        maxTriangles: extractOpts.maxTriangles,
        mcpUrl: this.opts.mcpUrl,
      })
      this.lastExtract = raw
      return raw
    }
    if (s.kind === 'file-obj') {
      const p = path.resolve(this.opts.obj)
      if (!existsSync(p)) throw new AdapterError('找不到 obj 文件：' + p, 'FILE_NOT_FOUND')
      const meshes = await loadObjFile(p)
      this.lastExtract = { meshes, skipped: [], source: 'file-obj', info: sceneInfoFromMeshes(meshes) }
      return this.lastExtract
    }
    if (s.kind === 'blender') {
      /* 不可达：resolve() 已拒绝该模式。留着是为了万一有旧调用直连 session()。 */
      throw new AdapterError('磁盘 .blend 读取模式已下线。', 'BLEND_MODE_REMOVED')
    }
    const raw = await s.extract(extractOpts)
    this.lastExtract = { ...raw, source: s.kind }
    return this.lastExtract
  }

  async namingScan(scanOpts = {}) {
    const s = await this.session()
    const { meshes } = await this.extract({})
    const genericRe = /^(cube|sphere|cylinder|plane|torus|cone|mesh|object|box|circle|grid|geometry|buffergeometry|group)([._ ]?\d+)?$/i
    const items = meshes.map((m) => ({
      id: m.id,
      part: m.part,
      named: !genericRe.test(m.id),
      generic: genericRe.test(m.id),
      verts: m.vertices,
      faces: m.triangles,
      dims: m.dims,
      materials: (m.meta && m.meta.materials) || [],
      suggested: genericRe.test(m.id) ? ('part_' + m.id.replace(/\W+/g, '_')) : m.id,
      hidden: !!(m.meta && m.meta.hidden),
    }))
    const seen = {}
    for (const it of items) seen[it.part] = (seen[it.part] || 0) + 1
    const generic = items.filter((i) => i.generic).length
    return {
      totalMeshes: items.length,
      named: items.length - generic,
      generic,
      duplicates: Object.entries(seen).filter(([, v]) => v > 1).map(([part, count]) => ({ part, count })),
      items,
      truncated: false,
    }
  }

  async namingApply(assignments, applyOpts = {}) {
    const s = await this.session()
    if (s.kind === 'web-cdp' || s.kind === 'web-ws') {
      return s.call('rename', assignments)
    }
    throw new AdapterError(
      '文件源（.obj）是只读的：改名请用 naming 工具生成「对象→部件名」的对照表，再在你的建模工具里写回；'
      + '或走 live 连接正在运行的 Blender。',
      'FILE_READONLY',
    )
  }

  /**
   * 渲染多视角图。
   *
   * live 源的实现：走 MCP 的 look 工具（视口快照，快），
   * 拿到 base64 后**落盘**成 PNG，返回路径——
   * 因为上层 attachShots 是按路径读文件的。
   *
   * 注意 live 渲染用的是视口快照而非正交渲染，所以
   * 量出来的尺寸不如 blender -b 的严格正交准确；
   * 但对「看形状对不对」这个用途足够了。
   */
  async renderShots(shots, renderOpts = {}) {
    const s = await this.session()

    if (s.kind === 'live') {
      const resolution = Math.min(1024, Math.max(200, renderOpts.resolution || 900))
      const out = []
      let i = 0
      for (const shot of shots) {
        i++
        try {
          /* look 的 view 名字和我们的 shot.view 基本对应：
           * front / back / left / right / top / bottom / iso / camera */
          const viewName = shot.view === 'front_silhouette' ? 'front' : shot.view
          const r = await renderLive({
            view: viewName,
            shading: shot.silhouette ? 'solid' : (renderOpts.engine === 'workbench' ? 'solid' : 'material'),
            width: shot.ortho ? resolution : resolution,
            height: Math.round(resolution * 0.75),
            /* 取景优先级：单件隔离 > 调用方给的主体清单 > 不指定（整场景）。
             * 第三档是实测踩坑的入口：远处环境球会把主体压成亚像素、出图全灰。
             * 场景级调用应传 focus: pickFramingFocus(meshes).names。 */
            focus: renderOpts.isolate ? [renderOpts.isolate]
              : (Array.isArray(renderOpts.focus) && renderOpts.focus.length ? renderOpts.focus : undefined),
            hideOthers: !!renderOpts.isolate,
            mcpUrl: this.opts.mcpUrl,
          })
          /* 落盘：上层按路径读 */
          const dir = path.join(os.tmpdir(), 'ptc-live-shots')
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
          const fp = path.join(dir, 'shot_' + Date.now() + '_' + i + '_' + (shot.view || 'v') + '.png')
          writeFileSync(fp, Buffer.from(r.base64, 'base64'))
          out.push({
            view: shot.view,
            path: fp,
            ortho: shot.ortho,
            silhouette: shot.silhouette,
            /* live 模式下剪影就是把 solid 渲染再反相，交给上层处理 */
            needsInvert: !!shot.silhouette,
          })
        } catch (e) {
          out.push({
            view: shot.view,
            path: null,
            why: String((e && e.message) || e).slice(0, 200),
          })
        }
      }
      return { shots: out, source: 'live' }
    }

    if (s.kind === 'web-cdp') {
      const png = await s.screenshot()
      return { shots: [{ view: 'viewport', bytes: png.length, png }], source: 'cdp-screenshot' }
    }
    throw new AdapterError('当前建模源不支持自动渲染：请走 live 连接 Blender；网页源请用 CDP 截图（--remote-debugging-port）。', 'NO_RENDER')
  }

  async info() {
    const s = await this.session()
    if (s.kind === 'web-cdp' || s.kind === 'web-ws') return s.info()
    const { meshes } = await this.extract({})
    return { ...sceneInfoFromMeshes(meshes), source: 'file-obj', path: this.opts.obj }
  }

  async dispose() {
    for (const [, s] of this.cache) {
      try { await s.dispose() } catch { /* ignore */ }
    }
    this.cache.clear()
  }
}

export { makeMesh }
