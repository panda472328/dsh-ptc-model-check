/**
 * MCP 几何源适配器：让检查工具直接读**活场景**。
 *
 * 解决的问题：检查工具原本走 "blender -b 读磁盘 .blend"，而建模走 MCP 改活场景。
 * 两边不一致 → 模型改完场景，检查还报旧结果 → 模型以为做完了。
 *
 * 这个适配器通过 MCP 的 export_geometry 工具拿活场景的三角网格，
 * 转成与磁盘源完全相同的 mesh 结构，上层检查逻辑不用改。
 */

import { makeMesh } from '../core/geometry.mjs'

const MCP_URL = () => process.env.PTC_MCP_URL || 'http://127.0.0.1:8765/mcp'

let seq = 0

async function mcpCall(name, args = {}, timeoutMs = 120000, mcpUrl) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(mcpUrl || MCP_URL(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: ++seq, method: 'tools/call',
        params: { name, arguments: args },
      }),
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error('MCP HTTP ' + res.status)
    const j = await res.json()
    if (j.error) throw new Error('MCP 错误：' + (j.error.message || JSON.stringify(j.error)))
    const result = j.result || {}
    const content = result.content || []
    const text = content.map((c) => c.text || '').filter(Boolean).join('\n')
    if (result.isError) throw new Error(text || 'MCP 工具返回错误')
    return text
  } finally {
    clearTimeout(timer)
  }
}

/** 探测 MCP 是否可用（Blender 是否连着）。 */
export async function probeLive(opts = {}) {
  try {
    const text = await mcpCall('ping', {}, 4000, opts.mcpUrl)
    return { ok: /pong/.test(text), detail: text.slice(0, 200) }
  } catch (e) {
    return { ok: false, detail: String((e && e.message) || e) }
  }
}

function decodeFloat32(b64) {
  const buf = Buffer.from(b64, 'base64')
  // 复制一份，避免 Buffer 池化导致 byteOffset 不对
  const copy = Buffer.from(buf)
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4)
}

function decodeUint32(b64) {
  const buf = Buffer.from(b64, 'base64')
  const copy = Buffer.from(buf)
  return new Uint32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4)
}

/**
 * 从活场景取网格。
 *
 * @param {object} opts
 * @param {string[]} [opts.scope] 只取这些对象/部件
 * @returns {Promise<{meshes:Array, skipped:Array, triangles:number, source:'live'}>}
 */
export async function extractLive(opts = {}) {
  const args = {}
  if (Array.isArray(opts.scope) && opts.scope.length) args.scope = opts.scope
  if (opts.maxObjects) args.maxObjects = opts.maxObjects
  if (opts.maxTriangles) args.maxTriangles = opts.maxTriangles

  const t0 = Date.now()
  const text = await mcpCall('export_geometry', args, 180000, opts.mcpUrl)
  let raw
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new Error('export_geometry 返回的不是 JSON：' + text.slice(0, 200))
  }

  const meshes = (raw.meshes || []).map((m) => makeMesh(
    String(m.id),
    String(m.part || m.id),
    decodeFloat32(m.positions),
    decodeUint32(m.indices),
    {
      materials: m.materials || [],
      /* **必须带上 Collection 归属**：分组分析优先用它。
       * 之前这里漏了这个字段，导致「Blender 里建了组但插件认不出来」——
       * 分组退回命名前缀推断，规则命名不规范就分错。 */
      collections: m.collections || [],
      parent: m.parent || null,
      hidden: !!m.hidden,
      source: 'live',
    },
  ))

  return {
    meshes,
    skipped: raw.skipped || [],
    triangles: raw.triangles || 0,
    file: raw.file || null,
    source: 'live',
    ms: Date.now() - t0,
  }
}

/**
 * 用活场景渲染图。走 MCP 的 look 工具（它内部用 Blender 主线程渲染）。
 *
 * 注意：返回的是 base64 图片，不是文件路径。调用方需要自己决定
 * 是存盘再走 attachment，还是直接转成 data URL。
 */
export async function renderLive(opts = {}) {
  const args = {
    view: opts.view || 'iso',
    shading: opts.shading || 'solid',
    width: opts.width || 800,
    height: opts.height || 600,
  }
  if (opts.focus) args.focus = opts.focus
  if (opts.hideOthers) args.hide_others = true

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 180000)
  try {
    const res = await fetch(opts.mcpUrl || MCP_URL(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: ++seq, method: 'tools/call',
        params: { name: 'look', arguments: args },
      }),
      signal: ctrl.signal,
    })
    const j = await res.json()
    if (j.error) throw new Error('MCP 错误：' + (j.error.message || ''))
    const content = (j.result && j.result.content) || []
    const img = content.find((c) => c.type === 'image')
    const text = content.filter((c) => c.type === 'text').map((c) => c.text).join(' ')
    if (j.result && j.result.isError) throw new Error(text || '渲染失败')
    if (!img) throw new Error('look 没有返回图片：' + text.slice(0, 200))
    /* 空图警告：Blender 侧会检测「渲染结果几乎全是背景色」。
     * 这种图看着像出图成功，实际上一片空白——不报出来的话，
     * 模型会基于空图判断结构，得出完全错误的结论。 */
    let warning = null
    try {
      const sc = j.result && j.result.structuredContent
      if (sc && sc.warning) warning = String(sc.warning)
      else if (/⚠/.test(text)) warning = text.slice(text.indexOf('⚠') + 1).trim()
    } catch { /* 拿不到就算了 */ }
    return { base64: img.data, mimeType: img.mimeType || 'image/png', summary: text, warning }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 分组五视图的标准视角。
 *
 * **五个正交方向**：正、后、左、右、顶。
 *
 * 为什么用左右两个侧视，而不是「一个侧视 + 等轴」：
 * 等轴图带透视，量不出真实比例；两侧视图能看出**不对称**——
 * 一个物品左边有扶手右边没有，只看左视图发现不了。
 * 后视图则是查「只做正面、背面随便糊」的偷懒。
 */
const FIVE_VIEWS = ['front', 'back', 'left', 'right', 'top']

/**
 * 为一个**分组**渲染五视图（隔离模式：组外对象隐藏，相机自动框住整组）。
 *
 * 为什么是「分组」而不是单个 mesh：一个完整物品由主体 + 配件组成
 * （桌子 = 桌面 + 4 条腿 + 靠背；武器 = 刀身 + 护手 + 握把）。
 * 只看单块板子的五视图没有意义——要判断的是「这个物品各个方向做完了没」。
 *
 * @param {string|string[]} names 组内所有对象名
 * @param {object} opts
 * @returns {Promise<{object:string, objects:string[], views:Array}>}
 */
export async function renderFiveViewsIsolated(names, opts = {}) {
  const focus = Array.isArray(names) ? names.filter(Boolean) : [names].filter(Boolean)
  const label = opts.label || focus.join(' + ')
  const width = opts.width ?? 480
  const height = opts.height ?? 480
  const shading = opts.shading ?? 'solid'
  const views = opts.views ?? FIVE_VIEWS

  /* 串行渲染：并行会让 Blender 主线程排队，反而更慢，
   * 而且可能互相干扰相机设置。 */
  const out = []
  for (const v of views) {
    try {
      const r = await renderLive({
        view: v,
        shading,
        width,
        height,
        focus,
        /* 地面层/环境组用 hideOthers:false：它们本身就是铺开的地面，
         * 隔离渲只对着板边，四个水平视角天然是空图（建模测试 35）。 */
        hideOthers: opts.hideOthers !== false,
        mcpUrl: opts.mcpUrl,
      })
      /* warning 由 Blender 侧的空图检测给出：渲染结果几乎全是背景色时，
       * 会带一条说明回来。必须一路传到输出文案里——空图看不出结构，
       * 模型拿它判断必然出错。 */
      out.push({
        view: v, ok: true, base64: r.base64, mimeType: r.mimeType,
        warning: r.warning || null,
      })
    } catch (e) {
      out.push({ view: v, ok: false, error: String((e && e.message) || e) })
    }
  }
  return { object: label, objects: focus, views: out }
}

/**
 * 批量：为多个分组各渲染五视图。
 *
 * @param {Array<string[]|{name:string, objects:string[]}>} groups
 * @param {object} opts
 */
export async function renderFiveViewsForMany(groups, opts = {}) {
  const maxGroups = opts.maxGroups ?? opts.maxObjects ?? 6
  const results = []
  for (const g of groups.slice(0, maxGroups)) {
    const names = Array.isArray(g) ? g : (g.objects || [])
    const label = Array.isArray(g) ? names.join(' + ') : (g.name || names.join(' + '))
    try {
      results.push(await renderFiveViewsIsolated(names, { ...opts, label }))
    } catch (e) {
      results.push({
        object: label,
        objects: names,
        views: [],
        error: String((e && e.message) || e),
      })
    }
  }
  return results
}
