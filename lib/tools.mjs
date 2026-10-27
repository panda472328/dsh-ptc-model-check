/**
 * 工具层：模型可见的建模工具 + 结果渲染。
 *
 * 设计约束（PTC 模式）：
 *  - 模型只看到 `run_code` + SDK，所以每个工具都必须在 SDK 里是一等公民；
 *  - 返回值的 `render` 决定模型看到什么，文本行严格按用户要求的措辞；
 *  - 只读工具声明 isConcurrencySafe，允许模型并发调用（多智能体同时检查）。
 */

import fs from 'node:fs'
import path from 'node:path'

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { ensureBlenderStack, findMcpServerScript, probeMcp, probePort, detectBlender, mcpPortFromUrl } from './blender-boot.mjs'
import {
  interferencePairs, isolatedMeshes, interferenceLine, isolationLine,
  requiredViews, classifyDims, num, pct,
  silhouetteIoU, judgeSilhouette, SILHOUETTE_PASS_IOU, VIEW_DIRECTIONS,
  VIEW_LABELS, compareFrontBack, TRIANGLE_PAIR_LIMIT, TRIANGLE_WORK_LIMIT, SCENE_TRIANGLE_WORK_LIMIT,
  /* 删除守卫：判断被删的该不该加回、加回到哪 */
  judgeDeleted, restorePlan, snapshotMesh,
} from './core/geometry.mjs'
import { decodePngGray, preparePair, invertGray, cropToContent, resizeGray } from './core/png.mjs'
import { LoopTracker, CONSECUTIVE_LANDED_REQUIRED, normalizeIsolationAcknowledgements } from './core/iteration.mjs'
import { STRUCT_TERMS, looksStructural, queryTerms } from './core/structure.mjs'
import { realityCheck, realityCheckLines } from './core/reality.mjs'
import { analyzeReference } from './core/color.mjs'
import { inspectEachMesh } from './core/precision.mjs'
import {
  groupMeshesIntoItems, pickGroupsForViews, analyzeGroupInterference,
} from './core/grouping.mjs'
import { buildMaterialSearch } from './core/pbr-sources.mjs'
import { renderFiveViewsForMany, renderLive } from './adapters/live.mjs'
import { buildDetailGuidance, buildSceneDetailGuidance } from './core/detail.mjs'
import { pickFramingFocus } from './core/framing.mjs'
import { geometryRevision, inspectionIssues, InspectionEvidence } from './core/inspection-evidence.mjs'
import { inspectHierarchy, hierarchyLines } from './core/hierarchy.mjs'
import { researchMode, researchGuidance, researchText, researchQuery } from './core/research-guidance.mjs'
/* style-presets 模块已不再引用：画风数值表被去掉了。
 * 为什么去掉：预制的数值表等于替 AI 想好了所有材质参数，
 * 它只会照抄不会按物体自己判断。现在改由它自己调研 + 检索 + 自绘。 */
import {
  REVIEW_QUESTIONS, MATERIAL_REVIEW_QUESTIONS,
  buildReviewerPrompt, parseReviewResults, formatReviewDirective,
} from './core/review.mjs'

const ANY = { type: 'object', additionalProperties: true }

/** 简单互斥：同一个建模源上的多次并发调用排队执行，避免 Blender 的 stdin 交错。 */
export function makeLock() {
  let tail = Promise.resolve()
  return function withLock(fn) {
    const run = tail.then(fn, fn)
    tail = run.catch(() => {})
    return run
  }
}

/**
 * 把返回值净化成**无损 JSON**。
 *
 * 为什么必须做这一层：
 *   宿主的工具返回值校验是严格的——遇到 undefined、非有限数字、负零，
 *   会判定**整个返回值非法**（value is not lossless JSON），直接抛错。
 *   不是跳过那一个键，是整个调用失败。
 *
 * 踩过的坑：`attachBase64Images` 里写了 `base64: undefined` 来剥离图片数据，
 *   结果 model_loop 在真机上**每一次调用都报错**、一次都没成功——
 *   模型拿不到检查数据，只能自己写脚本截图，整条检查流程失效。
 *   而测试夹具不出图，这条路径根本没被执行，所以测试全绿。
 *
 * 这一层是最后防线：无论哪个分支漏了 undefined，出口都会被净化。
 * 净化规则和宿主的校验保持一致：
 *   - undefined / 函数 → 删掉这个键
 *   - 非有限数字（NaN / Infinity）→ 归 0
 *   - 负零 → 归 0（Object.is(-0, 0) 为 false，宿主会拒绝）
 *   - 数组里的 undefined → 删掉该项
 */
export function sanitizeJson(value, depth = 0) {
  /* 深度保护：返回值理论上不会太深，但循环引用会无限递归 */
  if (depth > 24) return null
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value === 'function') return undefined
  if (typeof value === 'symbol') return undefined
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 0
    if (Object.is(value, -0)) return 0
    return value
  }
  if (typeof value === 'bigint') return Number(value)
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) {
    const out = []
    for (const item of value) {
      const v = sanitizeJson(item, depth + 1)
      if (v !== undefined) out.push(v)
    }
    return out
  }
  /* 保留 Buffer / 日期这类对象的本来面目？不行——它们也过不了无损 JSON 校验。
   * 统一转成普通值：Buffer → 它的 JSON 形态（{type:'Buffer',data:[...]}）。 */
  const out = {}
  for (const k of Object.keys(value)) {
    let v
    try {
      v = sanitizeJson(value[k], depth + 1)
    } catch {
      continue
    }
    if (v !== undefined) out[k] = v
  }
  return out
}

/**
 * 包一层工具 execute：出口净化 + 出错时给出更清楚的报错。
 */
function withSanitizedOutput(spec) {
  const orig = spec.execute
  if (typeof orig !== 'function') return spec
  return {
    ...spec,
    async execute(args, ctx) {
      const v = await orig.call(this, args, ctx)
      return sanitizeJson(v)
    },
  }
}

function textBlocks(value) {
  const out = []
  for (const line of value.lines || []) out.push({ type: 'text', text: line })
  return out
}

function renderReport(_args, value) {
  const blocks = textBlocks(value)
  const payload = { ...value }
  delete payload.lines
  blocks.push({ type: 'text', text: JSON.stringify(payload) })
  return blocks
}

/**
 * 把截图落成 durable attachment。宿主没有 attachments 服务时降级为路径清单。
 * 同时算每张图的哈希：两张完全相同的图 = 这个"角度"其实没换视角，必须报出来，
 * 否则模型会以为看过了三个面。
 */
async function attachShots(ctx, shots, opts = {}) {
  const out = []
  const attachments = ctx.get ? ctx.get('attachments') : undefined
  for (const s of shots) {
    if (!s || !s.path) { out.push({ ...s, attached: false, why: '没有文件路径' }); continue }
    if (!existsSync(s.path)) { out.push({ view: s.view, attached: false, why: '渲染文件不存在' }); continue }
    let data
    try {
      data = await readFile(s.path)
    } catch (e) {
      out.push({ view: s.view, path: s.path, attached: false, why: '读取渲染文件失败：' + String((e && e.message) || e) })
      continue
    }
    const hash = createHash('sha256').update(data).digest('hex').slice(0, 16)
    if (!attachments) {
      out.push({ view: s.view, path: s.path, attached: false, hash, why: '宿主没有 attachments 服务，只能给路径' })
      continue
    }
    try {
      const ref = await attachments.saveImage({ data, mediaType: 'image/png', name: (opts.prefix || 'view') + '-' + s.view + '.png' })
      out.push({
        view: s.view, path: s.path, attached: true, hash,
        image: { attachmentId: ref.attachmentId, mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height, name: ref.name },
      })
    } catch (e) {
      out.push({ view: s.view, path: s.path, attached: false, hash, why: String((e && e.message) || e) })
    }
  }
  return out
}

/**
 * 挑出最需要单独看五视图的 mesh。
 *
 * 为什么不全渲：每个 mesh 五张 420×420 的图，一个 90 个 mesh 的场景
 * 就是 450 张图——上下文直接爆掉。所以按优先级挑：
 *
 *   1. 有问题的（自身不完整）——最该看
 *   2. 面积大的——做错了影响最大
 *   3. 精度离群的——可能某面偷工导致面数异常
 *
 * 其余的组合按面积补足到上限。
 */
function pickMeshesForIsolatedViews(each, meshes, maxCount) {
  const byId = new Map(meshes.map((m) => [m.id, m]))
  const picked = []
  const seen = new Set()

  const add = (id, reason) => {
    if (seen.has(id) || picked.length >= maxCount) return
    const m = byId.get(id)
    if (!m) return
    seen.add(id)
    picked.push({ id, part: m.part, reason })
  }

  /* ① 有问题的优先 */
  for (const pb of each.problems) {
    add(pb.mesh.id, '自身不完整')
  }
  /* ② 精度离群 */
  for (const o of each.outliers) {
    add(o.id, '精度偏离同组')
  }
  /* ③ 面积最大的补足 */
  const byArea = [...meshes]
    .filter((m) => m.triangles > 0)
    .sort((a, b) => (b.dims[0] * b.dims[1] + b.dims[1] * b.dims[2] + b.dims[2] * b.dims[0])
      - (a.dims[0] * a.dims[1] + a.dims[1] * a.dims[2] + a.dims[2] * a.dims[0]))
  for (const m of byArea) {
    add(m.id, '面积较大')
  }

  return picked
}

/**
 * 把 base64 图片落成 durable attachment。
 *
 * 与 attachShots 的区别：那个从文件读，这个直接从 base64 转，
 * 因为 live 渲染不落盘（渲染在 Blender 内存里，直接回 base64）。
 */
async function attachBase64Images(ctx, items, opts = {}) {
  const out = []
  const attachments = ctx && ctx.get ? ctx.get('attachments') : undefined
  for (const it of items) {
    if (!it || !it.base64) {
      out.push({ ...it, attached: false, why: '没有图片数据' })
      continue
    }
    if (!attachments) {
      out.push({ ...it, attached: false, why: '宿主没有 attachments 服务' })
      continue
    }
    try {
      const data = Buffer.from(it.base64, 'base64')
      const ref = await attachments.saveImage({
        data,
        mediaType: it.mimeType || 'image/png',
        name: (opts.prefix || 'mesh') + '_' + (it.view || 'view') + '.png',
      })
      /* **不要把 base64 写成 undefined。**
       * 宿主的返回值校验按「无损 JSON」处理：undefined 会让**整个**工具返回值
       * 被判为非法（报 value is not lossless JSON），而不是跳过这一个键。
       * 后果极严重：真机上 model_loop 每次都报错、一次都成功不了，
       * 模型拿不到任何检查数据，只能自己写脚本截图——整条检查流程失效。
       * 用解构把键整个剔掉。 */
      const { base64: _drop, ...rest } = it
      out.push({ ...rest, attached: true, image: ref })
    } catch (e) {
      /* 失败分支也要剔除 base64——它同样是 undefined 的来源 */
      const { base64: _drop2, ...rest2 } = it
      out.push({ ...rest2, attached: false, why: String((e && e.message) || e) })
    }
  }
  return out
}

/** 算整批 mesh 的包围盒对角线，作为「场景尺度」参照。 */
function sceneDiagonal(meshes) {
  if (!meshes || meshes.length === 0) return 0
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const m of meshes) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], m.bbox[i])
      max[i] = Math.max(max[i], m.bbox[i + 3])
    }
  }
  return Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2])
}

/** 找出像素级完全相同的视角组。 */
function duplicateViewGroups(shots) {
  const byHash = new Map()
  for (const s of shots) {
    if (!s || !s.hash) continue
    if (!byHash.has(s.hash)) byHash.set(s.hash, [])
    byHash.get(s.hash).push(s.view)
  }
  return [...byHash.values()].filter((g) => g.length > 1)
}

/**
 * 比较正面与背面的实体占比，用来发现「只做正面、背面糊弄」。
 *
 * 返回 null 表示拿不到两张图（没渲染、或读文件失败）。这时不报错也不提示——
 * 这只是启发式检查，不该阻断主流程。
 */
async function compareFrontBackViews(attached) {
  try {
    const front = attached.find((a) => a.view === 'front' && a.path)
    const back = attached.find((a) => a.view === 'back' && a.path)
    if (!front || !back) return null
    const fa = decodePngGray(await readFile(front.path))
    const ba = decodePngGray(await readFile(back.path))
    const faC = cropToContent(fa.gray, fa.width, fa.height)
    const baC = cropToContent(ba.gray, ba.width, ba.height)
    const size = 128
    const fg = resizeGray(faC.gray, faC.w, faC.h, size, size)
    const bg = resizeGray(baC.gray, baC.w, baC.h, size, size)
    return compareFrontBack(fg, bg, size, size)
  } catch {
    return null
  }
}

function renderShots(_args, value) {
  const blocks = []
  for (const line of value.lines || []) blocks.push({ type: 'text', text: line })
  const payload = { ...value }
  delete payload.lines
  delete payload.shots
  delete payload.perMeshImages
  /* images 是 model_review 的字段名（perMeshImages 是 model_loop 的）。
   * 两者都是「带 attachment 的图片列表」，要从 JSON 摘要里剔掉，
   * 只把 attachment 引用附成图片块。 */
  delete payload.images
  if (value.kind === 'review') {
    // 任务正文已在 lines 中输出一次；JSON 摘要只保留任务身份和覆盖范围。
    delete payload.reviewerPrompt
    for (const key of ['reviewTasks', 'perGroupPrompts']) {
      if (Array.isArray(payload[key])) payload[key] = payload[key].map(({ prompt: _prompt, ...task }) => task)
    }
  }
  blocks.push({ type: 'text', text: JSON.stringify(payload) })
  for (const s of value.shots || []) if (s && s.image) blocks.push({ type: 'image', attachment: s.image })
  /* 逐 mesh / 逐组的图片放在最后——先让模型读完文字判断，再看图。
   * model_loop 用 perMeshImages，model_review 用 images，两者都处理。 */
  const imgList = (value.perMeshImages || []).concat(value.images || [])
  for (const s of imgList) {
    if (!s || !s.image) continue
    blocks.push({ type: 'text', text: '「' + s.object + '」' + (s.view || '') + '：' })
    blocks.push({ type: 'image', attachment: s.image })
  }
  return blocks
}

function normalizeReviewText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function collectReviewEvidence(reviewState, submittedText) {
  const task = reviewState && reviewState.latestTask
  if (!task || !Array.isArray(task.tasks) || !task.tasks.length) {
    return { complete: false, missing: ['当前复核任务'], outputs: [] }
  }

  const submitted = normalizeReviewText(submittedText)
  const missing = []
  const outputs = []
  const results = []
  for (const item of task.tasks) {
    const token = item && item.token
    const resultTexts = token && task.outputs && task.outputs[token]
    const texts = Array.isArray(resultTexts)
      ? resultTexts.map((text) => String(text || '').trim()).filter(Boolean)
      : []
    if (!texts.length) {
      missing.push((item.groups || []).join('、') || token || '未知任务')
      continue
    }
    for (const text of texts) {
      if (!submitted.includes(normalizeReviewText(text))) {
        missing.push((item.groups || []).join('、') || token || '未知任务')
        break
      }
      outputs.push(text)
      results.push({ token, groups: item.groups || [], text })
    }
  }
  return { complete: missing.length === 0, missing: [...new Set(missing)], outputs, results }
}

/**
 * @param {object} deps
 * @param {(overrides?:object)=>import('./adapters/index.mjs').SceneSource} deps.sourceFor
 * @param {()=>object} deps.config 当前生效配置
 * @param {(name:string,value:any)=>void} [deps.remember] 记下最近一次检查结果（给注入上下文用）
 */
/* ── 看图即检测 ──
 *
 * 用户要求：只要看图（look / render_preview），就要同时拿到「穿模」和「孤立」两项结果。
 * 这两项正是 model_isolation 的核心；index.js 的 tools/post-execute 会在
 * 图片结果后面追加这里的文本，所以「看一眼」这个动作本身就把几何问题带回来了。
 *
 * 和 model_isolation 的差别只在篇幅：这里给摘要（前几条命中 + 层次前几行），
 * 因为看图的频率远高于检查；完整的两层报告仍由 model_isolation / model_loop 提供。
 * 检测本身走同一套函数与阈值，不另立标准。
 */
export async function buildViewCheckReport(src, cfg, opts = {}) {
  const t0 = Date.now()
  const maxItems = Math.max(1, Math.min(20, Number(opts.maxItems) || 6))
  const { meshes, skipped = [] } = await src.extract({
    maxObjects: cfg.maxObjects, maxTriangles: cfg.maxTriangles,
  })
  if (!meshes || !meshes.length) {
    return { ok: false, text: '【看图附带检测】场景里没有 mesh，未做穿模/孤立检测。', hits: 0, isolated: 0, ms: Date.now() - t0 }
  }
  const groups = groupMeshesIntoItems(meshes)
  const pairScans = new Map()
  const inter = interferencePairs(meshes, {
    minDepth: cfg.minDepth, minRatio: cfg.minRatio, pairScans, maxPairs: 60,
  })
  const iso = isolatedMeshes(meshes, {
    contactGap: 1e-5, maxItems, pairScans,
    maxTriangleWork: SCENE_TRIANGLE_WORK_LIMIT,
    maxTriangleWorkPerPair: TRIANGLE_WORK_LIMIT,
  })
  const gi = analyzeGroupInterference(groups, inter.hits)
  const hierarchy = inspectHierarchy(meshes, groups, inter, iso, { extractionSkipped: skipped.length })

  const lines = []
  lines.push('【看图附带检测】' + meshes.length + ' 个 mesh · 穿模 ' + inter.hits.length + ' 对（组内穿出 '
    + (gi.internalPokeCount || 0) + ' · 组间 ' + (gi.crossCount || 0) + '）· 孤立 ' + iso.hits.length + ' 个')
  for (const h of inter.hits.slice(0, maxItems)) lines.push('  · ' + interferenceLine(h))
  for (const h of iso.hits.slice(0, maxItems)) lines.push('  · ' + isolationLine(h))
  if (!inter.hits.length && !iso.hits.length) {
    lines.push('  · 本范围没有超过阈值的穿模对，也没有孤立件；层次/连接见下。')
  }
  for (const l of hierarchyLines(hierarchy).slice(0, 6)) lines.push('  ' + l)
  if (!iso.complete) {
    lines.push('  · 接触检测预算不足：' + (iso.unknownPairCount || 0) + ' 对未知，提高预算后复查。')
  }
  lines.push('  · 摘要与 model_isolation 同源；五视图和逐组完整报告仍以 model_loop 为准。')
  return {
    ok: true, text: lines.join('\n'), meshes: meshes.length,
    hits: inter.hits.length, isolated: iso.hits.length,
    complete: hierarchy.complete !== false, ms: Date.now() - t0,
  }
}

export function buildTools(deps) {
  const {
    sourceFor, config, remember, hostCtx, getRefState, markRefAnalyzed,
    setSourceSelection, setMcpUrl,
    getPhaseState, markModelingComplete, resetPhase,
    getModelingState, noteCheck, noteModelingEdit, noteReviewResult, getReviewState,
    noteReviewPrompt, getMaterialState, noteMaterialEdit,
    getDeletedLog, noteDeleted, noteDeleteVerdict,
    getResearchState,
    /* MCP 原生工具可用性信号（index.js 观察 tools/result 得到） */
    getNativeSignal,
    workMemory,
    /* 插件包目录：index.js 会传，用于定位 scripts/research.mjs */
    packageDir,
  } = deps

  /* 包目录：优先用传入的，其次从本文件位置推（lib/ 的上一层） */
  const PACKAGE_DIR = packageDir || path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..')
  const lock = makeLock()
  /* 迭代状态：跨调用保留，按 target 分桶 */
  const tracker = new LoopTracker()
  const evidenceLedger = new InspectionEvidence()
  let reviewTaskSequence = 0

  /* ── 结构检索脚本的执行器 ──
   *
   * 脚本在 scripts/research.mjs，通过子进程跑。
   * 为什么用子进程而不是 import：脚本是独立的小工具，
   * 模型也可以直接用 pwsh 调它——两条路走同一个实现。
   *
   * 返回 null 表示「脚本不可用」，让调用方回退到 ctx.web。 */
  const runResearchScript = async (query, opts = {}) => {
    try {
      const scriptPath = path.join(PACKAGE_DIR, 'scripts', 'research.mjs')
      if (!fs.existsSync(scriptPath)) return null

      const argv = [query, '--aspect', opts.aspect || 'structure', '--mode', researchMode(opts.mode)]
      if (opts.deep) argv.push('--deep')
      argv.push('--json', '--max', String(opts.maxResults || 5))

      const { execFile } = await import('node:child_process')
      const raw = await new Promise((resolve, reject) => {
        execFile(process.execPath, [scriptPath, ...argv], {
          timeout: 45000,
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true,
        }, (err, stdout, stderr) => {
          if (err && !stdout) return reject(err)
          resolve(String(stdout || ''))
        })
      })

      const data = JSON.parse(raw)
      if (!data || !data.ok) return null
      const mode = researchMode(opts.mode)
      const sources = (data.sources || []).map((s) => ({
        title: researchText(s.title, mode) || null,
        url: s.url,
        snippet: researchText(s.snippet, mode) || null,
        hasStructWord: !!s.hasStructWord,
      }))
      const excerpts = (data.bodies || []).map((b) => ({ url: b.url, excerpt: researchText(b.body, mode) }))

      /* 拼成和 ctx.web 路径一样的结果形态 */
      const lines = []
      lines.push('结构参考（via 本地检索脚本）：' + query)
      lines.push(...researchGuidance(mode))
      lines.push('')

      if (data.effective) {
        lines.push('✓ 拿到 ' + data.relevantCount + ' 条结构相关内容'
          + (data.bodies && data.bodies.length ? ' + ' + data.bodies.length + ' 条正文' : ''))
        lines.push('')
        for (const s of sources) {
          if (!s.hasStructWord && !excerpts.some((b) => b.url === s.url)) continue
          lines.push('· ' + (s.title || '(无标题)'))
          lines.push('  ' + s.url)
          if (s.snippet) lines.push('  ' + String(s.snippet).slice(0, 360))
          const b = excerpts.find((x) => x.url === s.url)
          if (b) {
            lines.push('  **正文节选**：' + b.excerpt.slice(0, 900))
          }
          lines.push('')
        }
      } else {
        lines.push('⚠ **这次没有查到结构相关内容。**')
        if (data.sourceCount > 0) {
          lines.push('  搜索有结果（' + data.sourceCount + ' 条），但全是领域背景，没有讲构件组成。')
          lines.push('  这通常是因为术语被搜索引擎拆错了（例如「飞扶壁」被当成「飞」）。')
          lines.push('')
          lines.push('  改法（按有效性排序）：')
          lines.push('   ① 加英文术语一起查：「flying buttress 飞扶壁 结构」')
          lines.push('   ② 用更通用的说法：「哥特式教堂 扶壁 拱肋 支撑」')
          lines.push('   ③ 拆成构件层级：「拱 肋 券 柱 结构 受力」')
          lines.push('')
          lines.push('  **不要用常识假装查到了**——构件组成没拿到就是没拿到。')
        } else {
          lines.push('  搜索没有返回任何结果，换个说法重试。')
        }
      }
      lines.push('---')
      lines.push('**提醒**：参考实例不是统一模板；遵守用户要求，设计由你结合当前场景决定。')
      lines.push('查完仍然要用 model_loop 验收。')

      return {
        /* ok 是给调用方判断「脚本成功了吗」用的。
         * 之前漏了它，导致 if (scriptResult && scriptResult.ok) 永远为假，
         * 脚本结果被丢掉、回退到 ctx.web。 */
        ok: true,
        kind: 'reference',
        available: true,
        query,
        aspect: opts.aspect || 'structure',
        mode,
        guidance: researchGuidance(mode),
        depth: opts.deep ? 'deep' : 'brief',
        via: 'script',
        effective: !!data.effective,
        relevantCount: data.relevantCount || 0,
        offTopicCount: data.offTopicCount || 0,
        lines,
        sources,
        excerpts,
        ms: data.ms || 0,
      }
    } catch {
      /* 脚本超时/崩溃/找不到 → 返回 null，让调用方回退 */
      return null
    }
  }

  /* 阶段查询（插件没提供时降级为「始终允许」，避免测试环境卡死） */
  const phase = () => (typeof getPhaseState === 'function' ? getPhaseState() : { modelingComplete: true })

  const run = (overrides, fn) => lock(async () => {
    const src = sourceFor(overrides)
    try {
      return await fn(src)
    } finally {
      /* 长驻会话保留，不在这里 dispose */
    }
  })

  return [
    /* ═══════════════ 0. 环境自检 ═══════════════ */
    {
      name: 'blender_ready',
      description:
        '**Blender 环境异常时的诊断工具。** 检查 Blender MCP、进程和 addon 是否就绪；需要时可自动拉起。'
        + '它做三层检查：① MCP 服务器是否在线 ② Blender 进程是否在跑 ③ addon 是否在监听。'
        + '缺哪个补哪个：MCP 服务器没起就启动它；Blender 没起就打开 Blender 并自动启动 addon。'
        + '【何时调用】运行时状态显示未就绪、Blender MCP 工具连接失败，或用户要求诊断环境时。'
        + '会话开始时插件会自动做只读检查；状态正常时直接建模，不必重复调用。'
        + '【何时不调用】状态已就绪且工具连接正常时。'
        + '【做什么】返回每层检查的结果。全部就绪返回 ready=true，可以直接开始建模；'
        + '有需要用户手动操作的部分（比如 Blender 开了但没点 Start MCP Server）会给出明确指引。',
      parameters: {
        auto_launch: { type: 'boolean', description: '是否自动拉起缺失的部分（默认 true）。传 false 只检查不启动。' },
        restart_blender: {
          type: 'boolean',
          description: 'Blender 开着但 addon 没监听时，是否杀掉它重启（默认 false）。'
            + '**会丢失未保存的改动**，只在确认场景已存盘、或本来就是空场景时用。',
        },
        issue_decisions: { type: 'array', description: '逐项确认当前检测候选是有意设计或误报。使用上轮 issues 的 id 和 revision，写明用途理由、局部视角或测量依据。属于模型声明，不能替代原始检测；几何变化后自动失效。',
          items: { type: 'object', additionalProperties: false, properties: {
            id: { type: 'string' }, revision: { type: 'string' }, reason: { type: 'string' }, evidence: { type: 'string' },
          } } },
        handoff_limitations: { type: 'string', description: '确因检查能力、资源或任务预算受限需要交付阶段成果时，具体列出未验证范围、已知问题及影响。仅在整场景 done 时允许暂存交付，不授予合格签收；不能用“全部正常”代替。' },
        blend: { type: 'string', description: '启动 Blender 时打开哪个 .blend（省略 = 空场景）。' },
        mcp_url: { type: 'string', description: '本次检查端点。必须与 DSH 的 mcp-blender.url 和插件 mcpUrl 配置一致；单独改这里不会重配 DSH 原生 mcp__blender__* 连接。默认省略。' },
        blender_port: { type: 'integer', description: 'Blender addon 端口（默认 9876）。' },
      },
      output: { schema: ANY, render: renderReport },
      isConcurrencySafe: () => false,
      async execute(args) {
        const cfg = config()
        const mcpUrl = args.mcp_url || cfg.mcpUrl || 'http://127.0.0.1:8765/mcp'
        const configuredMcpUrl = cfg.mcpUrl || 'http://127.0.0.1:8765/mcp'
        const nativeEndpointAligned = mcpUrl === configuredMcpUrl
        const endpointHint = '插件检查端点与 mcpUrl 配置不一致。还需同步 DSH mcp-blender.url；单次参数不会重配 DSH 原生工具。'
        const mcpPort = mcpPortFromUrl(mcpUrl, numOr(cfg.mcpPort, 8765))
        const blenderPort = numOr(args.blender_port, cfg.blenderPort || 9876)
        if (typeof setMcpUrl === 'function') setMcpUrl(mcpUrl)
        /* 没显式配置 mcpServerScript 时自动发现。
         * 两次建模测试里这个配置都是空的，导致服务器永远起不来（action:'none'），
         * 模型只能自己 Start-Process 救场——那次的「就绪」就不再是插件拉起的了。 */
        const found = findMcpServerScript(cfg.mcpServerScript || '', { packageDir: PACKAGE_DIR })
        const res = await ensureBlenderStack({
          mcpUrl,
          mcpPort,
          blenderPort,
          serverScript: found ? found.script : null,
          blenderExe: cfg.blenderPath || '',
          blend: args.blend || cfg.blend || null,
          autoLaunch: args.auto_launch !== false,
          restartIfStuck: args.restart_blender === true,
        })

        /* 服务器在线时顺手取工具数：这是「MCP 服务器活着」的直接证据，
         * 用来和「DSH 里有没有 mcp__blender__*」对照——两者不等价。 */
        let mcpToolCount = null
        if (res.ok || String(res.action || '').indexOf('mcp-') !== 0) {
          try { const p = await probeMcp(mcpUrl); if (p.ok) mcpToolCount = p.toolCount } catch { /* 探测失败不阻塞 */ }
        }
        /* 第①层信号：本会话里模型调用 mcp__blender__* 是否被 DSH 拒过 */
        const nativeSignal = typeof getNativeSignal === 'function' ? getNativeSignal() : { nativeMissing: false }

        const lines = []
        const ready = res.ok && nativeEndpointAligned && !nativeSignal.nativeMissing
        lines.push('Blender 环境自检：' + (ready ? '就绪 ✓'
          : nativeSignal.nativeMissing ? '未就绪（MCP 服务器在线，但没接进 DSH）'
            : res.ok ? '插件端点可用，建模通道未就绪' : '未就绪'))
        for (const s of res.steps) lines.push('  · ' + s)
        if (found && found.source === 'auto') {
          lines.push('  · 服务器脚本自动发现：' + found.script)
        }
        if (mcpToolCount) {
          lines.push('  · 该端点暴露 ' + mcpToolCount + ' 个工具（服务器侧证据）')
        }
        if (!res.ok && res.hint) {
          lines.push('需要处理：' + res.hint)
        }
        if (nativeSignal.nativeMissing) {
          /* 这是最难自己发现的一类故障：所有探测都是绿的，但建模通道不存在。
           * 不写清楚，模型会认为「环境没问题，是我该换个办法」，然后绕过插件。 */
          lines.push('⛔ 本会话里调用 mcp__blender__* 被 DSH 拒绝过（' + (nativeSignal.deniedCount || 1)
            + ' 次）：**MCP 服务器在线 ≠ 工具存在**。'
            + '说明 blender-mcp bundle 没安装，DSH 侧没有 mcp-blender 这条连接。')
          lines.push('→ 处置：安装配套包 @local/blender-mcp（它自带 cordis.patch.yml 注册 mcp__blender__*），'
            + '重启后再调本工具确认。**不要改用无头 Blender 自己跑脚本绕过**——'
            + '那样插件的几何检查和看图检测都看不见你的场景，等于没做检查。')
        } else if (!nativeEndpointAligned) {
          lines.push('⚠ 插件检查端点与插件 mcpUrl 配置不同；DSH 原生 mcp__blender__* 连接不会随本参数切换。')
          lines.push('→ 先把本参数、插件 mcpUrl 和 DSH mcp-blender.url 设为同一地址，再开始建模。')
          lines.push('需要处理：' + endpointHint)
        } else if (ready) {
          lines.push('→ 现在可以直接用 mcp__blender__* 建模了。第一步建议 get_scene_info 看场景。')
        }

        const value = {
          kind: 'blender-ready',
          /* ok / launched 是注入上下文读的字段，必须和 index.js 的
           * buildStateText 对齐，否则工具成功但状态行仍显示「未就绪」。 */
          ok: ready,
          ready,
          pluginReady: res.ok,
          nativeEndpointAligned,
          nativeMissing: !!nativeSignal.nativeMissing,
          serverScriptFound: !!found,
          mcpToolCount,
          launched: args.auto_launch !== false,
          action: res.action,
          hint: [!nativeEndpointAligned ? endpointHint : null, res.hint || null]
            .filter(Boolean).join(' / ') || null,
          steps: res.steps,
          mcpUrl,
          mcpPort,
          blenderPort,
          at: Date.now(),
          lines,
        }
        if (remember) remember('blenderReady', value)
        return value
      },
    },

    /* ───────────────────────── 1. 命名 ───────────────────────── */
    {
      name: 'model_naming',
      description:
        '命名与检查辅助工具，可一次扫描或写回多个部件名。'
        + '对象名清楚后，穿模/孤立报告才容易对应到实际部件。'
        + '【何时调用】新建或批量生成一批部件后，名称还不清楚时用 scan/apply；'
        + '在 model_loop 检查前确认新增对象可识别即可，不必每建一个部件就单独调用。'
        + '刚打开陌生场景时可先 scan 查看现状。'
        + '【何时不调用】纯几何调整且对象名已清楚时；脚本已按规则命名、没有默认名或重名时。'
        + '【做什么】action=scan 返回所有 mesh 的对象名、建议部件名、尺寸、材质、是否还是默认名，标出重名与尺寸异常；'
        + 'action=apply 用 assignments 把对象名与部件名写回建模软件（Blender 写对象名 + ptc_part 属性；网页写 userData.ptcPart 与 name）。',
      parameters: {
        action: { type: 'string', required: true, description: 'scan = 只读扫描；apply = 写回命名。', enum: ['scan', 'apply'] },
        assignments: { type: 'array', description: 'apply 用：每项 { id: 当前对象名, part: 要起的部件名 }。', items: { type: 'object', additionalProperties: true } },
        limit: { type: 'integer', description: 'scan 最多返回多少条（默认 200）。' },
        only_generic: { type: 'boolean', description: 'scan 只列还没命名的默认名对象（默认 false）。' },
        save: { type: 'boolean', description: 'apply 后是否保存 .blend（默认 true；网页/obj 源忽略）。' },
        source: { type: 'string', description: '临时改用别的建模源：live（读活场景，默认）/ web / file（.obj 只读）。' },
        blend: { type: 'string', description: '临时指定「启动 Blender 时打开」的 .blend（不是读取源）。' },
        url: { type: 'string', description: '临时指定网页桥地址 ws://host:port。' },
        cdp_port: { type: 'integer', description: '临时指定 Chrome 调试端口（网页建模截图/取网格）。' },
        obj: { type: 'string', description: '临时指定 .obj 路径（只读源）。' },
      },
      output: { schema: ANY, render: renderReport },
      isConcurrencySafe: () => false,
      async execute(args) {
        const overrides = pickOverrides(args)
        return run(overrides, async (src) => {
          if (args.action === 'apply') {
            const res = await src.namingApply(args.assignments || [], { save: args.save !== false })
            const lines = ['已写回 ' + res.applied.length + ' 个部件名' + (res.skipped.length ? '，跳过 ' + res.skipped.length + ' 个' : '')]
            for (const a of res.applied.slice(0, 40)) lines.push('· ' + a.from + ' → 「' + a.part + '」' + (a.suffixed ? '（重名，实际对象名 ' + a.id + '）' : ''))
            for (const s of res.skipped.slice(0, 10)) lines.push('· 跳过 ' + JSON.stringify(s.input) + '：' + s.why)
            if (res.saved) lines.push('已保存：' + res.saved)
            return { kind: 'naming', action: 'apply', lines, applied: res.applied, skipped: res.skipped, saved: res.saved || null }
          }
          const scan = await src.namingScan({ limit: args.limit || 200, onlyGeneric: !!args.only_generic })
          const lines = [
            '共 ' + scan.totalMeshes + ' 个 mesh：已命名 ' + scan.named + '，仍是默认名 ' + scan.generic,
          ]
          if (scan.duplicates && scan.duplicates.length) {
            lines.push('重名部件：' + scan.duplicates.slice(0, 10).map((d) => d.part + '×' + d.count).join('、'))
          }
          /* 尺寸合理性：场景包围盒是最可靠的参照。比整个场景还大的单个部件，
           * 几乎一定是顶点坐标溢出 / 缩放没应用 / 单位错乱——这类错误模型光看
           * 尺寸数字发现不了（它不知道 5.2e12 对一个握把贴片意味着什么）。 */
          const items = scan.items || []
          const bad = findImplausibleSizes(items)
          if (bad.length) {
            lines.push('⚠ 尺寸异常 ' + bad.length + ' 个（比整个场景包围盒还大，几乎一定是坐标溢出/缩放未应用/单位错乱）：')
            for (const b of bad.slice(0, 10)) {
              lines.push('· ' + b.id + '：' + b.dims.map((d) => num(d)).join('×') + '（最大 ' + b.why + '）')
            }
          }
          for (const it of items.slice(0, 60)) {
            lines.push('· ' + it.id + (it.generic ? '（默认名）' : '') + ' → 建议「' + it.suggested + '」· 尺寸 '
              + it.dims.map((d) => num(d)).join('×') + (it.materials && it.materials.length ? ' · 材质 ' + it.materials.join(',') : ''))
          }
          if (items.length > 60) lines.push('…还有 ' + (items.length - 60) + ' 条，用 limit 调大')
          return {
            kind: 'naming', action: 'scan', lines,
            totalMeshes: scan.totalMeshes, named: scan.named, generic: scan.generic,
            duplicates: scan.duplicates || [], items,
            implausibleSizes: bad,
            truncated: !!scan.truncated,
          }
        })
      },
    },

    /* ─────────────────────── 2. 模型检查（合体） ─────────────────────── */

    /* ───────────────────────── 3. 穿模 ───────────────────────── */

    /* ─────────────────────── 4. 未接触 ─────────────────────── */
    {
      name: 'model_isolation',
      description:
        '【何时调用】场景里可能漏摆、错位、或某个零件本该连在别的部件上却没连时；删改部件后也值得复查一次。'
        + '【何时不调用】确认是悬挂件/粒子/背景这类本来就独立的东西，不必反复查。'
        + '【做什么】同时返回两层检测：全局按物品组检查组间相交和孤立连接簇；逐组检查内部相交和未连接部件簇。'
        + '使用真实三角面接触及边边距离，包围盒只筛候选，不再凭环抱关系豁免。'
        + '容差取较小件对角线的 1%，不超过 0.01 场景单位，并以 contact_gap 为下限；容差内接近会标注。'
        + '预算不足标为未知；接触不等于支撑正确，独立背景也不自动算错误。',
      parameters: {
        scope: { type: 'array', description: '只检查这些对象名或部件名（默认整个场景）。', items: { type: 'string' } },
        contact_gap: {
          type: 'number',
          description: '接触容差（默认 1e-5，只吸收浮点误差）。**不要调大**——'
            + '调大就等于把"差一点没贴上"也算成接触，那是错位不是接触。',
        },
        max_items: { type: 'integer', description: '最多返回多少个（默认 30，按间距降序）。' },
        contact_work_budget: { type: 'integer', description: '接触检测总计算预算，默认 5000000；达到预算会返回未知项，不误报孤立或通过。' },
        contact_pair_work_budget: { type: 'integer', description: '每对物体的接触检测预算，默认 1000000。' },
        source: { type: 'string', description: '临时改用别的建模源：live（读活场景，默认）/ web / file（.obj 只读）。' },
        blend: { type: 'string', description: '临时指定「启动 Blender 时打开」的 .blend（不是读取源）。' },
        url: { type: 'string', description: '临时指定网页桥地址。' },
        cdp_port: { type: 'integer', description: '临时指定 Chrome 调试端口。' },
        obj: { type: 'string', description: '临时指定 .obj 路径。' },
      },
      output: { schema: ANY, render: renderReport },
      isConcurrencySafe: () => true,
      async execute(args) {
        const cfg = config()
        const opts = {
          contactGap: numOr(args.contact_gap, 1e-5),
          maxItems: numOr(args.max_items, 30),
        }
        return run(pickOverrides(args), async (src) => {
          const t0 = Date.now()
          const { meshes, skipped = [] } = await src.extract({ maxObjects: cfg.maxObjects, maxTriangles: cfg.maxTriangles })
          if (!meshes.length) throw new Error('场景里没有 mesh，先建立或打开模型')
          const groups = groupMeshesIntoItems(meshes)
          const pairScans = new Map()
          const inter = interferencePairs(meshes, { minDepth: cfg.minDepth, minRatio: cfg.minRatio, pairScans })
          const allIsolation = isolatedMeshes(meshes, { ...opts, pairScans,
            maxTriangleWork: Math.max(0, Math.min(20000000, numOr(args.contact_work_budget, SCENE_TRIANGLE_WORK_LIMIT))),
            maxTriangleWorkPerPair: Math.max(0, Math.min(5000000, numOr(args.contact_pair_work_budget, TRIANGLE_WORK_LIMIT))),
          })
          const hierarchy = inspectHierarchy(meshes, groups, inter, allIsolation, { extractionSkipped: skipped.length })
          const scope = Array.isArray(args.scope) && args.scope.length ? new Set(args.scope.map(String)) : null
          const scopedIds = scope ? new Set(groups.filter(g => scope.has(g.name)).flatMap(g => g.ids)
            .concat(meshes.filter(m => scope.has(m.id) || scope.has(m.part)).map(m => m.id))) : null
          if (scopedIds && !scopedIds.size) throw new Error('scope 未匹配物品组或部件')
          const hits = scopedIds ? allIsolation.hits.filter(h => scopedIds.has(h.id)) : allIsolation.hits
          const r = { ...allIsolation, hits, shown: hits.slice(0, opts.maxItems) }
          const sceneDiag = sceneDiagonal(meshes)
          const lines = ['未接触检测：' + meshes.length + ' 个 mesh，命中 ' + r.hits.length + ' 个孤立件']
          lines.push(...hierarchyLines(hierarchy))
          if (!r.complete) lines.push('接触检测预算不足：' + r.unknownPairCount + ' 对未知；提高 contact_work_budget / contact_pair_work_budget 后复查。')
          if (r.hits.length === 0 && r.complete && !r.skippedSingleton) lines.push('本范围未发现单独未接触件；仍需核对上面的组间和组内连接簇。')
          for (const h of r.shown) lines.push('· ' + isolationLine(h))
          /* 命中孤立件时，强制模型先做现实合理性判断，再决定改不改 */
          if (r.shown.length) {
            for (const l of realityCheckLines(r.shown, { sceneDiag })) lines.push(l)
          }
          const value = {
            kind: 'isolation', lines, meshes: meshes.length,
            hierarchy, complete: hierarchy.complete, unknownPairs: r.unknownPairs,
            unknownPairCount: r.unknownPairCount, unknownPairsOmitted: r.unknownOmitted,
            scope: scope ? [...scope] : 'scene',
            hits: r.hits.length, items: r.shown,
            realityChecks: r.shown.map((h) => ({ part: h.part, ...realityCheck(h, { sceneDiag }) })),
            thresholds: { contactGap: r.contactGap, gapRatio: r.gapRatio, gapAbsCap: r.gapAbsCap },
            ms: Date.now() - t0,
          }
          if (remember) remember('isolation', value)
          return value
        })
      },
    },

    /* ─────────────────── 5. 小循环（检查 + 五视图 + 迭代闭环） ─────────────────── */
    {
      name: 'model_loop',
      description:
        '【何时调用】一批几何建完、关键结构或整体比例明显变化后，检查再决定下一批；准备交付时做完整验收。'
        + '通常在完成几个部件或一个逻辑阶段后检查，不需要每做完一个零件或每次小改都调用。'
        + '【何时不调用】还没有任何几何体时（先建东西）；单次轻微调整、纯改名或调阈值之后。'
        + '【做什么】一次跑完一个完整小循环，按顺序返回：'
        + '① 穿模检测 + ② 未接触检测 + ③ 固定五视图（正视、背面、侧视、顶视、正视剪影）。'
        + '完整检查提供场景范围的五视图；逐组隔离五视图是可选项，需显式传 per_mesh_views: true（默认 false）。'
        + '中间小改可传 quick_check: true 跳过渲图；verdict=done 时会自动补跑完整视图。'
        + '检查数据用于定位几何问题；视觉判断可在关键建模里程碑调用 model_review。'
        + '每次同时返回 hierarchy：全局按组检测组间相交和孤立连接簇，逐组检测内部相交与断连；复用真实三角面证据。'
        + '接触预算不足会标为未知；插接、接地是待核实的解释，不能用一句话批量忽略全部命中。'
        + '【默认自主细化】主体成型后主动补轮廓特征、连接与功能结构、符合风格的表面几何，'
        + '看图找有依据的缺口并实际补建，不等用户反复要求加细节。每轮会返回 detailGuidance 指明当前下一步；'
        + '多物品场景会轮换提示构图层级、空间落点、主题环境、重复变化、密度留白和全局统一；'
        + '本轮不要只给单件物体加零件，要处理一个有依据的组间关系或环境层次；'
        + '快速检查没有图片，不能据技术通过认定细节到位。低模、草模、简约、用途和预算以用户目标为准，不凑零件数。'
        + '【剪影验收】如果任务给了参考图（reference_image），会拿正视剪影和参考图逐像素比对轮廓重合度，'
        + '重合度低于 92% 时会报告差距，作为继续改进的参考，不会单独阻止停止。'
        + '\n'
        + '【迭代闭环 · 必须遵守】这个工具是闭环的一部分，不是一次性检查。每轮都要做自我判断：\n'
        + '  1. 调用时传 verdict：\n'
        + '     · continue + next_improvement：你认为**还能更好**，写清下一轮具体改什么（哪个部件、什么动作）。\n'
        + '       工具会告诉你这是第几轮，并回显你上一轮写的改进项，要求你确认真的做了。\n'
        + '     · done + stop_reason：当前范围已达到任务目标，说明完成情况和剩余限制；detail_notes 可补充本轮细节或调研记录。\n'
        + '       工具会检查停止条件，不满足会拒绝让你停。\n'
        + '  2. 判断是 continue 就执行真实的下一步，再调用本工具；检查受限时可调整检测预算或恢复视图，'
        + '不要为了过门禁反复减面、删除细节或合并零件。\n'
        + '  3. done 的硬门槛由工具按当前场景动态判断：需要的结构调研、复核后的建模改动、可靠分组；'
        + '未使用视觉复核员时，技术穿模/孤立检查还需通过。缺少 stop_reason 也不能签收。\n'
        + '  4. 剪影结果、检查轮次、detail_notes 和 remaining 都会反馈；轮数不设最低要求，'
        + '不要为了凑轮数制造改动，有实际遗留工作时再继续。',
      parameters: {
        target: {
          type: 'string',
          description: '检查范围。省略 = **整场景检查**；几何和分组数据会汇总所有物品组，并给出优先处理建议。'
            + '完整模式提供场景五视图，逐组隔离视图默认不渲染；需要时传 per_mesh_views: true（组数越多渲染成本越高）。'
            + '传组名 = 聚焦该组；传部件名 = 聚焦该部件。聚焦时仍检查全场景碰撞，并报告与目标有关的冲突。',
        },
        scope: { type: 'array', description: '检查范围（对象名或部件名列表）。省略时等于 target 或整场景。', items: { type: 'string' } },
        reference_image: { type: 'string', description: '参考图的本地路径。给了会做剪影比对并报告与 92% 门槛的差距；不单独阻止 done。' },
        purpose: { type: 'string', description: '这一轮在改进什么、要确认什么（会回显，便于对照上一轮）。' },
        verdict: {
          type: 'string',
          description: '本轮自我判断：continue = 还有具体且符合目标的改进；done = 当前范围达到任务目标，申请签收。',
          enum: ['continue', 'done'],
        },
        next_improvement: { type: 'string', description: 'verdict=continue 时必填：下一轮具体要改什么（哪个部件、什么动作）。' },
        stop_reason: { type: 'string', description: 'verdict=done 时必填：目标完成情况、停止依据和已知剩余限制。不要求宣称完美。' },
        detail_notes: {
          type: 'string',
          description: 'verdict=done 时可选：简要记录补充的细节或结构调研内容；不设最短长度，也不是停止门槛。'
            + '例如「外露边加了 0.5mm 倒角；握把加了三道防滑槽」。',
        },
        remaining: {
          type: 'string',
          description: '可选：记录尚未处理的事项，供停止时判断和后续沟通；填写内容会作为提醒，不会单独阻止停止。',
        },
        landed_previous: { type: 'boolean', description: '上一轮承诺的改进项是否已经落实。落实计数会作为提示，不是停止门槛。' },
        resolution: { type: 'integer', description: '单张边长像素（场景视图默认 900；分组视图固定 420）。' },
        per_mesh_views: { type: 'boolean', description: '是否额外渲染每个物品组的五视图。**默认 false**；完整检查提供场景五视图，quick_check 会跳过全部渲图。需要逐组图时设为 true（组数越多，图像和渲染成本越高）。' },
        quick_check: { type: 'boolean', description: '中间迭代设为 true 可跳过场景与逐组渲染，只跑几何/分组/精度检查；verdict=done 或 deliver=true 时自动执行完整视图检查。默认 false。' },
        contact_work_budget: { type: 'integer', description: '两层接触图检测的总预算，默认 5000000、最高 20000000；预算不足返回未知，不算通过。' },
        contact_pair_work_budget: { type: 'integer', description: '每对物体接触计算预算，默认 1000000、最高 5000000。' },
        // 宿主的 value schema DSL 不接受 minimum/maximum；实际预算在执行处钳制。
        mesh_pair_budget: { type: 'integer',
          description: '本轮包围盒重叠的网格对象对数量预算，默认 5000，最高 200000。报告跳过网格候选对时提高此项；与三角形工作预算不同，不需要减面、删件或合并物品。' },
        triangle_work_budget: { type: 'integer',
          description: '本轮三角形检测的总工作预算，默认 5000000，最高 20000000。只调整检测计算量，不改模型；较高预算会延长检查。' },
        triangle_pair_work_budget: { type: 'integer',
          description: '单对网格的检测工作预算，默认 1000000，最高 5000000。报告具体对象对超限时可提高后重查；不以减少细节或 join 零件换取通过。' },
        per_mesh_max: { type: 'integer', description: '最多额外隔离渲染几个物品组（0 或不传 = 全部组）。大场景可设上限控制图像量；未渲染的组不算已视觉核对。' },
        engine: { type: 'string', description: '渲染引擎：workbench（默认）/ eevee / cycles。', enum: ['workbench', 'eevee', 'cycles'] },
        extra_views: { type: 'array', description: '额外想看的视角（iso_ne/iso_nw/iso_se/iso_sw/back/right/bottom），只会追加。', items: { type: 'string' } },
        min_ratio: { type: 'number', description: '穿模阈值（默认 0.005）。' },
        contact_gap: { type: 'number', description: '未接触判定的绝对接触容差（默认 1e-5，只吸收浮点误差）。' },
        gap_ratio: { type: 'number', description: '未接触判定的**相对**容差（默认 0.01 = 自身对角线的 1%）。比这更近就算贴上了。' },
        acknowledge_isolated: {
          type: 'array',
          description: '**确认某些孤立件是合理的**（不计入门禁）。'
            + '每一项要写清 part（部件名）和 reason（简要说明为什么它该独立，不限字数）。'
            + '例：[{ part: "吊灯_灯泡", reason: "吊灯本来就是悬挂件，灯泡离灯罩有间隙" }]。'
            + '**只对确实合理的用**——把真问题也确认掉，等于自己骗自己。',
          items: {
            type: 'object',
            properties: {
              part: { type: 'string', description: '部件名（要和检测报告里的一致）。' },
              reason: { type: 'string', description: '为什么它该独立；简洁、具体即可，不限字数。' },
            },
            /* object 类型**必须显式声明 additionalProperties**。
             * 不写就报：
             *   unsupported JSON schema: parameters.xxx.items.additionalProperties
             *   must be explicitly true or false
             *
             * 而且**不能写 required: ['part', 'reason']**：
             *   unsupported JSON schema: parameters.xxx.items.required
             *   is not supported by the value schema DSL
             *
             * 这两个错误都发生在 defineTool 里 → ctx.effect 抛错 →
             * 整个 preset 激活失败 → 界面显示「加载失败」。
             * 光看代码看不出来，只有让 DSH 真的加载一次才会暴露。
             *
             * 必需性改由工具内部校验（部件名和非空理由缺一不可）。 */
            additionalProperties: false,
          },
        },
        silhouette_threshold: { type: 'number', description: '剪影对照的参考比例门槛 0~1（默认 0.92）；用于标记差距，不是停止门槛。' },
        deliver: { type: 'boolean', description: '这一轮是否准备交付（等价于想停，走同一套停止条件检查）。' },
        reset: { type: 'boolean', description: '重置迭代计数（开始新任务/新部件时用）。' },
        source: { type: 'string', description: '临时改用别的建模源：live（读活场景，默认）/ web / file（.obj 只读）。' },
        blend: { type: 'string', description: '临时指定「启动 Blender 时打开」的 .blend（不是读取源）。' },
        url: { type: 'string', description: '临时指定网页桥地址。' },
        cdp_port: { type: 'integer', description: '临时指定 Chrome 调试端口。' },
        obj: { type: 'string', description: '临时指定 .obj 路径。' },
      },
      output: { schema: ANY, render: renderShots },
      isConcurrencySafe: () => false,
      async execute(args) {
        const cfg = config()
        const overrides = pickOverrides(args)
        return run(overrides, async (src) => {
          const t0 = Date.now()
          const requestsSignoff = args.verdict === 'done' || args.deliver === true
          const quickCheck = args.quick_check === true && !requestsSignoff
          const target = args.target && args.target !== 'scene' ? args.target : null
          const loopTarget = Array.isArray(args.scope) && args.scope.length
            ? 'scope:' + args.scope.map(String).sort().join('|') : target
          const minRatio = numOr(args.min_ratio, cfg.minRatio)
          const contactGap = numOr(args.contact_gap, 1e-5)
          const passIoU = numOr(args.silhouette_threshold, SILHOUETTE_PASS_IOU)

          /* ⓪ 迭代轮次：先记账，再检查。
           * 顺序很重要——先知道这是第几轮，才能决定「能不能停」。 */
          const roundInfo = tracker.beginRound(loopTarget, {
            reset: !!args.reset,
            landedPrevious: args.landed_previous === true,
          })

          /* reset = 开始新任务 → 阶段也回退到建模。
           * 这很重要：改了形体就必须重新验收，不能沿用上次的建模签收。 */
          if (args.reset) {
            if (typeof resetPhase === 'function') resetPhase({ newTask: !loopTarget })
          }

          /* ① 抽取几何 + 解析检查范围。
           *
           * **必须先取全场景**，原因有两个：
           *   1. 分组要按全场景算（一个物品的部件可能分散在命名里）
           *   2. 检查单个物品时，必须能检测它和**组外物体**的穿模——
           *      只看本组的话，「椅子穿进桌子」这种错永远发现不了
           *
           * target 支持三种值：
           *   '场景'/省略  → 全局检查
           *   '桌'         → **物品组**名，检查这一组的全部部件
           *   '桌_桌面'    → 单个部件
           */
          const extracted = await src.extract({
            maxObjects: cfg.maxObjects,
            maxTriangles: cfg.maxTriangles,
          })
          const allMeshes = extracted.meshes || []
          const revision = geometryRevision(allMeshes)
          const extractionSkipped = Array.isArray(extracted.skipped) ? extracted.skipped : []
          if (!allMeshes.length) throw new Error('场景里没有 mesh')

          /* 全场景分组（解析组名、算跨组穿模都要用） */
          const allGroups = groupMeshesIntoItems(allMeshes)

          /* 解析 target / scope */
          let scopeIds = null          // null = 全场景
          let scopeGroup = null        // 命中的物品组
          let scopeLabel = '整场景'
          let kind = 'scene'

          const explicitScope = Array.isArray(args.scope) && args.scope.length
            ? args.scope.map(String)
            : null

          if (explicitScope) {
            const ids = new Set()
            for (const name of explicitScope) {
              const g = allGroups.find((x) => x.name === name)
              if (g) { for (const id of g.ids) ids.add(id); continue }
              const m = allMeshes.find((x) => x.part === name || x.id === name)
              if (m) ids.add(m.id)
            }
            if (!ids.size) {
              throw new Error('scope 里没有任何有效的组或部件：' + explicitScope.join('、')
                + '。现有组：' + allGroups.map((g) => g.name).join('、'))
            }
            scopeIds = ids
            scopeLabel = '指定范围（' + explicitScope.join('、') + '）'
            kind = 'part'
          } else if (target) {
            const g = allGroups.find((x) => x.name === target)
            if (g) {
              scopeGroup = g
              scopeIds = new Set(g.ids)
              scopeLabel = '物品「' + g.name + '」（' + g.parts.length + ' 件）'
              kind = 'part'
            } else {
              const m = allMeshes.find((x) => x.part === target || x.id === target)
              if (!m) {
                throw new Error('找不到名为「' + target + '」的物品组或部件。\n'
                  + '现有物品组：' + (allGroups.map((g) => g.name + '(' + g.parts.length + ')').join('、')
                    || '（无）') + '\n'
                  + '现有部件：' + allMeshes.map((x) => x.part).slice(0, 20).join('、'))
              }
              scopeIds = new Set([m.id])
              scopeLabel = '部件「' + m.part + '」'
              kind = 'part'
            }
          }

          /* 本次检查/出图用的 mesh 集合 */
          const meshes = scopeIds ? allMeshes.filter((m) => scopeIds.has(m.id)) : allMeshes
          if (!meshes.length) throw new Error('检查范围内没有 mesh')

          const min = [Infinity, Infinity, Infinity]
          const max = [-Infinity, -Infinity, -Infinity]
          for (const m of meshes) {
            for (let i = 0; i < 3; i++) {
              min[i] = Math.min(min[i], m.bbox[i])
              max[i] = Math.max(max[i], m.bbox[i + 3])
            }
          }
          const dims = [max[0] - min[0], max[1] - min[1], max[2] - min[2]]

          /* ② 两项检测——**在全场景上跑，然后按范围过滤结果**。
           * 这样单物品检查也能发现它和组外物体的碰撞。 */
          const meshPairBudget = Math.max(0, Math.min(200000,
            numOr(args.mesh_pair_budget, 5000)))
          const pairScans = new Map()
          const interAll = interferencePairs(allMeshes, {
            pairScans,
            minDepth: cfg.minDepth, minRatio, maxPairs: 60,
            maxCandidates: meshPairBudget,
            maxTriangleWork: Math.max(0, Math.min(20000000,
              numOr(args.triangle_work_budget, SCENE_TRIANGLE_WORK_LIMIT))),
            maxTriangleWorkPerPair: Math.max(0, Math.min(5000000,
              numOr(args.triangle_pair_work_budget, TRIANGLE_WORK_LIMIT))),
          })
          const inspectionDetails = []
          if (interAll.skipped > 0) inspectionDetails.push('跳过 ' + interAll.skipped
            + ' 个网格候选对（对象对预算 ' + meshPairBudget + '，共发现 ' + interAll.candidates + ' 对）')
          if (interAll.trianglePairsCapped > 0) inspectionDetails.push(
            interAll.trianglePairsCapped + ' 个网格对达到检测计算预算（单对 '
              + interAll.triangleWorkPerPairLimit + '，整场景 ' + interAll.triangleWorkLimit + '）')
          if (extractionSkipped.length > 0) inspectionDetails.push('几何源跳过 ' + extractionSkipped.length + ' 个对象')
          let inspectionComplete = interAll.complete !== false
            && (interAll.skipped || 0) === 0
            && (interAll.trianglePairsCapped || 0) === 0
            && extractionSkipped.length === 0
          const inter = scopeIds
            ? { ...interAll, hits: interAll.hits.filter((h) => scopeIds.has(h.aId) || scopeIds.has(h.bId)) }
            : interAll

          const isoAll = isolatedMeshes(allMeshes, {
            pairScans,
            maxTriangleWork: Math.max(0, Math.min(20000000, numOr(args.contact_work_budget, SCENE_TRIANGLE_WORK_LIMIT))),
            maxTriangleWorkPerPair: Math.max(0, Math.min(5000000, numOr(args.contact_pair_work_budget, TRIANGLE_WORK_LIMIT))),
            contactGap: numOr(args.contact_gap, 1e-5),
            /* 相对容差：默认自身对角线的 1%。
             * 不用绝对容差的原因是它对小物体过严——
             * 壶柄离壶身 0.0001 对 0.15m 的壶就是 0.07%，属于精度误差，
             * 但按 1e-5 的绝对容差会被判成「没贴上」。 */
            gapRatio: numOr(args.gap_ratio, 0.01),
            maxItems: 60,
          })
          const iso = scopeIds
            ? { ...isoAll, hits: isoAll.hits.filter((h) => scopeIds.has(h.id)) }
            : isoAll
          const isoChecked = !isoAll.skippedSingleton
          if (isoAll.complete === false) {
            inspectionComplete = false
            inspectionDetails.push('接触检测有 ' + isoAll.unknownPairCount + ' 对未完成；提高 contact_work_budget / contact_pair_work_budget')
          }
          const hierarchy = inspectHierarchy(allMeshes, allGroups, interAll, isoAll,
            { extractionSkipped: extractionSkipped.length })

          /* ②a 分组 + 分组穿模分析。
           * 组 = 一个完整物品 + 它的配件（按命名前缀或空间邻近）。
           * 穿模分「组内」和「组间」两种，性质完全不同，必须分开报。
           *
           * 单物品检查时 groups 只留本组，但 groupInter 里仍然保留
           * 「本组 vs 组外」的跨组信息——那是要报给模型的。 */
          const groups = scopeGroup ? [scopeGroup] : allGroups
          const groupInter = analyzeGroupInterference(allGroups, inter.hits)
          /* 聚焦到本组时，只报告影响本组的组内/组间条目。
           * **注意**：internalPokeCount / crossPokeCount 这些统计字段
           * 必须一起重算——漏了会导致「文案说穿出、但 pass 判定认为没有」。 */
          const focusLs = scopeGroup
            ? {
              perGroup: groupInter.perGroup.filter((g) => g.name === scopeGroup.name),
              crossGroup: groupInter.crossGroup.filter(
                (c) => c.aGroup === scopeGroup.name || c.bGroup === scopeGroup.name),
              internalCount: 0,
              internalPokeCount: 0,
              crossCount: 0,
              crossPokeCount: 0,
            }
            : groupInter
          if (scopeGroup) {
            focusLs.internalCount = focusLs.perGroup.reduce((s, g) => s + g.internal.length, 0)
            focusLs.internalPokeCount = focusLs.perGroup.reduce(
              (s, g) => s + (g.internalPokeCount || 0), 0)
            focusLs.crossCount = focusLs.crossGroup.length
            focusLs.crossPokeCount = focusLs.crossGroup.filter((c) => c.severe).length
          }

          /* ── 逐组汇总（方案 B）──
           *
           * 只在**整场景检查**时给出（scopeGroup 为空）。
           * 如果模型已经指定了某个组，那它要的就是那一组的细节，
           * 再列全部组只是噪音。
           *
           * 给出什么：
           *   · 每组几个部件、组内穿模几对（其中穿出几对）
           *   · 该组的孤立件
           *   · 该组和别组的交叉穿模
           *   · 一句「这一组能不能过」的判定
           *
           * 为什么这么重要：整场景的「穿模 60 对」看不出是哪栋楼的问题，
           * 而「主塔：组内穿出 3 对」直接告诉该修哪里。 */
          let groupDigest = null
          if (!scopeGroup && allGroups.length > 1) {
            const rows = []
            for (const g of allGroups) {
              if (g.by === 'ungrouped') continue
              const gi = groupInter.perGroup.find((x) => x.name === g.name) || { internal: [], cross: [] }
              const internalPoke = gi.internal.filter((p) => p.state === 'poke-through'
                || p.state === 'mutual' || p.state === 'coincident').length
              /* 本组的孤立件 */
              const isoInGroup = isoAll.hits.filter((h) => g.ids.includes(h.id))
              const crossIn = (gi.cross || []).filter((c) => c.severe).length
              const ok = internalPoke === 0 && isoInGroup.length === 0 && crossIn === 0
              rows.push({
                name: g.name,
                parts: g.parts.length,
                internal: gi.internal.length,
                internalPoke,
                cross: (gi.cross || []).length,
                crossSevere: crossIn,
                isolated: isoInGroup.map((h) => h.part),
                ok,
                /* 问题数：用来排序，最该修的排前面 */
                issueCount: internalPoke + isoInGroup.length + crossIn,
              })
            }
            /* 问题多的排前面：模型该先修最脏的那个组 */
            rows.sort((a, b) => b.issueCount - a.issueCount || a.name.localeCompare(b.name))
            groupDigest = {
              groups: rows,
              total: rows.length,
              cleanGroups: rows.filter((r) => r.ok).length,
              dirtyGroups: rows.filter((r) => !r.ok).length,
            }
          }

          /* ③ 场景五视图 + 剪影（快速迭代可跳过渲图） */
          const req = requiredViews(kind, dims)
          const extra = Array.isArray(args.extra_views) ? args.extra_views.map(String) : []
          const finalViews = [...req.views]
          for (const v of extra) if (!finalViews.includes(v)) finalViews.push(v)
          const shots = buildShots(finalViews, kind, dims, target, min, max)
          /* 场景级取景要排掉远处的环境物（星空球/地球/大气），否则主体被压成
           * 亚像素、出图全灰——实测 27 的 AURORA-9 就是这样。被排掉的对象
           * 仍在画面里，只是不决定取景范围。 */
          const framing = target ? null : pickFramingFocus(allMeshes)
          const rendered = quickCheck
            ? { shots: [] }
            : await src.renderShots(shots, {
              resolution: args.resolution || 900,
              engine: args.engine || 'workbench',
              isolate: target || undefined,
              focus: framing && framing.mode !== 'all' ? framing.names : undefined,
            })
          const attached = await attachShots(hostCtx, rendered.shots || [], { prefix: target || 'scene' })

          /* ④ 剪影比对（给了参考图才做）。
           *
           * 参考图的极性不可控：照片通常物体暗、背景亮；我们的剪影物体白、背景黑。
           * 所以两种极性都算一遍 IoU，取高的那个——这比让用户先修图靠谱得多。 */
          let sil = null
          const refPath = args.reference_image ? String(args.reference_image) : null
          if (refPath && quickCheck) {
            sil = { attempted: false, skipped: true, why: '快速检查跳过渲染，最终检查时会重新比对' }
          } else if (refPath) {
            const silShot = attached.find((a) => a.view === 'front_silhouette')
            if (!silShot || !silShot.path) {
              sil = { attempted: true, ok: false, why: '没有渲出正视剪影，无法比对' }
            } else if (!existsSync(refPath)) {
              sil = { attempted: true, ok: false, why: '参考图不存在：' + refPath }
            } else {
              try {
                const a = decodePngGray(await readFile(silShot.path))
                const bRaw = decodePngGray(await readFile(refPath))
                const bNormal = cropToContent(bRaw.gray, bRaw.width, bRaw.height)
                const bInverted = { gray: invertGray(bNormal.gray), w: bNormal.w, h: bNormal.h }
                const candidates = [bNormal, bInverted].map((b) => {
                  const pair = preparePair(a, b, 256)
                  const stat = silhouetteIoU(pair.a, pair.b, pair.w, pair.h)
                  return { stat, polarity: b === bNormal ? 'normal' : 'inverted' }
                })
                candidates.sort((x, y) => y.stat.iou - x.stat.iou)
                const best = candidates[0]
                const verdict = judgeSilhouette(best.stat.iou, passIoU)
                sil = {
                  attempted: true, ok: true,
                  iou: Number(best.stat.iou.toFixed(4)),
                  iouPercent: (best.stat.iou * 100).toFixed(2) + '%',
                  threshold: passIoU,
                  pass: verdict.pass,
                  verdict: verdict.verdict,
                  polarity: best.polarity,
                  silhouetteRatio: Number(best.stat.aRatio.toFixed(4)),
                  referenceRatio: Number(best.stat.bRatio.toFixed(4)),
                  reference: refPath,
                }
              } catch (e) {
                sil = { attempted: true, ok: false, why: '剪影比对失败：' + String((e && e.message) || e) }
              }
            }
          }

          /* ⑤ 汇总 */
          const lines = []
          lines.push('小循环 · ' + scopeLabel + ' · ' + meshes.length + ' 个 mesh'
            + (scopeIds ? '（场景共 ' + allMeshes.length + ' 个）' : ''))
          if (scopeGroup) {
            lines.push('  本组部件：' + scopeGroup.parts.join('、'))
            lines.push('  ⓘ 本组与组外物体的碰撞也纳入检测；实际覆盖是否完整见下方报告。')
          }
          if (args.purpose) lines.push('本轮目的：' + args.purpose)
          lines.push(...hierarchyLines(hierarchy))

          /* 提醒：改完之后一直在用 look 看图，但没走检查。
           * 注意：look 现在会附带穿模/孤立摘要（见 buildViewCheckReport），
           * 所以这里不能说「看图不等于检查」——它确实带了检测，
           * 缺的是五视图和逐组完整层次，措辞要按这个说。 */
          const ms = typeof getModelingState === 'function' ? getModelingState() : null
          if (ms && ms.lookSinceEdit >= 3) {
            lines.push('')
            lines.push('ⓘ 你改完之后已经用 look 看了 ' + ms.lookSinceEdit + ' 次图。'
              + '**看图只带穿模与孤立摘要，不等于完整检查**——'
              + 'look 的结果没有分组五视图，也没有逐组完整层次报告。')
            lines.push(quickCheck
              ? '   本轮快速检查提供几何与分组数据，不附图；结合已有视图判断，收尾时再做完整视图验收。'
              : '   本轮提供几何数据和场景五视图；逐组隔离视图仅在明确请求时生成。')
          }

          lines.push('① 穿模：' + (inter.hits.length === 0
            ? '没有超过阈值的部件对 ✓'
            : inter.hits.length + ' 对（阈值 ' + pct(minRatio) + '），'
              + '其中组内 ' + focusLs.internalCount + ' 对、组间 ' + focusLs.crossCount + ' 对'
              + ((focusLs.crossPokeCount || 0) + (focusLs.internalPokeCount || 0) > 0
                ? '，**含疑似穿出 ' + ((focusLs.crossPokeCount || 0) + (focusLs.internalPokeCount || 0)) + ' 对（优先核实）**'
                : '')))
          if (!inspectionComplete) {
            lines.push('   ⛔ **几何检查不完整**：' + inspectionDetails.join('；') + '。')
            for (const item of extractionSkipped.slice(0, 8)) {
              lines.push('   · 跳过对象 ' + (item.id || item.name || '(未命名)')
                + (item.why ? '：' + item.why : ''))
            }
            if (extractionSkipped.length > 8) lines.push('   …还有 ' + (extractionSkipped.length - 8) + ' 个跳过对象')
            for (const pair of (interAll.incompletePairs || []).slice(0, 12)) {
              lines.push('   未完成：「' + pair.a + '」↔「' + pair.b + '」 · '
                + (pair.reason === 'scene_work_limit' ? '场景总预算' : '单对预算')
                + ' · 已检查 AABB 候选 ' + pair.candidateCount + ' 对')
            }
            lines.push('   这是检查覆盖限制，不等于这些部件有错。保留模型细节和 Collection，'
              + '不要为过关反复减面、删件或 join 零件。')
            if (interAll.trianglePairsCapped > 0) {
              lines.push('   可提高 triangle_pair_work_budget / triangle_work_budget 后重查；'
                + '若同一对象对仍超限，停止重复尝试并说明工具限制，未覆盖部分不能宣称通过。')
            }
            if (interAll.skipped > 0) {
              lines.push('   本轮达到的是对象对数量上限，不是抽取面数上限。'
                + '下次提高 mesh_pair_budget，当前共需 ' + interAll.candidates + ' 对（最高 200000）；'
                + '只提高三角形工作预算不会补齐这些跳过项。不要为此减面、删细节或 join 零件。')
            }
            if (extractionSkipped.length > 0) {
              lines.push('   几何源跳过对象：检查抽取预算和源连接，完整抽取后再复查。')
            }
            lines.push('   本轮不能签收；同一限制持续存在时说明未覆盖范围并停止无效重试。')
          }
          /* 接地豁免：说出来，避免「穿模 0 对」被误读成「检查没生效」 */
          if (inter.grounded > 0) {
            const gs = inter.groundSurfaces || []
            lines.push('   接地 ' + inter.grounded + ' 对（不算穿模：'
              + (gs.length ? gs.map((g) => '「' + g.part + '」').join('、') : '承托面')
              + ' 是候选承托面，已确认表面接触；是否符合预期浅埋仍需核对用途）')
          }

          /* 状态说明：不同穿模状态严重程度完全不同 */
          const stateHint = (p) => {
            if (!p.state) return ''
            return ' [' + (p.stateLabel || p.state)
              + (p.axisName ? '·' + p.axisName + '轴' : '') + ']'
          }

          /* Collection 只说明组织关系；相交是否违背设计还需功能与视图证据。 */
          if (focusLs.crossCount > 0) {
            lines.push('')
            lines.push('   ⛔ **组间穿模候选 ' + focusLs.crossCount + ' 对**（尚未解释，不能直接算通过）：')
            for (const c of focusLs.crossGroup.slice(0, 10)) {
              lines.push('   · 「' + c.aGroup + '」的「' + c.a + '」 ↔ 「'
                + (c.bGroup || '（无组）') + '」的「' + c.b + '」' + stateHint(c))
              lines.push('     穿模程度 ' + pct(c.ratio) + '，最大穿透 ' + num(c.depth)
                + '，重叠面 ' + (c.overlapCapped ? '≥' + c.overlapFaces : c.overlapFaces))
              if (c.stateDetail) lines.push('     状态：' + c.stateDetail)
            }
            if (focusLs.crossCount > 10) lines.push('   …还有 ' + (focusLs.crossCount - 10) + ' 对')
            lines.push('   → 先结合用途与视图判断：确认是非预期的实体穿透或错位时必须修。'
              + '分在不同 Collection 不代表不能接触或嵌套；接地、插接、雾效、火焰和背景交叠可能合理。')
            lines.push('   对有意重叠说明具体用途与可见证据，按复核流程确认；'
              + '不要仅为清零告警删除特效、植被、远景或改变装配。未解释的命中仍保留。')
          }

          /* 组内状态也是几何线索，不能把特效/装配关系直接判成实体错误。 */
          const withInternal = focusLs.perGroup.filter((g) => g.internal.length > 0)
          if (withInternal.length > 0) {
            const pokeTotal = focusLs.internalPokeCount || 0
            lines.push('')
            lines.push('   ' + (pokeTotal > 0 ? '⛔' : '⚠') + ' 组内穿模 '
              + focusLs.internalCount + ' 对（同一物品的部件之间）'
              + (pokeTotal > 0 ? '，其中 **' + pokeTotal + ' 对疑似穿出（优先核实）**' : '') + '：')
            for (const g of withInternal.slice(0, 8)) {
              lines.push('   · 「' + g.name + '」内部 ' + g.internal.length + ' 对'
                + (g.internalPokeCount ? '（穿出 ' + g.internalPokeCount + '）' : ''))
              for (const p of g.internal.slice(0, 4)) {
                const bad = p.state === 'poke-through' || p.state === 'mutual' || p.state === 'coincident'
                lines.push('     - ' + (bad ? '⛔ ' : '') + '「' + p.a + '」↔「' + p.b + '」'
                  + stateHint(p) + ' 程度 ' + pct(p.ratio) + '，穿透 ' + num(p.depth))
                if (bad && p.stateDetail) lines.push('       ' + p.stateDetail)
              }
            }
            lines.push('')
            lines.push('   **两类要分开看**：')
            lines.push('   · **插入**（没露出来）：通常合理——腿插进桌面、靠背插进座面，'
              + '插接比对接牢固。判断深度是否设计需要即可。')
            lines.push('   · **穿出 / 互穿 / 重合**：优先核实；实体出现非预期突破口、错位或重复建件时必须修。'
              + '几何状态不证明设计错误，特效、布料搭接与有意装配需结合用途和视图判断。')
          }

          /* 没有分组信息时（只有一个 mesh）退回原始列表 */
          if (groups.length <= 1 && inter.hits.length > 0 && focusLs.crossCount === 0) {
            for (const h of inter.hits.slice(0, 10)) lines.push('   · ' + interferenceLine(h))
            if (inter.hits.length > 10) lines.push('   …还有 ' + (inter.hits.length - 10) + ' 对')
          }

          if (!isoChecked) {
            lines.push('② 未接触：范围里只有 1 个 mesh，孤立检测没有意义，已跳过')
          } else {
            lines.push('② 未接触：' + (iso.hits.length === 0
              ? (isoAll.complete ? '无单独未接触件；继续核对两层连接簇' : '无已确认孤立件，但接触覆盖不完整，不能算通过')
              : iso.hits.length + ' 个部件与**所有**其它 mesh 都不接触（判定标准：必须表面贴合或穿透才算接触）'))
            for (const h of iso.hits.slice(0, 10)) lines.push('   · ' + isolationLine(h))
            if (iso.hits.length > 10) lines.push('   …还有 ' + (iso.hits.length - 10) + ' 个')
            /* 孤立不等于错：强制先做现实合理性判断 */
            if (iso.hits.length) {
              for (const l of realityCheckLines(iso.hits.slice(0, 10), { sceneDiag: sceneDiagonal(meshes) })) {
                lines.push(l)
              }
            }
          }

          /* ②b 逐 mesh 隔离检查 + 精度一致性。
           * 整场景检查会掩盖「小零件藏在别的零件里」「某个零件特别糙」这类问题，
           * 必须把每个 mesh 单独看一遍。这里先算好，后面 pass 判定要用。 */
          const each = inspectEachMesh(meshes)
          lines.push('②b 逐 mesh 隔离检查（' + each.count + ' 个 mesh 单独看）：')
          if (each.problems.length === 0) {
            lines.push('   逐 mesh 诊断未发现达到报告阈值的退化或碎片问题 ✓；不等于已证明封闭、流形或无自相交。')
          } else {
            lines.push('   ' + each.problems.length + ' 个 mesh 单独看有问题：')
            for (const pb of each.problems.slice(0, 8)) {
              lines.push('   · 「' + pb.mesh.part + '」')
              for (const it of pb.iso.issues) lines.push('     - [' + it.kind + '] ' + it.detail)
            }
            if (each.problems.length > 8) lines.push('   …还有 ' + (each.problems.length - 8) + ' 个')
          }

          /* ②c 精度一致性：同一场景里的零件精度应该在同一量级。
           * 差异太大就会出现「一个精致一个粗糙」。
           * 判定按「尺寸分组 + 组内比较」做，因为不同功能的零件精度本来就该不同。 */
          if (each.tooFewForConsistency) {
            lines.push('   精度一致性：mesh 少于 4 个，没有可比样本，跳过')
          } else if (each.outliers.length === 0) {
            const gs = (each.groups || []).filter((g) => g.medianEdge != null)
            lines.push('   精度一致性：所有零件精度接近 ✓（分 ' + gs.length + ' 个尺寸组比较，'
              + '整体相对粒度中位数 ' + (each.median?.relativeEdge ?? '?') + '）')
          } else {
            lines.push('   精度一致性：' + each.outliers.length + ' 个零件在同尺寸组内明显偏离'
              + '（整体相对粒度中位数 ' + (each.median?.relativeEdge ?? '?') + '）')
            for (const o of each.outliers.slice(0, 6)) {
              lines.push('   · 「' + o.part + '」(' + o.precision.triangles + ' 面)')
              for (const it of o.issues) lines.push('     - ' + it.detail)
            }
            if (each.outliers.length > 6) lines.push('   …还有 ' + (each.outliers.length - 6) + ' 个')
            lines.push('   → 这是精度提示，不单独阻止通过。结合轮廓、曲率、着色和目标视距判断；'
              + '平板与曲面允许不同密度，不为统一统计值减面或细分。')
          }

          /* ②d 逐 mesh 五视图：把每个 mesh 单独隔离渲染五个方向。
           *
           * 为什么需要：整场景的五视图看不出「某个零件只做了朝向相机的那个面」。
           * 尤其**没有参考图、自己在搭场景时**，这是唯一能发现
           * 「背面/侧面是空的」的手段。
           *
           * 只在活场景模式下做（live 源），且只挑最需要看的几个 mesh——
           * 每个 mesh 五张图，上下文消耗很大。 */
          let perMeshViews = null
          let perMeshImages = []
          /* 分组已在 ②a 处算好（groups 定义在上面），这里直接用。 */
          /* 判断能不能做隔离渲染：必须用**解析后的**源类型，
           * 不能用 describe()——后者在默认配置（source='auto'）下返回 'auto'，
           * 而实际解析出来是 live。这个 bug 导致分组五视图
           * 在真实会话里从未执行过（测试里显式传了 source:'live' 所以没暴露）。 */
          let resolvedKind = null
          if (!quickCheck && args.per_mesh_views === true) {
            try {
              resolvedKind = await src.resolve()
            } catch { /* 解析失败就跳过渲染 */ }
          }
          const canIsolateRender = resolvedKind === 'live'
          /* ── 分组五视图：现在是**可选**的 ──
           *
           * 改动的理由：以前这里默认渲染每个组的五视图（默认 true），
           * 于是「看图」这件事被绑在检查工具上。代价是：
           *   · 每次 model_loop 都要渲染 5×组数 张图，慢
           *   · 出的是 Workbench 灰白图，看不到材质和光照
           *   · 模型误以为「我没调 model_loop 就没看图」，于是要么盲改、
           *     要么为了出图而合并零件（把 8 个组并成 1 个）
           *
           * 现在把「看图」还给模型自己：用 look({view:'angles'})，
           * 一次三个角度、能选 shading、能看真实光照。
           * 检查工具专注它擅长的事——**数据**：穿模、孤立、精度。
           *
           * 想让它出图仍然可以，显式传 per_mesh_views: true。 */
          if (!quickCheck && canIsolateRender && args.per_mesh_views === true) {
            /* per_mesh_max 传 0 或负数表示「全部组」；不传也默认全部 */
            const cands = pickGroupsForViews(groups, each, args.per_mesh_max)
            if (cands.length) {
              lines.push('')
              lines.push('②d 分组五视图（隔离渲染，用来判断结构对不对、像不像现实）：')
              lines.push('   按「完整物品 + 配件」分成 ' + groups.length + ' 组'
                + (cands.length === groups.length ? '，**每组都出图**' : ''))
              for (const g of groups) {
                const willRender = cands.some((c) => c.name === g.name)
                lines.push('   · 「' + g.name + '」= ' + g.parts.length + ' 个 mesh'
                  + (g.parts.length <= 6 ? '（' + g.parts.join('、') + '）' : '')
                  + ' · 尺寸 ' + g.dims.map((d) => num(d)).join('×')
                  + (willRender ? '' : '（本次不出图）'))
              }
              if (cands.length < groups.length) {
                lines.push('   ⚠ 本次只渲染 ' + cands.length + ' 组（你显式限制了 per_mesh_max）——'
                  + '没出图的组**等于没检查过**，别宣布完成。')
              }
              try {
                perMeshViews = await renderFiveViewsForMany(
                  cands.map((c) => ({ name: c.name, objects: c.ids })),
                  { width: 420, height: 420, maxGroups: cands.length, mcpUrl: src.opts?.mcpUrl },
                )
                /* 把 base64 落成 attachment，这样图片能真的给到模型眼前 */
                const flat = []
                for (const r of perMeshViews) {
                  for (const v of r.views) {
                    if (v.ok && v.base64) {
                      flat.push({
                        object: r.object,
                        view: v.view,
                        base64: v.base64,
                        mimeType: v.mimeType,
                      })
                    }
                  }
                }
                if (flat.length) {
                  const attachedImgs = await attachBase64Images(hostCtx, flat, { prefix: 'mesh5v' })
                  perMeshImages = attachedImgs.filter((x) => x.attached)
                }
                for (const r of perMeshViews) {
                  const okCount = r.views.filter((v) => v.ok).length
                  lines.push('   · 「' + r.object + '」：' + okCount + '/' + r.views.length + ' 个视角出图成功')
                  if (r.error) lines.push('     渲染出错：' + r.error)
                  const failed = r.views.filter((v) => !v.ok)
                  if (failed.length) {
                    lines.push('     失败视角：' + failed.map((v) => v.view).join('、'))
                  }
                  /* 空图警告：图"出图成功"但其实是纯背景时，必须说出来。
                   * 不说的话模型会拿一张空白图去判断结构，结论必然是错的。 */
                  const blanks = r.views.filter((v) => v.ok && v.warning)
                  if (blanks.length) {
                    lines.push('     ⚠ **这组有 ' + blanks.length + ' 个视角渲染出来是空图**：'
                      + blanks.map((v) => v.view).join('、'))
                    lines.push('       原因：' + blanks[0].warning)
                    lines.push('       → 空图**不能用来判断结构**。要么场景里没有可见几何，'
                      + '要么视图方向框错了。先确认这几张图里真的没有东西，再继续判断。')
                  }
                }
                lines.push('   看图判断：某个视角几乎是空的，但那个面本该有结构 → 漏做了。'
                  + '某两个视角一样 → 那个方向本来就是薄板（正常）。')
                lines.push('   **你可以认定某个视角不需要细节，但要说得出为什么。**')
              } catch (e) {
                lines.push('   五视图渲染失败：' + String((e && e.message) || e).slice(0, 200))
                lines.push('   （不影响其它检查，但你就少了判断「哪些视角没做」的依据）')
              }
            }
          }

          const dupes = quickCheck ? [] : duplicateViewGroups(attached)
          if (quickCheck) {
            lines.push('③ 视觉复核：本轮快速检查跳过渲图；最终 done 检查会自动补跑五视图。')
            if (args.per_mesh_views === true) lines.push('   分组隔离图也随快速检查跳过。')
          } else {
            lines.push('③ 五视图：' + finalViews.map((v) => (VIEW_LABELS[v] || v)).join(' / ')
              + '（' + finalViews.join(' / ') + '）')
            lines.push('   ' + req.reason)
            for (const a of attached) {
              lines.push('   · ' + (VIEW_LABELS[a.view] || a.view) + '：'
                + (a.attached ? '已附图 ' + a.image.width + '×' + a.image.height : '未附图（' + (a.why || '未知') + '）'))
            }
            for (const group of dupes) {
              lines.push('   ⚠ 这些视角渲出来是同一张图：' + group.join(' / ')
                + ' —— 该方向上这个物体本来就是扁的（比如薄板从正面和顶面看都是同一条边），'
                + '不代表视角选错；但如果它们本应不同，说明视角轴有问题。')
            }
            /* 取景说明：排掉的环境物仍在画面里，只是不决定缩放。
             * 必须说出来，否则模型看到「环境球只在角落」会以为环境没做。 */
            if (framing && framing.mode !== 'all') {
              const names = framing.excluded.slice(0, 6).join('、')
                + (framing.excluded.length > 6 ? ' 等 ' + framing.excluded.length + ' 个' : '')
              lines.push('   ⓘ 取景只框主体（' + framing.reason + '）：已排除 ' + names
                + '。它们**仍在画面里**，只是不参与缩放——否则这几千单位外的环境物会把主体压成一点。')
            }
          }

          /* 正背面比对：查「只做正面、背面糊弄」这个最常见的偷懒 */
          const fb = await compareFrontBackViews(attached)
          if (fb) {
            lines.push('   正背面对比：正面实体占 ' + (fb.frontRatio * 100).toFixed(1) + '%，'
              + '背面占 ' + (fb.backRatio * 100).toFixed(1)
              + (fb.ratio === null ? '，无法比较' : '，比值 ' + fb.ratio.toFixed(2)))
            if (fb.ratio !== null && (fb.ratio < 0.6 || fb.ratio > 1.67)) {
              lines.push('   ⚠ 背面和正面差得比较多。除非这个部件本来就该正反不同，'
                + '否则默认应该做成一样（见下方规则）。')
            } else if (fb.ratio !== null) {
              lines.push('   ✓ 背面与正面接近，没有明显的「只做一面」问题。')
            }
          }

          lines.push('④ 剪影验收：')
          if (!sil) {
            lines.push('   这次没给参考图，跳过逐像素比对。若任务本来有参考图，请传 reference_image 再跑一次。')
          } else if (sil.skipped) {
            lines.push('   ' + sil.why + '。')
          } else if (!sil.ok) {
            lines.push('   ✗ ' + sil.why)
          } else {
            lines.push('   轮廓重合 ' + sil.iouPercent + '（门槛 ' + (passIoU * 100) + '%）'
              + ' · 模型实体占画面 ' + (sil.silhouetteRatio * 100).toFixed(1) + '%'
              + ' · 参考图实体占 ' + (sil.referenceRatio * 100).toFixed(1) + '%')
            lines.push('   ' + (sil.pass ? '✓ ' : '✗ ') + sil.verdict)
            if (!sil.pass) {
              lines.push('   → 轮廓指标低于参考值；结合视角、透视、裁切和任务要求判断是否需要回修，不单独作为签收门槛。')
            }
          }

          /* 跳过的检查不算失败：范围里只有一个 mesh 时，孤立检测本来就没有意义。
           * 重复视角只是提示不是错误：薄板从两个方向看本来就可能是同一张图。
           *
           * **验收项**：
           *   - 组间穿模：一定失败（两个物品不能占同一空间）
           *   - 组内**穿出/互穿/重合**：失败（另一面可见突破口，或重复建模）
           *   - 组内**插入**：不算失败（腿插进桌面这类插接本来就该重叠）
           *   - 逐 mesh 诊断：按报告阈值检查
           *   - 精度离群与剪影：建议，不能单独阻止签收 */
          /* 分组可靠性：必须是真实 Collection 分组，不能靠前缀推断。
           * 只在「有多个物品」时才要求——单个物品无组可建。 */
          const ungroupedMeshes = allGroups.find((g) => g.by === 'ungrouped')
          const ungroupedCount = ungroupedMeshes ? ungroupedMeshes.parts.length : 0
          const groupedBy = (allGroups[0] && allGroups[0].by) || 'none'
          const groupReliable = groupedBy === 'collection'
          /* 多个 mesh 时要求：分组可靠 且 没有散件 */
          const needGrouping = allMeshes.length > 1 && (resolvedKind === 'live' || resolvedKind === 'blender')
          const groupingOk = !needGrouping || (groupReliable && ungroupedCount === 0)

          /* 在 pass 之前把分组状态报出来——这是模型必须知道的 */
          if (needGrouping) {
            lines.push('')
            if (groupReliable) {
              lines.push('①a 物品分组：' + allGroups.filter((g) => g.by !== 'ungrouped').length
                + ' 个组 ✓（Blender Collection）')
            } else {
              lines.push('①a 物品分组：⛔ **没有用 Collection 分组**（当前依据：' + groupedBy + '）')
              lines.push('   → 一个完整物品必须是一个 Collection。'
                + '命名前缀只是推断，命名一变就分错。')
              lines.push('   可在 bpy 脚本里创建 Collection 并链接对象；若宿主提供分组工具，也可使用。')
            }
            if (ungroupedCount > 0) {
              lines.push('   散件：⛔ ' + ungroupedCount + ' 个 mesh 没归入任何物品组（'
                + (ungroupedMeshes.parts.slice(0, 8).join('、')) + '）')
              lines.push('   → 要么它们属于某个物品但漏分组，要么该单独成组。')
            }
          } else if (allMeshes.length > 1 && !groupReliable) {
            lines.push('①a 当前源不提供 Blender Collection，使用 ' + groupedBy
              + ' 推断组辅助检查；不要求在该源创建 Collection，推断结果不能冒充真实物品分组。')
          }

          /* ── 孤立件的「确认合理」豁免 ──
           *
           * 为什么需要：孤立检测只能证明「它和谁都不挨着」，
           * 不能证明「它不该挨着」。现实里大量部件本来就独立——
           * 悬挂的灯、飞在空中的东西、远处的背景。
           *
           * 没有豁免机制时，这类部件会让「孤立 0 个」永远达不到，
           * 于是门禁永远过不去。模型被卡住之后只能绕门禁（实测发生过），
           * 那是更糟的结果。
           *
           * 用法：模型用 acknowledge_isolated 传一个列表，写明每个为什么合理。
           * 每个条目必须有非空理由，否则不生效——
           * 防止它图省事把真问题也「确认掉」。
           */
          const ackMap = normalizeIsolationAcknowledgements(args.acknowledge_isolated)
          /* 未被确认的孤立件 = 真正卡门禁的那些 */
          const unackedIso = isoChecked
            ? iso.hits.filter((h) => !ackMap.has(String(h.part)))
            : []
          const ackedCount = isoChecked ? (iso.hits.length - unackedIso.length) : 0

          const rawPassed = inspectionComplete
            && focusLs.crossCount === 0
            && (focusLs.internalPokeCount || 0) === 0
            && (!isoChecked || unackedIso.length === 0)
            && each.problems.length === 0
            && groupingOk
          const issues = evidenceLedger.assess(revision,
            inspectionIssues(inter.hits, isoChecked ? unackedIso : [], each.problems, allGroups), args.issue_decisions)
          const passed = inspectionComplete && groupingOk && issues.unresolved === 0
          lines.push('')
          lines.push('疑点账本：' + issues.unresolved + ' 项待核实，' + issues.accepted.length + ' 项有明确处置声明；几何版本 ' + revision)
          for (const issue of issues.items.slice(0, 6)) lines.push('  [' + issue.id + '] ' + issue.parts.join(' ↔ ') + '：' + issue.observation)
          for (const warning of issues.rejected) lines.push('  未采纳声明：' + warning)
          lines.push('  ' + issues.next)
          if (issues.accepted.length) lines.push('  处置声明来自模型，原始命中仍保留；声明不等于测量证明。')

          /* 被确认掉的孤立件要在报告里列出来，不能悄悄吞掉 */
          if (ackedCount > 0) {
            lines.push('')
            lines.push('已确认合理的孤立件 ' + ackedCount + ' 个（不计入门禁）：')
            for (const [part, reason] of ackMap) {
              if (!iso.hits.some((h) => String(h.part) === part)) continue
              lines.push('  · 「' + part + '」—— ' + reason)
            }
          }

          /* ⑤ 闭环判定 */
          const verdict = args.verdict === 'done' || args.verdict === 'continue'
            ? args.verdict
            : (args.deliver ? 'done' : 'continue')
          const stopReason = String(args.stop_reason || '').trim()
          const silhouetteOk = sil && sil.ok ? sil.pass : null

          /* 记录参考图分析状态，用于提醒和结果说明；它不是 done 的硬门槛。 */
          const refState = (typeof getRefState === 'function' ? getRefState() : null) || {}
          const referenceGiven = refState.given === true || !!refPath
          const referenceAnalyzed = refState.analyzed === true

          /* ── 检测智能体的结论：最新复核必须有效回传 ──
           *
           * 拿到待办后不能靠一次无关的场景改动解锁；
           * 未回传或无法解析的复核结果也不能充当签收依据。 */
          const rs = typeof getReviewState === 'function' ? getReviewState() : null
          const pendingActions = (rs && rs.pendingActions) || []
          const editsAfterReview = (rs && rs.editsAfterReview) || 0
          const promptCount = Number(rs && rs.reviewPromptCount) || (rs && rs.lastPromptAt ? 1 : 0)
          const resultPromptCount = Number(rs && rs.reviewResultPromptCount)
            || (rs && rs.receivedAt && !rs.lastPromptAt ? 1 : 0)
          const reviewResultPending = !!(rs && promptCount > resultPromptCount)
          const reviewResultInvalid = !!(rs && rs.receivedAt && rs.resultValid === false
            && !reviewResultPending)
          const reviewAttempted = !!(rs && (promptCount > 0 || rs.receivedAt > 0 || rs.subagentCount > 0))
          const reviewSatisfied = !reviewAttempted || (!reviewResultPending
            && !reviewResultInvalid && pendingActions.length === 0)
          const latestReviewTask = rs && rs.latestTask
          const reviewTechnicalOverride = !!(rs && rs.resultTechnicalOverride === true
            && rs.resultValid === true
            && rs.resultMode === 'structure'
            && rs.resultScope === 'scene'
            && rs.resultCoverageComplete === true
            && rs.resultVisualComplete === true
            && rs.resultProvenanceComplete === true
            && rs.resultTaskId
            && latestReviewTask && latestReviewTask.taskId === rs.resultTaskId
            && editsAfterReview === 0)
          /* 复核待办对所有模式都生效；只有最新、完整、全场景的结构复核
           * 才能替代穿模/孤立命中的技术兜底。局部或材质复核不覆盖全场景。 */
          const reviewUsed = reviewAttempted

          if (reviewResultPending) {
            lines.push('')
            lines.push('⛔ **最新一轮视觉复核还没有有效回传结果。**按本轮选定的自查或独立复核方式完成看图，用 `model_review({ apply_result: ... })` 回传。')
          } else if (reviewResultInvalid) {
            lines.push('')
            lines.push('⛔ **最新视觉复核结果无法解析为有效清单。**按任务格式补全三问和「必须修的」清单后重新回传。')
          } else if (rs && rs.receivedAt && pendingActions.length > 0 && editsAfterReview === 0) {
            lines.push('')
            lines.push('⛔ **视觉复核留下 ' + pendingActions.length + ' 条修改，尚未记录后续改动。**')
            for (const a of pendingActions.slice(0, 6)) lines.push('   · ' + a)
            lines.push('   → 先照着改，改了再回来检查。')
          }

          /* ── 材质阶段：逐组检测的进度提示 ──
           *
           * 这里**只提示，不阻断**。为什么：
           *   踩过一个坑——门禁太硬时，模型会为了让门禁过去而做错误的决定
           *   （比如把 8 个组合并成 1 个来消除组间穿模，代价是逐物品检查作废）。
           *
           *   材质检测是**质量问题**，不是「过不了就不许做」的硬门槛。
           *   所以这里告诉它「哪些组还没检测」，让它自己决定先做哪个。
           *   硬拦住它，它只会想别的办法绕过去。 */
          const matState = typeof getMaterialState === 'function' ? getMaterialState() : null
          if (matState && matState.editCount > 0) {
            const touched = Object.keys(matState.touchedGroups || {})
            const unreviewed = touched.filter((g) => !matState.touchedGroups[g].reviewed)
            if (unreviewed.length) {
              lines.push('')
              lines.push('ⓘ **材质阶段进度**：' + touched.length + ' 个组上过材质，'
                + '其中 ' + unreviewed.length + ' 个尚未完成材质复核。')
              for (const g of unreviewed.slice(0, 6)) {
                lines.push('   · 「' + g + '」——上完材质后还没检测')
              }
              if (unreviewed.length > 6) lines.push('   …还有 ' + (unreviewed.length - 6) + ' 个')
              lines.push('   → 按材质批次复核，可聚焦重点组；禁用子代理时传 reviewer: \'self\'：'
                + '`model_review({ target: \'组名\', mode: \'material\', style: \'画风\' })`')
              lines.push('   **不是硬门槛，但没看过的组等于没验收。**')
            } else if (touched.length) {
              lines.push('')
              lines.push('✓ 材质阶段：' + touched.length + ' 个组都检测过了')
            }
          }

          /* 结构调研状态：这个任务要求查几次、实际查了几次 */
          const research = typeof getResearchState === 'function'
            ? getResearchState()
            : { required: 0, calls: 0, effectiveCount: 0, emptyCount: 0, satisfied: true, missing: 0, subject: null }

          const gate = tracker.canStop(loopTarget, {
            clean: passed,
            inspectionComplete,
            inspectionSkipped: interAll.skipped || 0,
            inspectionDetails,
            silhouetteOk,
            detailNotes: args.detail_notes,
            remaining: args.remaining,
            referenceGiven,
            referenceAnalyzed,
            /* 分组状态也参与停止判定：分组不可靠的话，
             * 前面所有「按组检查」的结论都站不住。 */
            groupingNeeded: needGrouping,
            groupingOk,
            groupedBy,
            ungroupedCount,
            /* 检测清单必须落实 */
            reviewPending: pendingActions.length,
            reviewEdits: editsAfterReview,
            reviewSatisfied,
            reviewResultPending,
            reviewResultInvalid,
            /* 有没有派过视觉检测员——决定门禁用三问判据还是技术检测兜底 */
            reviewUsed,
            /* 完整整场景视觉复核可以覆盖技术检测的合理命中；
             * 疑点账本仍保留在报告中，逐项声明也照常记录。 */
            reviewTechnicalOverride,
            /* 结构调研：**看「有效次数」（拿到正文的），不看总调用次数**。
             * 只数次数的话，模型调 3 次拿空结果就能过门禁——
             * 那比不调更糟，因为它以为自己查过了。 */
            researchRequired: research.required,
            researchCalls: research.effectiveCount,
            researchRawCalls: research.calls,
            researchEmpty: research.emptyCount,
            researchSubject: research.subject,
          })

          /* ── 逐组汇总（方案 B）──
           *
           * 放在结论之前：模型先看到「哪个组有问题」，再看总判定。
           * 整场景的「穿模 60 对」看不出该修哪栋楼，
           * 「主塔：组内穿出 3 对」才直接可执行。 */
          if (groupDigest) {
            lines.push('')
            lines.push('═══ 逐组检查（自动做的，不用再逐组调）═══')
            lines.push('  ' + groupDigest.total + ' 个物品组：'
              + groupDigest.cleanGroups + ' 个未命中优先处理项，'
              + groupDigest.dirtyGroups + ' 个有待核实的优先项')
            lines.push('  这是按穿出和未接触候选排序的摘要，不等于整体验收通过；'
              + '其余跨组相交、网格诊断、覆盖与复核状态仍见最终结论。')
            if (groupDigest.dirtyGroups > 0) {
              lines.push('  **按问题多少排序，先修最上面的：**')
            }
            for (const r of groupDigest.groups) {
              const bits = []
              if (r.parts) bits.push(r.parts + ' 件')
              if (r.internal) bits.push('组内穿模 ' + r.internal + ' 对')
              if (r.internalPoke) bits.push('**组内穿出 ' + r.internalPoke + ' 对**')
              if (r.cross) bits.push('跨组 ' + r.cross + ' 对')
              if (r.crossSevere) bits.push('**跨组严重 ' + r.crossSevere + ' 对**')
              if (r.isolated.length) {
                bits.push('孤立 ' + r.isolated.length + ' 个（'
                  + r.isolated.slice(0, 3).join('、')
                  + (r.isolated.length > 3 ? ' 等' : '') + '）')
              }
              const mark = r.ok ? '·' : '⛔'
              lines.push('  ' + mark + ' 「' + r.name + '」 ' + (bits.join(' · ') || '无问题'))
            }
            if (groupDigest.dirtyGroups > 0) {
              const first = groupDigest.groups.find((r) => !r.ok)
              if (first) {
                lines.push('')
                lines.push('  **建议现在修「' + first.name + '」**（' + first.issueCount + ' 处问题）')
              }
            }
          }

          /* 文案要把两个概念分清：
           *   · 技术检测（pass）—— 几何自洽性，是参考信息
           *   · 能否收工（canStop）—— 由覆盖、复核状态、分组和回退技术检查决定
           * 不说清的话，模型看到「未通过」却可以收工，会以为工具坏了。 */
          lines.push('技术检测：' + (!inspectionComplete
            ? '覆盖不完整 ⛔（' + inspectionDetails.join('；') + '）'
            : passed
              ? '本轮检查通过 ✓（穿模、孤立、逐 mesh 诊断和适用的分组要求；精度离群仅供参考）'
              : '有命中项（下面列了具体位置）——这只是几何层面的参考'))
          lines.push('  能否收工还要看完整性、分组和复核待办；有复核待办时，修完后再复核确认。')
          if (referenceGiven && !referenceAnalyzed) {
            lines.push('⚠ 用户给了参考图，尚未提取颜色/区域数据；任务需要精确对照时可调 model_reference_image。这不是签收阻断项。')
          }
          lines.push('迭代：第 ' + roundInfo.round + ' 轮'
            + (roundInfo.landedStreak ? ' · 连续落实 ' + roundInfo.landedStreak + ' 轮' : ''))
          if (roundInfo.note) lines.push('⚠ ' + roundInfo.note)
          if (roundInfo.pending) lines.push('上一轮你承诺的改进项：「' + roundInfo.pending + '」')

          /* 判断模型这一轮的表态 */
          if (verdict === 'continue') {
            const next = args.next_improvement ? String(args.next_improvement).trim() : ''
            if (!next) {
              lines.push('⚠ verdict=continue 但没写 next_improvement。下一轮必须写清具体改什么，否则无法判断是否落实。')
            }
            lines.push('你的判断：还能更好')
            if (next) lines.push('下一轮要改：「' + next + '」')
            lines.push('→ 现在就去改，改完再次调用 model_loop。')
            lines.push('  下一轮调用时如果已经落实了上面这项，传 landed_previous: true。')
          } else {
            const reason = stopReason
            if (!reason) {
              lines.push('⚠ verdict=done 但没写 stop_reason。请说明目标完成情况、停止依据和剩余限制。')
            }
            if (gate.allowed && reason) {
              lines.push('你的判断：当前范围达到任务目标 ✓ 可以结束本轮检查')
              lines.push('停止理由：' + reason)
              lines.push('满足的停止条件：' + gate.reasons.join('；'))
            } else {
              lines.push('你的判断：申请签收 —— ✗ **当前条件尚未满足**')
              if (gate.blockers.length) {
                lines.push('还差：')
                for (const b of gate.blockers) lines.push('  · ' + b)
              }
              if (!reason) lines.push('  · 没有写 stop_reason')
              lines.push('→ 继续迭代。下一轮要么改到满足条件，要么重新评估你的判断。')
            }
          }

          tracker.record(loopTarget, {
            verdict,
            nextImprovement: args.next_improvement,
            stopReason,
          })
          const stopped = verdict === 'done' && gate.allowed && !!stopReason
          const handoffLimitations = String(args.handoff_limitations || '').trim()
          const provisional = !scopeIds && verdict === 'done' && !stopped && !!stopReason
            && handoffLimitations.length > 0 && !/^(无|没有|正常|全部正常|没问题|ok|none)$/i.test(handoffLimitations)
          if (provisional) lines.push('阶段成果可暂存交付，验收未通过。必须随交付列出：' + handoffLimitations
            + '；当前阻断：' + gate.blockers.join('；') + '。不得宣称全部合格。')

          const sceneDetail = buildSceneDetailGuidance({
            target: scopeIds ? (target || scopeLabel) : 'scene',
            designIntent: workMemory?.design(),
            groups: allGroups,
            groupDigest,
            meshCount: allMeshes.length,
            round: roundInfo.round,
            stopped,
            modelingComplete: phase().modelingComplete,
          })
          const detailGuidance = buildDetailGuidance({
            target: scopeIds ? (target || scopeLabel) : 'scene',
            geometryRevision: revision,
            rawPass: rawPassed,
            issues,
            deliveryStatus: stopped ? 'accepted' : provisional ? 'provisional' : 'in_progress',
            handoffLimitations: provisional ? handoffLimitations : null,
            stopped,
            modelingComplete: phase().modelingComplete,
            quickCheck,
            inspectionComplete,
            groupingOk,
            review: rs,
            visualReady: !quickCheck && finalViews.every((view) =>
              attached.some((shot) => shot.view === view && shot.attached && shot.image)),
            sceneDetail,
          })
          if (detailGuidance.lines.length) {
            lines.push('')
            lines.push(...detailGuidance.lines)
          }

          /* 局部 done 不改变全场景签收；材质与几何工具始终可交替使用。 */
          if (stopped && !scopeIds) {
            const p = phase()
            if (!p.modelingComplete && typeof markModelingComplete === 'function') {
              markModelingComplete({
                target: target || 'scene',
                round: roundInfo.round,
                detailNotes: args.detail_notes || null,
                stopReason,
                meshes: meshes.length,
                groups: groups ? groups.length : null,
                at: Date.now(),
              })
            }
            lines.push('')
            lines.push('✅ **建模阶段已完成**（第 ' + roundInfo.round + ' 轮签收）。')
            if (!detailGuidance.visualReady) lines.push('   ⚠ 本轮未附齐实际视图，仅完成技术检查，不能宣称视觉效果或导出文件已验收。')
            lines.push('   这是当前几何范围的签收，材质与几何操作始终可用，不要求先 reset 才能回修。')
            lines.push('   几何再次修改会使旧签收失效；回修后更新检查，并复查受影响的 UV、烘焙和材质。')
            lines.push('   若本任务包含材质或贴图，简单任务可直接开始；复杂的多物品/UV/烘焙工作可用 todo_write 规划。')
            lines.push('   如果任务只要求几何建模，核对实际视图、文件和用户要求后交付；缺图时只能报告技术检查结果。')
          } else if (stopped) {
            lines.push('✅ 当前范围「' + (target || scopeLabel) + '」检查结束；全场景尚未签收，其他组和全局关系仍需检查。')
          } else if (verdict === 'done' && !gate.allowed) {
            lines.push('')
            lines.push('⛔ 当前范围尚不能签收——请处理上面列出的缺口。材质工具仍可用。')
          }

          const value = {
            kind: 'loop', lines,
            target: scopeIds ? (target || scopeLabel) : 'scene',
            detailGuidance,
            sceneDetail,
            quickCheck,
            hierarchy,
            visualComplete: !quickCheck && finalViews.every((view) =>
              attached.some((shot) => shot.view === view && shot.attached && shot.image)),
            meshes: meshes.length,
            dims: dims.map((d) => Number(num(d))),
            /* 逐组汇总（方案 B）：整场景检查时自动算出每组的状态。
             * 上层可以直接据此排「先修哪个组」，不用再逐组调一遍。 */
            groupDigest: groupDigest || null,
            interference: {
              hits: inter.hits.length,
              candidatePairs: interAll.candidates,
              candidatePairBudget: meshPairBudget,
              checkedPairs: interAll.checked,
              skippedPairs: interAll.skipped,
              triangleWork: interAll.triangleWork,
              triangleWorkLimit: interAll.triangleWorkLimit,
              triangleWorkPerPairLimit: interAll.triangleWorkPerPairLimit,
              triangleCandidates: interAll.triangleCandidateCount,
              triangleOverlaps: interAll.triangleOverlapCount,
              triangleSampleLimit: TRIANGLE_PAIR_LIMIT,
              incompletePairs: interAll.incompletePairs,
              incompletePairCount: interAll.trianglePairsCapped,
              complete: inspectionComplete,
              items: inter.hits.slice(0, 30),
              groundContacts: (interAll.groundContacts || []).slice(0, 30),
              groundContactCount: interAll.grounded,
              /* 分组穿模：组间是错误，组内要分插入/穿出 */
              internalCount: focusLs.internalCount,
              internalPokeCount: focusLs.internalPokeCount || 0,
              crossCount: focusLs.crossCount,
              crossPokeCount: focusLs.crossPokeCount || 0,
              crossGroup: focusLs.crossGroup.slice(0, 30),
              /* 按状态汇总，便于快速判断严重程度 */
              byState: inter.hits.reduce((acc, h) => {
                const k = h.state || 'unknown'
                acc[k] = (acc[k] || 0) + 1
                return acc
              }, {}),
            },
            /* 按组的结构化数据：每组有哪些件、内部穿模、跨组穿模、五视图是否看过 */
            groups: focusLs.perGroup.map((g) => {
              const views = perMeshImages
                .filter((im) => im.object === g.name)
                .map((im) => im.view)
              return {
                name: g.name,
                parts: g.parts,
                internalInterference: g.internal.length,
                internalPokeCount: g.internalPokeCount || 0,
                internalItems: g.internal.slice(0, 10),
                crossGroupInterference: g.cross.length,
                viewsSeen: views,
                viewsCount: views.length,
                viewsComplete: views.length >= 5,
              }
            }),
            groupCount: groups.length,
            /* 分组可靠性：这些决定「分组检查」能不能作数 */
            groupingState: {
              needed: needGrouping,
              groupedBy,
              reliable: groupReliable,
              ok: groupingOk,
              ungroupedCount,
              ungrouped: ungroupedMeshes ? ungroupedMeshes.parts : [],
            },
            isolation: { hits: iso.hits.length, items: iso.hits.slice(0, 30), checked: isoChecked,
              thresholds: { contactGap: isoAll.contactGap, gapRatio: isoAll.gapRatio, gapAbsCap: isoAll.gapAbsCap },
              complete: isoAll.complete, unknownPairs: isoAll.unknownPairs.slice(0, 30),
              unknownPairCount: isoAll.unknownPairCount, unknownPairsOmitted: Math.max(0, isoAll.unknownPairCount-30),
              work: isoAll.work, reusedPairs: isoAll.reused },
            /* 逐 mesh 隔离检查 + 精度一致性 */
            perMesh: {
              count: each.count,
              problems: each.problems.map((p) => ({
                part: p.mesh.part, id: p.mesh.id,
                degenerate: p.iso.degenerate,
                islands: p.iso.islands,
                duplicateVerts: p.iso.duplicateVerts,
                issues: p.iso.issues,
              })),
              precision: {
                median: each.median,
                outliers: each.outliers,
                tooFew: each.tooFewForConsistency,
              },
            },
            views: quickCheck ? [] : finalViews,
            duplicateViews: dupes,
            silhouette: sil,
            pass: passed,
            /* 逐 mesh 五视图的**图片本体**。
             *
             * 投影器（renderShots）从这里取图片附到输出块，所以**必须保留**。
             * 但每个元素绝不能再带 undefined —— 宿主的返回值校验遇到
             * undefined 会判定整个返回值非法（value is not lossless JSON），
             * 导致工具调用直接失败。出口的 sanitizeJson 会兜住这一层，
             * 这里只做一次显式清洗，避免依赖兜底。 */
            perMeshImages: perMeshImages.map((x) => {
              const { base64: _b, ...rest } = x
              return rest
            }),
            /* 元信息摘要：不带图片本体，供 JSON 摘要里快速查有哪些视角 */
            perMeshViews: {
              count: perMeshImages.length,
              attached: perMeshImages.filter((x) => x.attached).length,
              objects: [...new Set(perMeshImages.map((x) => x.object))],
              views: perMeshImages.map((x) => ({
                object: x.object,
                view: x.view,
                attached: !!x.attached,
              })),
            },
            /* 闭环相关 */
            round: roundInfo.round,
            verdict,
            nextImprovement: args.next_improvement || null,
            stopReason: stopReason || null,
            canStop: gate.allowed,
            stopBlockers: gate.blockers,
            stopReasons: gate.reasons,
            geometryRevision: revision,
            rawPass: rawPassed,
            issues,
            reviewTechnicalOverride,
            deliveryStatus: stopped ? 'accepted' : provisional ? 'provisional' : 'in_progress',
            handoffLimitations: provisional ? handoffLimitations : null,
            stopped,
            shots: attached,
            ms: Date.now() - t0,
          }
          if (remember) {
            remember('check', value)
            remember('screenshot', value)
            remember('loop', value)
          }
          /* 记录检查范围与覆盖；只有完整场景检查可更新最终导出前的检查状态。 */
          if (typeof noteCheck === 'function') noteCheck(passed, value)
          return value
        })
      },
    },

    /* ─────────────── 5a. 专职视觉检测（派检测智能体）─────────────── */
    {
      name: 'model_review',
      description:
        '【何时调用】建模阶段在一个逻辑里程碑后（如一组主体和主要部件完成、准备收尾），'
        + '或处理完上一份复核清单中的相关改动后再复查；普通小改不必每次都调用。'
        + '**材质阶段每上完一个物品组之后**。'
        + '接近完成时重点复核轮廓、连接与表面层次。'
        + '【何时不调用】还没有几何体时；普通建模小改、或只改名字/阈值这类不动外形和材质的操作之后。'
        + '\n【做什么】把所选范围内各物品组的五视图（材质阶段就是看材质效果）+ 相关数据打包，'
        + '生成任务文本，默认交给独立检测智能体；用户禁用子代理或预算受限时传 reviewer=self 自查。'
        + '\n【范围与成本】默认处理整场景的所有物品组，每组准备五张图和一份任务文本；大场景成本较高。'
        + '疑点集中在某组时传 target；省略 target 只用于全局里程碑。per_mesh_max 可限制本次覆盖组数，未选中的组不算本次已复核。'
        + '\n它只回答三个问题，按 mode 分两套：'
        + '\n  · mode=structure（默认，建模阶段）：结构对吗 / 现实中是这样吗 / 还能更好吗'
        + '；第三问主动检查轮廓、连接与功能结构、表面几何层次，按可见收益给出具体补建项，避免只说「多加细节」。'
        + '\n  · mode=material（材质阶段）：**这个材质是它该有的画风吗 / UV 的大小映射对吗 / '
        + '还有什么可以优化的**'
        + '\n【补充背景】target 或 scene_note 能告诉检测员物品身份和任务目标，'
        + '帮助它判断比例、结构和材料是否符合预期。'
        + '\n【拿到结果后】**按清单处理相关改动**，不要默默跳过；'
        + '确实有理由不改时要说清具体理由。完成这一批改动后再跑一次本工具复查。'
        + '\n【为什么派专职智能体】它没有「我刚做的」这个心理包袱；'
        + '而且职责被收窄到三个问题，不会跑题。',
      parameters: {
        target: { type: 'string', description: '检查范围：物品组名。传入后只为该组准备视图；省略 = 整场景并处理所有组，图片和子任务数量随组数增长。' },
        scene_note: { type: 'string', description: '告诉检测智能体任务目标、用途、目标观看距离、参考要求和预算；据此判断该补哪些结构与细节。' },
        reference_image: { type: 'string', description: '参考图路径（有就传，让它对照判断像不像）。' },
        mode: {
          type: 'string',
          description: '检测模式。structure（默认）= 建模阶段问形体；'
            + 'material = 材质阶段问「画风对不对 / UV 尺度对不对 / 还能优化什么」。',
          enum: ['structure', 'material'],
        },
        reviewer: { type: 'string', enum: ['independent', 'self'],
          description: '默认 independent：要求真实独立检测结果。用户禁用子代理、宿主不支持或预算受限时用 self：当前模型按图自查，显式标注自查且不能覆盖技术命中。生成任务时选择，回传时不能改换方式。' },
        style: {
          type: 'string',
          description: '**画风**（结构与材质模式都适用，有明确风格时传）——检测员据此选择几何细节或材质的标准，'
            + '尊重卡通、低模和简约设计，不一律要求写实细节。'
            + '例：写实 / 卡通 / 低多边形 / 像素 / 工业废土。',
        },
        per_mesh_max: { type: 'integer', description: '最多取几个组的图（0 或不传 = 全部组）。大型场景可限制本次覆盖；被省略的组仍需单独复核，不能把限量结果当成全场景视觉验收。' },
        resolution: { type: 'integer', description: '单张图边长像素（默认 420）。' },
        include_data: { type: 'boolean', description: '是否把穿模/孤立/精度数据一起给它（默认 true）。' },
        apply_result: {
          type: 'string',
          description: '**拿到检测智能体的回答后传这里**：把它的完整回答原样传进来，'
            + '本工具会解析成结构化修改清单，并渲染成「必须按这个改」的指令。',
        },
        source: { type: 'string', description: '临时改用别的建模源：live（默认）/ web / file（.obj 只读）。' },
        blend: { type: 'string', description: '临时指定「启动 Blender 时打开」的 .blend（不是读取源）。' },
      },
      /* 必须用 renderShots——它会把 images 里的 attachment 附成图片块。
       * renderReport 只输出文字，图片附不上，检测智能体就看不到图。 */
      output: { schema: ANY, render: renderShots },
      isConcurrencySafe: () => false,
      async execute(args) {
        return run(pickOverrides(args), async (src) => {
          /* ── 分支：回传检测智能体的回答 → 解析成修改清单 ──
           *
           * 这是「必须照做」的落点：主智能体拿到检测结论后调这一步，
           * 工具把它渲染成明确的行动指令并记账。
           * 不记账的话，主智能体可以「看了但没改」——那正是要避免的。 */
          if (args.apply_result) {
            /* tools/result associates each task token with a subagent id; subagent/end
             * records only a completed result with non-empty text. Require every task
             * result and its full text here to prevent concurrent runs from being mixed. */
            const rsCheck = typeof getReviewState === 'function' ? getReviewState() : null
            const task = rsCheck && rsCheck.latestTask
            const selfReview = task?.reviewer === 'self'
            const evidence = collectReviewEvidence(rsCheck, args.apply_result)
            const promptCount = Number(rsCheck && rsCheck.reviewPromptCount) || 0
            const resultPromptCount = Number(rsCheck && rsCheck.reviewResultPromptCount) || 0
            const taskIsCurrent = !promptCount || promptCount > resultPromptCount
            const selfTaskMatches = selfReview && task.tasks?.length === 1
              && String(args.apply_result).includes(task.tasks[0].token)
            const dispatchedThisRound = !!task && taskIsCurrent && (selfTaskMatches || evidence.complete)
            if (!dispatchedThisRound) {
              const msg = [
                '⛔ **本轮没有收到完整的独立检测结果，不能用 apply_result 签收。**',
                '',
                '每个复核任务都有唯一标识；必须有对应子智能体正常完成，并把它的完整回答包含在 apply_result 中。',
                '',
                '正确顺序是三步：',
                '',
                '  1. `model_review({ scene_note: \'...\' })`',
                '     → 拿到「任务文本」和每个物品组的五视图',
                '',
                '  2. `subagent({ description: \'视觉检测\', prompt: <把上面那份任务文本原样传进去> })`',
                '     → **真的派一个子智能体**，让它看图回答三个问题',
                '',
                '  3. `model_review({ apply_result: <子智能体的完整回答> })`',
                '     → 解析成修改清单，然后照着改',
                '',
                '这项校验也会拒绝失败启动、未完成任务、空结果和上一轮结果。',
                '用户禁用子代理或预算受限时，重新生成 reviewer: "self" 任务，按实际图片自查并保留任务标识回传；不能把自查冒充独立结果。',
              ].join('\n')
              throw new Error(msg)
            }

            const review = parseReviewResults(selfReview ? [args.apply_result] : evidence.outputs)
            const expectedImages = Number(rsCheck && rsCheck.lastPromptExpectedImageCount) || 0
            const actualImages = Number(rsCheck && rsCheck.lastPromptImageCount) || 0
            const visualComplete = rsCheck?.lastPromptVisualComplete === true
              || (expectedImages > 0 && actualImages >= expectedImages)
            const scope = task && task.scope === 'scene' ? 'scene' : 'group'
            const mode = task && task.mode === 'material' ? 'material' : 'structure'
            const target = scope === 'scene' ? 'scene' : (task && task.target) || null
            const coverageComplete = scope === 'scene' && task.coverageComplete === true
            const valid = review.valid && visualComplete && (selfTaskMatches || evidence.complete)
            const provenanceComplete = !selfReview && evidence.complete
            const technicalOverride = valid && !selfReview && mode === 'structure' && scope === 'scene'
              && coverageComplete && visualComplete && evidence.complete
            const directive = formatReviewDirective(review)
            const lines = [(selfReview ? '当前模型自查' : '独立检测') + '结果已收到，解析成修改清单：', '']
            if (selfReview) lines.push('这是当前模型自查，不能作为独立复核或覆盖技术命中的依据。')
            if (!visualComplete) {
              lines.push('⛔ 这次任务没有附齐五视图，不能作为视觉复核签收依据。恢复可出图的场景源，重新生成任务，再按选定方式复核。')
              lines.push('')
            }
            if (!selfReview && !evidence.complete) {
              lines.push('⛔ 子智能体结果不完整或与本轮任务不匹配，不能用于签收。需要每个任务标识对应的子智能体都正常完成，并把每份完整回答原样包含在 apply_result 中。')
              if (evidence.missing.length) lines.push('   缺少：' + evidence.missing.join('、'))
              lines.push('')
            }
            if (!review.valid) {
              lines.push('⛔ 这不是有效的复核结果，不能用于签收。请按任务格式补全三个问题和「必须修的」清单；若无需修改，也要写明依据。')
              lines.push('')
            }
            for (const l of directive.split('\n')) lines.push(l)

            if (typeof noteReviewResult === 'function') {
              noteReviewResult({
                target,
                groups: Array.isArray(task && task.groups) ? task.groups.slice() : [],
                groupActions: (selfReview
                  ? [{ groups: task.groups, text: args.apply_result }] : evidence.results || [])
                  .map(({ groups, text }) => ({ groups, actions: parseReviewResults([text]).actions })),
                taskId: task && task.taskId,
                actions: review.actions,
                parsed: review.parsed,
                valid,
                visualComplete,
                reviewer: selfReview ? 'self' : 'independent',
                provenanceComplete,
                scope,
                coverageComplete,
                technicalOverride,
                mode,
                noChangeNeeded: review.noChangeNeeded,
                conclusions: review.conclusions,
                at: Date.now(),
              })
            }

            return {
              kind: 'review',
              /* 分支标记用 branch，不用 mode —— mode 要留给「检测模式」
               * （structure / material），两者混用会让调用方读错。 */
              branch: 'apply',
              mode,
              scope,
              target,
              taskId: task && task.taskId,
              lines,
              parsed: review.parsed,
              valid,
              visualComplete,
              reviewer: selfReview ? 'self' : 'independent',
              provenanceComplete,
              coverageComplete,
              technicalOverride,
              missingTasks: selfReview ? [] : evidence.missing,
              actions: review.actions,
              actionCount: review.actions.length,
              conclusions: review.conclusions,
              noChangeNeeded: review.noChangeNeeded,
            }
          }

          const t0 = Date.now()
          const lines = []
          const reviewer = args.reviewer === 'self' ? 'self' : 'independent'
          const mode = args.mode === 'material' ? 'material' : 'structure'
          const shading = mode === 'material' ? 'rendered' : 'solid'
          const designIntent = workMemory?.design()
          const sceneNote = args.scene_note ? String(args.scene_note) : (workMemory?.brief || null)
          const { meshes: allMeshes, skipped: reviewSkipped = [] } = await src.extract({})
          if (!allMeshes.length) throw new Error('场景里没有 mesh，先建模再检测')

          /* 分组（含目标筛选） */
          const allGroups = groupMeshesIntoItems(allMeshes)
          const target = args.target && args.target !== 'scene' ? String(args.target) : null
          const picked = target
            ? allGroups.filter((g) => g.name === target)
            : allGroups
          if (target && !picked.length) {
            throw new Error('找不到物品组「' + target + '」。现有组：'
              + allGroups.map((g) => g.name).join('、'))
          }
          const useGroups = pickGroupsForViews(picked, null, args.per_mesh_max)
          const needsSceneViews = !target && designIntent?.scope !== 'single' && designIntent?.scope !== 'local'
            && (designIntent?.scope === 'scene' || allGroups.length > 1)

          lines.push('专职视觉检测 · 范围：' + (target ? '「' + target + '」' : '整场景')
            + ' · ' + useGroups.length + ' 个物品组')

          /* 渲染每个组的五视图 */
          const resolvedKind = await src.resolve().catch(() => null)
          let imgs = []
          if (resolvedKind === 'live') {
            try {
              const views = await renderFiveViewsForMany(
                useGroups.map((g) => ({ name: g.name, objects: g.ids })),
                { width: args.resolution || 420, height: args.resolution || 420,
                  maxGroups: useGroups.length, shading, mcpUrl: src.opts?.mcpUrl || config().mcpUrl },
              )
              const flat = []
              for (const r of views) {
                for (const v of r.views) {
                  if (v.warning) lines.push('   ⚠ 「' + r.object + '」' + v.view + '：' + v.warning)
                  if (v.ok && v.base64 && !v.warning) {
                    flat.push({ object: r.object, view: v.view, base64: v.base64, mimeType: v.mimeType })
                  }
                }
              }
              imgs = await attachBase64Images(hostCtx, flat, { prefix: 'review' })
              imgs = imgs.filter((x) => x.attached)
              lines.push('   已渲染 ' + imgs.length + ' 张五视图（'
                + useGroups.length + ' 组 × 5 视角）')
            } catch (e) {
              lines.push('   ⚠ 渲染失败：' + String((e && e.message) || e).slice(0, 160))
            }
          } else {
            lines.push('   ⚠ 当前不是活场景源，无法渲染五视图（检测智能体只能看数据）')
          }

          // 整体布局不能由隔离单件图证明；补整场景视图，不增加子代理数量。
          const sceneImgs = []
          if (needsSceneViews && resolvedKind === 'live') {
            /* 整场景取景必须排掉远处环境物，否则主体被压成一点、图是纯背景。
             * 实测：AURORA-9 主体 72 单位在原点，ENV_ATMO/ENV_EARTH 425+ 单位、
             * 中心在 6500 单位外 → 不排就出空图，而"整体布局"只能靠这两张图判断。 */
            const sceneFraming = pickFramingFocus(allMeshes)
            for (const view of ['top', 'iso']) {
              try {
                const shot = await renderLive({ view, shading, width: args.resolution || 640,
                  height: args.resolution || 640,
                  focus: sceneFraming.mode !== 'all' ? sceneFraming.names : undefined,
                  mcpUrl: src.opts?.mcpUrl || config().mcpUrl })
                if (shot.warning) { lines.push('   ⚠ 整场景 ' + view + '：' + shot.warning); continue }
                const attached = await attachBase64Images(hostCtx,
                  [{ ...shot, view, object: '整场景', sceneView: true }], { prefix: 'review-scene' })
                sceneImgs.push(...attached.filter(x => x.attached))
              } catch (e) { lines.push('   ⚠ 整场景 ' + view + ' 出图失败：' + String(e.message || e).slice(0, 160)) }
            }
            if (sceneFraming.mode !== 'all') {
              const names = sceneFraming.excluded.slice(0, 6).join('、')
                + (sceneFraming.excluded.length > 6 ? ' 等 ' + sceneFraming.excluded.length + ' 个' : '')
              lines.push('   ⓘ 整场景取景只框主体（' + sceneFraming.reason + '）：已排除 ' + names
                + '；它们仍在画面里，只是不参与缩放。')
            }
          }
          const sceneVisualComplete = !needsSceneViews || sceneImgs.length === 2
          if (!sceneVisualComplete) lines.push('   ⚠ 缺少整场景俯视或斜视图，不能据单件图确认整体布局。')
          if (mode === 'material') lines.push('   材质复核使用真实材质渲染；按材质意图核对色斑尺度、粗糙度、凹凸和旧化位置。灯光或采样不足时补图，不把灰模图当成材质通过。')

          const imageCountsByGroup = new Map(useGroups.map((g) => [g.name, 0]))
          for (const img of imgs) imageCountsByGroup.set(img.object, (imageCountsByGroup.get(img.object) || 0) + 1)
          const missingImageGroups = useGroups
            .filter((g) => imageCountsByGroup.get(g.name) < 5)
            .map((g) => g.name)
          const expectedImageCount = useGroups.length * 5 + (needsSceneViews ? 2 : 0)
          const visualComplete = useGroups.length > 0 && missingImageGroups.length === 0 && sceneVisualComplete
          imgs.push(...sceneImgs)
          if (!visualComplete) {
            lines.push('   ⛔ 视觉复核缺少完整五视图；缺图物品组：'
              + (missingImageGroups.length ? missingImageGroups.join('、') : needsSceneViews && !sceneVisualComplete ? '整场景视图' : '无可检查物品组')
              + '。本轮结果不会用于最终签收。')
          }

          /* 检测数据：给它「几何上发生了什么」，让它判断是否合理 */
          let dataText = ''
          let reviewHierarchy = null
          if (args.include_data !== false) {
            /* 配置要通过 config() 取——buildTools 里没有名为 cfg 的变量。
             * 之前这里直接写了 cfg.minDepth，运行时报 ReferenceError。 */
            const c = typeof config === 'function' ? config() : {}
            const pairScans = new Map()
            const inter = interferencePairs(allMeshes, {
              pairScans,
              minDepth: numOr(args.min_depth, c.minDepth ?? 0.0005),
              minRatio: numOr(args.min_ratio, c.minRatio ?? 0.005),
              maxPairs: 40,
            })
            const gi = analyzeGroupInterference(allGroups, inter.hits)
            const iso = isolatedMeshes(allMeshes, { contactGap: 1e-5, maxItems: 20, pairScans })
            reviewHierarchy = inspectHierarchy(allMeshes, allGroups, inter, iso, { extractionSkipped: reviewSkipped.length })
            const each = inspectEachMesh(allMeshes, allGroups)
            dataText = [
              '穿模：' + inter.hits.length + ' 对（组内 ' + gi.internalPokeCount + ' 对是穿出，'
                + '组间 ' + gi.crossCount + ' 对）',
              gi.crossGroup.slice(0, 6).map((c) =>
                '  组间：' + (c.aGroup || '?') + '×' + (c.bGroup || '?')
                + ' ' + c.a + '↔' + c.b + ' [' + (c.stateLabel || c.state) + ']').join('\n'),
              '孤立件：' + iso.hits.length + ' 个'
                + (iso.hits.length ? '（' + iso.hits.slice(0, 6).map((h) => h.part).join('、') + '）' : ''),
              '逐 mesh 问题：' + each.problems.length + ' 个'
                + (each.problems.length ? '（' + each.problems.slice(0, 6).map((p) => p.part).join('、') + '）' : ''),
              '精度离群：' + each.outliers.length + ' 个'
                + (each.outliers.length ? '（' + each.outliers.slice(0, 6).map((o) => o.part).join('、') + '）' : ''),
              '分组依据：' + ((allGroups[0] && allGroups[0].by) || '无'),
              ...hierarchyLines(reviewHierarchy),
            ].filter(Boolean).join('\n')
            lines.push('')
            lines.push('   检测数据（一并给检测智能体）：')
            for (const l of dataText.split('\n')) lines.push('     ' + l)
          }

          /* 组装交给检测智能体的任务。
           * mode 决定问哪三个问题：
           *   structure（默认）= 建模阶段，问形体
           *   material        = 材质阶段，问材料和 UV */
          const reviewTaskId = 'review-' + Date.now().toString(36) + '-' + (++reviewTaskSequence)
          const tokenizedPrompt = (taskPrompt, token) => taskPrompt
            + '\n\n复核任务标识（请原样保留）：' + token
          const prompt = buildReviewerPrompt({
            mode,
            reviewer,
            groups: useGroups.map((g) => ({ name: g.name, parts: g.parts, dims: g.dims })),
            target: target || '整场景',
            data: dataText,
            imageCount: imgs.length,
            reference: args.reference_image ? String(args.reference_image) : null,
            sceneNote,
            designIntent,
            /* 画风传给检测员：它按画风判断，而不是按「像不像现实」。 */
            style: args.style ? String(args.style) : null,
          })
          const qList = (mode === 'material' ? MATERIAL_REVIEW_QUESTIONS : REVIEW_QUESTIONS)

          /* ── 并行派发：一个组一个子智能体 ──
           *
           * 为什么要并行（用户明确要求）：
           *   以前是「派一个子智能体看全部组」，问题有两个：
           *     ① 它要一次性看几十张图，容易只挑几个组看就下结论
           *     ② 一个组的判断会污染另一个组（比如都按最严格的那个标准）
           *
           *   拆成「一组一个检测员」之后：
           *     ① 每个检测员只看一个组，没得偷懒
           *     ② 判断互相独立，不会串味
           *     ③ 并行跑，总耗时反而更短
           *
           * 但也带来一个新问题：**没人做全局判断**。
           * 所以如果组数 > 1，额外派一个「全局检测员」看整体协调性
           * （比例是否统一、风格是否一致、组与组之间有没有冲突）。 */
          const perGroupPrompts = []
          if (useGroups.length > 1 && !target && reviewer !== 'self') {
            /* 多组：每组一份独立任务 */
            for (const g of useGroups) {
              const gp = buildReviewerPrompt({
                mode,
                groups: [{ name: g.name, parts: g.parts, dims: g.dims }],
                target: g.name,
                data: dataText,
                imageCount: imageCountsByGroup.get(g.name) || 0,
                reference: args.reference_image ? String(args.reference_image) : null,
                designIntent,
                sceneNote: (sceneNote ? sceneNote + '。' : '')
                  + '你只负责检查「' + g.name + '」这一个组，不用管别的组。',
                style: args.style ? String(args.style) : null,
              })
              const token = reviewTaskId + '-' + (perGroupPrompts.length + 1)
              perGroupPrompts.push({ name: g.name, token, groups: [g.name], prompt: tokenizedPrompt(gp, token) })
            }
          }

          const reviewTasks = perGroupPrompts.length
            ? perGroupPrompts
            : [{
              token: reviewTaskId + '-1',
              name: target || 'scene',
              groups: useGroups.map((g) => g.name),
              prompt: tokenizedPrompt(prompt, reviewTaskId + '-1'),
            }]
          const sceneReview = needsSceneViews
            ? {
              active: true,
              imageCount: sceneImgs.length,
              visualComplete: sceneVisualComplete,
              checklist: mode === 'material' ? [
                '整体配色、材料尺度和新旧状态是否符合任务意图',
                '目标视距下是否有无依据的脏斑、过强凹凸或重复噪波',
                '灯光、曝光或采样是否足以判断材质，必要时补代表件近景',
              ] : [
                '交付范围与选定布局是否落实，是否把整座场所缩成一个主角',
                '主视觉焦点、前中后景和组间比例是否清楚',
                '地面、边界、支撑、连接和空间过渡是否合理',
                '主题环境、重复变化、密度、留白和全局风格是否统一',
              ],
            }
            : { active: false, checklist: [] }
          if (sceneReview.active) {
            lines.push('')
            lines.push('   **全局场景复核清单**：每组任务完成后，还要用整场景视图检查：')
            for (const item of sceneReview.checklist) lines.push('   · ' + item)
            lines.push(mode === 'material'
              ? '   全局缺口写清「材料/视角证据 → 材质层调整 → 改后收益」，保留符合设定的天然纹理和旧化。'
              : '   全局缺口要写成「组间/环境/视角的证据 → 具体建模动作 → 改后收益」，不要只给单件继续加零件。')
          }
          const selectedGroupNames = useGroups.map((g) => g.name)
          const allGroupNames = allGroups.map((g) => g.name)
          const coverageComplete = !target && allGroupNames.length > 0
            && allGroupNames.length === selectedGroupNames.length
            && allGroupNames.every((name) => selectedGroupNames.includes(name))
          lines.push('')
          if (reviewer === 'self') {
            lines.push('   当前模型按附图逐组自查，不调用子代理。回答三问并保留任务标识，再用 apply_result 回传。')
            lines.push('   自查只覆盖已附视图；不能冒充独立复核，不能覆盖技术检查命中。')
          } else if (perGroupPrompts.length) {
            lines.push('   **分组复核 ' + perGroupPrompts.length + ' 个任务**')
            lines.push('   每个只回答三个问题：' + qList.map((r) => r.q).join(' / '))
            lines.push('')
            lines.push('   做这三件事：')
            lines.push('   1. 按用户限制和可用并发并行或分批派发 subagent；不要求同时启动全部任务')
            lines.push('   2. 每个 subagent 只给**它那一个组**的任务文本 + 那个组的图')
            lines.push('   3. 等全部任务正常结束；失败或空回复要重派对应组')
            lines.push('   4. 调 apply_result 时原样包含每个检测员的完整回复，可在回复前标注组名；不要只交自己的摘要')
            lines.push('')
            lines.push('   **为什么一个组一个**：一个检测员看几十张图会偷懒只挑几个看；')
            lines.push('   而且一个组的判断会污染另一个组。拆开之后每个都得看完，判断也独立。')
            lines.push('')
            lines.push('   所有组看完之后，对照已附整场景俯视与斜视，确认整体布局、主次与风格；缺图或看不清时再补图。')
            lines.push('   单组检测员只看得到自己那个组，全局的事要你自己管。')
          } else {
            lines.push('   派发检测智能体（' + (mode === 'material' ? '材质检测' : '结构检测')
              + '，只回答三个问题：' + qList.map((r) => r.q).join(' / ') + '）...')
            lines.push('')
            lines.push('   做这两件事：')
            lines.push('   1. 用 subagent 派一个检测智能体，把下面的任务文本 + 上面这些图交给它')
            lines.push('   2. 等它正常完成后，把完整回答原样传给 apply_result，本工具再提取修改清单')
          }

          /* 单组或指定 target 时，给完整任务文本；多组时给每组的文本 */
          if (perGroupPrompts.length) {
            for (let gi = 0; gi < perGroupPrompts.length; gi++) {
              const gp = perGroupPrompts[gi]
              lines.push('')
              lines.push('   ═══ 第 ' + (gi + 1) + ' 个检测员的任务（组「' + gp.name + '」）═══')
              for (const l of gp.prompt.split('\n')) lines.push('   ' + l)
              lines.push('   ═══ 结束 ═══')
            }
          } else {
            lines.push('')
            lines.push('   ═══ 检测智能体的任务文本（原样交给它）═══')
            for (const l of reviewTasks[0].prompt.split('\n')) lines.push('   ' + l)
            lines.push('   ═══ 任务文本结束 ═══')
          }

          const value = {
            kind: 'review',
            lines,
            target: target || 'scene',
            groupCount: useGroups.length,
            expectedImageCount,
            visualComplete,
            groups: useGroups.map((g) => ({
              name: g.name, parts: g.parts, dims: g.dims.map((d) => Number(num(d))),
            })),
            reviewerPrompt: reviewTasks.length === 1
              ? reviewTasks[0].prompt
              : reviewTasks.map((t, i) => '## 检测任务 ' + (i + 1) + '：' + t.name + '\n' + t.prompt).join('\n\n'),
            /* 多份独立任务允许并行，实际调度服从宿主预算；不强制同时启动。 */
            parallelDispatch: reviewer !== 'self' && reviewTasks.length > 1,
            parallelRequired: false,
            dispatchPolicy: reviewer === 'self' ? 'self' : 'available_concurrency',
            perGroupPrompts,
            reviewTasks,
            sceneReview,
            questions: qList.map((r) => r.id),
            mode,
            shading,
            reviewer,
            imageCount: imgs.length,
            /* 图片本体留给投影器附到输出块——必须带 image（attachment 引用）。
             * 只放摘要（attachmentId）的话投影器拿不到图，图片就附不上。
             * 同时剔除 base64：宿主的返回值校验遇到 undefined 会拒掉整个返回值。 */
            images: imgs.map((x) => {
              const { base64: _b, ...rest } = x
              return rest
            }),
            data: dataText,
            /* 给主智能体的下一步指令：拿到检测结果后照做 */
            hierarchy: reviewHierarchy,
            directive: reviewer === 'self'
              ? '当前模型看完已附视图，按三问填写自查结果，保留任务标识并用 apply_result 回传；不调用子代理。'
              : '按并发预算完成独立复核，再用 apply_result 原样回传每份完整回答，处理具体修改清单。',
            ms: Date.now() - t0,
          }
          if (remember) remember('review', value)
          /* 记账：这一步给出了「检测任务文本」。
           * 之后的 apply_result 会核对「拿到任务文本之后有没有派 subagent」——
           * 没有派就说明回答是自己编的，拒绝。 */
          if (typeof noteReviewPrompt === 'function') noteReviewPrompt({
            taskId: reviewTaskId,
            mode,
            reviewer,
            target: target || null,
            scope: target ? 'group' : 'scene',
            coverageComplete,
            groups: selectedGroupNames,
            tasks: reviewTasks.map(({ token, groups }) => ({ token, groups })),
            imageCount: imgs.length,
            expectedImageCount,
            visualComplete,
          })
          return value
        })
      },
    },

    /* ─────────────────── 5b. 物品分组检查 ─────────────────── */
    {
      name: 'model_groups',
      description:
        '【何时调用】首次建好多物品组、批量调整 Collection，或 model_loop 报出分组异常时。'
        + '日常增删后的分组状态由 model_loop 回显；要查看完整组清单或定位散件时再单独调用。'
        + '【何时不调用】刚调过且分组没有变化，也没有异常时。'
        + '\n【为什么必须分组】一个完整物品由多个零件组成（桌子 = 桌面 + 4 条腿）。'
        + '不分组的话，检查只能全场景平铺，看不出「这个物品的各个方向做完了没」。'
        + '\n【用什么分组】**Blender 的 Collection**，不是命名前缀。'
        + '命名前缀（`桌_桌面`）只是推断，改个命名就失效；'
        + 'Collection 是 Blender 原生结构，Outliner 里看得见，不会被猜错。'
        + '\n【规则】一个完整物品 = 一个 Collection，零件本身只需命名。'
        + '\n【做什么】报告：每个物品组的名称与零件清单、'
        + '**没有分组的散件**（这些是漏分组了）、组与组之间的空间关系。'
        + '\n【怎么建组】可用 bpy 脚本创建 Collection 并链接对象；宿主有 group_create/group_split 时也可使用。',
      parameters: {
        max_groups: { type: 'integer', description: '最多列几个组（默认 20）。' },
        source: { type: 'string', description: '临时改用别的建模源：live（默认）/ web / file（.obj 只读）。' },
        blend: { type: 'string', description: '临时指定「启动 Blender 时打开」的 .blend（不是读取源）。' },
      },
      output: { schema: ANY, render: renderReport },
      isConcurrencySafe: () => true,
      async execute(args) {
        return run(pickOverrides(args), async (src) => {
          const t0 = Date.now()
          const { meshes } = await src.extract({})
          const groups = groupMeshesIntoItems(meshes)
          const groupsBy = groups[0] ? groups[0].by : 'none'

          const lines = []
          const ungrouped = groups.find((g) => g.by === 'ungrouped')
          const real = groups.filter((g) => g.by !== 'ungrouped')

          lines.push('物品分组：' + real.length + ' 个组（分组依据：' + groupsBy + '）· '
            + meshes.length + ' 个 mesh')
          lines.push('')

          if (groupsBy === 'collection') {
            lines.push('✓ 用的是 Blender Collection 分组（可靠）')
          } else if (groupsBy === 'prefix') {
            lines.push('⚠ 没有找到 Collection，退回**命名前缀推断**（不可靠）')
            lines.push('  → Blender 源可用 bpy 脚本或宿主分组工具建真实的组。'
              + '命名一旦不规范（比如 `桌面` 没有前缀），推断就会把不同的东西分到一起。')
          } else {
            lines.push('⚠ 没有任何分组信息，退回**空间邻近聚类**（最不可靠）')
            lines.push('  → 强烈建议立刻建组。')
          }
          lines.push('')

          for (const g of real.slice(0, args.max_groups || 20)) {
            lines.push('· 「' + g.name + '」' + g.parts.length + ' 件 · 尺寸 '
              + g.dims.map((d) => num(d)).join('×') + ' · ' + g.triangles + ' 面')
            lines.push('   零件：' + g.parts.join('、'))
          }
          if (real.length > (args.max_groups || 20)) {
            lines.push('…还有 ' + (real.length - (args.max_groups || 20)) + ' 个组')
          }

          if (ungrouped && ungrouped.parts.length) {
            lines.push('')
            lines.push('⛔ **有 ' + ungrouped.parts.length + ' 个 mesh 没有归入任何物品组**：')
            lines.push('   ' + ungrouped.parts.slice(0, 20).join('、'))
            if (ungrouped.parts.length > 20) lines.push('   …还有 ' + (ungrouped.parts.length - 20) + ' 个')
            lines.push('   → 这些零件要么属于某个物品但漏分组了，要么是独立物件该单独成组。')
            lines.push('   Blender 源可在 bpy 脚本里将对象链接到对应 Collection。')
          }

          const value = {
            kind: 'groups',
            groups: real.map((g) => ({
              name: g.name,
              parts: g.parts,
              partCount: g.parts.length,
              dims: g.dims.map((d) => Number(num(d))),
              triangles: g.triangles,
            })),
            groupCount: real.length,
            groupedBy: groupsBy,
            reliable: groupsBy === 'collection',
            ungrouped: ungrouped ? ungrouped.parts : [],
            ungroupedCount: ungrouped ? ungrouped.parts.length : 0,
            meshes: meshes.length,
            lines,
            ms: Date.now() - t0,
          }
          if (remember) remember('groups', value)
          return value
        })
      },
    },

    /* ─────────────────────── 6. 建模源 ─────────────────────── */
    {
      name: 'model_source',
      description:
        '【何时调用】会话开始时确认连的是哪个场景；要换场景（换 .blend、连网页桥、读导出文件）时。'
        + '【何时不调用】已经知道当前源、且不换场景时不必每次检查；单次调用想临时指定别的场景，直接在对应工具里传 blend/url/obj 参数更省事。'
        + '【做什么】查看或切换当前建模源：Blender 场景（blend）、网页建模（url 或 cdp_port）、或只读的 .obj。'
        + 'action=status 返回现在用的是哪个源、场景规模、命名完成度；action=use 切换后会持续影响当前会话后续工具调用，不改全局配置。'
        + 'action=memory 读写任务账本，不需要连接场景：开工记录目标与选定细节，每批更新已有 id，自动在上下文回显当前重点；memory_file 指向任务目录后支持重启恢复。',
      parameters: {
        action: { type: 'string', required: true, description: 'status = 看现状；use = 切换；memory = 增量更新或分页读取任务记忆。', enum: ['status', 'use', 'memory'] },
        memory_file: { type: 'string', description: '任务目录中专用账本的绝对路径。指定后持久保存；恢复会话传同一路径。已有其他格式文件会拒绝覆盖。' },
        brief: { type: 'string', description: '简短目标、画风、用途、观看距离与硬约束；调研候选不自动成为硬要求。' },
        scope: { type: 'string', enum: ['scene', 'single', 'local'], description: 'memory 时记录用户交付范围：整体场景 / 单件资产 / 局部修改。由用户目标决定，不由当前对象数推断。' },
        layout: { type: 'string', description: 'memory 时记录选定的整体布局：主要分区、主次体块、空间序列、动线和边界。保持简短，不提前锁定精确尺寸或建筑数量。' },
        material_intent: { type: 'string', description: 'memory 时记录材料、画风与维护/新旧状态、纹理方向和尺度意图；未要求污损时先做干净底材。' },
        tasks: { type: 'array', description: '增量条目，省略旧条目不会删除它；按物品和逻辑批次组织。', items: { type: 'object', additionalProperties: false, properties: {
          id: { type: 'string' }, title: { type: 'string', description: '部位、细节动作、连接对象或预期材质效果' },
          status: { type: 'string', enum: ['planned', 'active', 'implemented', 'verified', 'deferred'] },
          evidence: { type: 'string', description: '已核对的视角/测量/结果，或暂缓的具体取舍；声明不会自动授予验收。' },
        } } },
        offset: { type: 'integer', description: '分页起点，每页 40 条；不传为 0。' },
        reset_memory: { type: 'boolean', description: '仅开始新任务时清空会话内任务记忆；不删除旧账本文件。' },
        source: { type: 'string', description: 'use 时指定：live（读活场景，默认）/ web / file（.obj 只读）。', enum: ['live', 'web', 'file'] },
        blend: { type: 'string', description: 'use 时「启动 Blender 打开」的 .blend（不是读取源）。' },
        url: { type: 'string', description: 'use 时的网页桥地址 ws://host:port。' },
        cdp_port: { type: 'integer', description: 'use 时的 Chrome 调试端口。' },
        obj: { type: 'string', description: 'use 时的 .obj 路径。' },
      },
      output: { schema: ANY, render: renderReport },
      /* use 会清理适配器会话；不能与正在执行的模型检查并发。 */
      isConcurrencySafe: () => false,
      async execute(args) {
        if (args.action === 'memory') {
          if (!workMemory) throw new Error('当前宿主不支持任务记忆')
          if (args.reset_memory) workMemory.reset()
          const memory = workMemory.update(args)
          return { kind: 'memory', memory, lines: [workMemory.context(), ...memory.items.map(x => '[' + x.id + '] ' + x.status + '：' + x.title + (x.evidence ? '；依据：' + x.evidence : ''))] }
        }
        const overrides = pickOverrides(args)
        const useSource = args.action === 'use'
        const source = overrides.source || (overrides.blend ? 'blender'
          : overrides.obj ? 'file'
            : (overrides.url || overrides.cdpPort) ? 'web' : 'live')
        const selection = { ...overrides, source }
        return run(useSource ? selection : overrides, async (src) => {
          const info = await src.info()
          const desc = src.describe()
          const lines = ['建模源：' + desc + ' · ' + JSON.stringify(info)]
          if (useSource) {
            if (typeof setSourceSelection === 'function') {
              setSourceSelection(selection)
              lines.push('已切换；当前会话后续建模工具将继续使用这个源。')
            } else {
              lines.push('本次源检查成功；宿主未提供会话持久化接口。')
            }
          }

          /* ── 门禁状态：让模型能**自证**当前被什么条件卡住 ──
           *
           * 为什么放这里：踩过一个坑——参考图门禁被自己注入的文本污染后，
           * `model_loop` 一直报「用户给了参考图但没分析过」，而用户根本没给图。
           * 模型无法自证清白，只能在错误的阻断语下反复试。
           *
           * 把状态暴露出来之后，模型一眼就能看出「系统认为有参考图，
           * 但实际没有」——这是工具缺陷而不是自己的问题，可以直接报告用户。 */
          const ref = typeof getRefState === 'function' ? getRefState() : null
          const ph = typeof getPhaseState === 'function' ? getPhaseState() : null
          const ms = typeof getModelingState === 'function' ? getModelingState() : null

          const gates = {
            reference: ref ? { given: !!ref.given, analyzed: !!ref.analyzed, paths: ref.paths || [] } : null,
            phase: ph ? { modelingComplete: !!ph.modelingComplete } : null,
            modeling: ms ? {
              editCount: ms.editCount || 0,
              checkCount: ms.checkCount || 0,
              dirtySinceCheck: !!ms.dirtySinceCheck,
              lookSinceEdit: ms.lookSinceEdit || 0,
            } : null,
          }

          lines.push('')
          lines.push('门禁状态（判断你被什么条件卡住时看这里）：')
          if (gates.reference) {
            lines.push('  · 图片素材：' + (gates.reference.given ? '系统认为**有**' : '没有')
              + '；分析过？' + (gates.reference.analyzed ? '是' : '否'))
            if (gates.reference.given && !gates.reference.analyzed) {
              lines.push('    → 这会让 model_loop 报「给了图但没分析」。'
                + '如果你确定用户没给过任何图，这是**误判**，直接告诉用户，不要反复重试。')
            }
          }
          if (gates.phase) {
            lines.push('  · 建模签收：' + (gates.phase.modelingComplete ? '当前几何范围已签收；后续改动会使签收过期' : '尚未完成全场景签收'))
          }
          if (gates.modeling) {
            lines.push('  · 建模改动 ' + gates.modeling.editCount + ' 次，检查 ' + gates.modeling.checkCount + ' 次'
              + (gates.modeling.dirtySinceCheck ? '（**改完还没检查**）' : ''))
            if (gates.modeling.lookSinceEdit >= 3) {
              lines.push('    → 你已经用 look 看了 ' + gates.modeling.lookSinceEdit
                + ' 次图但没做检查，看图不等于检查。')
            }
          }

          return { kind: 'source', lines, source: desc, info, gates }
        })
      },
    },

    /* ─────────────────── 7. 参考图颜色对照 ─────────────────── */
    {
      name: 'model_reference_image',
      description:
        '【何时调用】用户提供图片且需要精确拆分颜色、区域或建模顺序时调用；简单形状可直接依据任务和图片建模。'
        + '参考图分析是辅助能力，不是 model_loop 的签收条件。'
        + '中途换了参考图要重新调；想核对某块区域颜色时也调。'
        + '【何时不调用】用户完全没给参考图时无从对照（此时用 model_reference 查结构即可）。'
        + '\n【为什么有帮助】看图只能得到「有个印象」，说不出「这块是什么颜色、占多大面积」。'
        + '这些数据可帮助定位和对照，但像素占比只代表当前图像，不能推断真实表面积或构件重要性。'
        + '\n【做什么】返回三类数据：'
        + '① **主体识别**：自动找出「要建模的东西」在哪（背景色 + 洪水填充），只分析主体区域，'
        + '不把背景算进颜色占比。背景不是纯色时会如实说明并退回整图。'
        + '② **颜色聚类**：主体主要由哪几种颜色组成、各自像素占比（按占比降序，附 HEX 值）'
        + '③ **像素网格**：按「1K 图至少 50px 一格」自动定密度（1024 图 → 20×20，'
        + '可传 cell_px 覆盖），每格给出主色与原图坐标，可以说「第 2 行第 3 格（px 100,50）是深灰」'
        + '④ **区域规划线索**：按图像占比列出颜色位置，供结构拆解时参考'
        + '\n【怎么用】结合任务先确定主要轮廓和功能结构，再用区域数据定位疑点。'
        + '对照渲染图时考虑透视、光照与遮挡；颜色或像素面积不同不能直接判定材质或比例错误。'
        + '\n【重要】返回的是颜色/区域线索，不能证明分件、尺寸或真实基础色。'
        + '标签、图案可用纹理；轮廓、厚度和开口要建几何，不能用照片平面冒充立体重建。',
      parameters: {
        path: { type: 'string', required: true, description: '参考图的本地路径（PNG）。' },
        cell_px: {
          type: 'number',
          description: '布局网格每格多少像素（默认 50，即 1K 图 20×20）。'
            + '这个网格用来定位「第几行第几列是什么色」。',
        },
        detail_px: {
          type: 'number',
          description: '细精度采样步长（默认 5）。这个精度用来做区域分割和结构推断——'
            + '能否识别螺丝或分缝取决于它在图中的像素大小，不能保证固定步长能识别所有细节。'
            + '调大可加速但会漏掉细节结构，一般不用改。',
        },
        region_tolerance: {
          type: 'number',
          description: '区域合并容差（默认 40）。调小分得更碎、调大合并得更多。',
        },
        max_cells: { type: 'integer', description: '格子数上限（默认 1600，防输出爆炸）。' },
        crop_to_subject: {
          type: 'boolean',
          description: '是否只分析主体区域（默认 true）。'
            + '传 false 则整图分析，适合背景本身就是设计一部分的情况。',
        },
        skip_subject: {
          type: 'boolean',
          description: '跳过主体识别直接整图分析（默认 false）。图上主体很明确时不必跳。',
        },
        max_colors: { type: 'integer', description: '最多聚类出几种主色（默认 12）。' },
        tolerance: {
          type: 'number',
          description: '颜色合并容差（默认 48，0~441）。调大合并得更多，调小分得更细。',
        },
      },
      output: { schema: ANY, render: renderReport },
      isConcurrencySafe: () => true,
      async execute(args) {
        const p = String(args.path || '').trim()
        if (!p) throw new Error('path 不能为空：写参考图的本地路径')
        if (!existsSync(p)) throw new Error('参考图不存在：' + p)

        const buf = await readFile(p)
        let analyzed
        try {
          analyzed = analyzeReference(buf, {
            cellPx: args.cell_px === undefined ? 50 : numOr(args.cell_px, 50),
            detailPx: args.detail_px === undefined ? 5 : numOr(args.detail_px, 5),
            regionTolerance: numOr(args.region_tolerance, 40),
            maxCells: numOr(args.max_cells, 1600),
            cropToSubject: args.crop_to_subject !== false,
            skipSubject: args.skip_subject === true,
            maxClusters: numOr(args.max_colors, 12),
            tolerance: numOr(args.tolerance, 48),
          })
        } catch (e) {
          throw new Error('解析参考图失败（需要 8 位深的非隔行 PNG）：' + String((e && e.message) || e)
            + '。可以先用其他工具把它转成标准 PNG 再试。')
        }

        const s = analyzed.subject
        const lines = []
        lines.push('参考图分析：' + analyzed.width + '×' + analyzed.height
          + ' · 主色 ' + analyzed.cluster.length + ' 种 · ' + analyzed.ms + 'ms')
        lines.push('')
        lines.push('▸ 自适应标定：这张图被诊断为 **' + analyzed.imageType + '**'
          + '（' + analyzed.imageTypeReason + '）')
        lines.push('  所有阈值都从本图统计量推出，不是套固定常数：'
          + '颜色容差 ' + analyzed.calibration.colorTolerance
          + ' · 区域容差 ' + analyzed.calibration.regionTolerance
          + ' · 背景容差 ' + analyzed.calibration.bgTolerance
          + ' · 硬边阈值 ' + analyzed.calibration.hardEdge)
        lines.push('  采样精度：细 ' + analyzed.detailSize.cellPx + 'px / 布局 '
          + analyzed.gridSize.cellPx + 'px（按短边自适应）')
        lines.push('')
        lines.push('⓪ 主体识别：')
        lines.push('   背景色 ' + s.background.hex + ' rgb(' + s.background.rgb.join(',') + ')'
          + '，占边缘像素 ' + (s.background.ratio * 100).toFixed(0) + '%')
        if (s.fallback) {
          lines.push('   ⚠ 主体识别不可靠，已退回整图分析')
          if (s.reason) lines.push('   原因：' + s.reason)
        } else {
          lines.push('   主体框 (' + s.bbox.x0 + ',' + s.bbox.y0 + ') - ('
            + s.bbox.x1 + ',' + s.bbox.y1 + ')'
            + '，占画面 ' + (s.coverage * 100).toFixed(1) + '%'
            + '，置信度 ' + s.confidence)
          lines.push('   → 只分析主体区域，背景不计入颜色占比')
        }
        lines.push('   网格：' + analyzed.gridSize.cols + '×' + analyzed.gridSize.rows
          + ' = ' + (analyzed.gridSize.cols * analyzed.gridSize.rows) + ' 格'
          + '，每格约 ' + analyzed.gridSize.cellPx + 'px'
          + '（原图长边 ' + Math.max(analyzed.width, analyzed.height)
          + '，按「1K 图至少 50px 一格」定密度）')
        lines.push('')
        lines.push('① 颜色聚类（按图像像素占比排序；建模优先级仍按主体结构和识别特征决定）：')
        for (const c of analyzed.cluster) {
          lines.push('   ' + String(c.rank).padStart(2) + '. ' + c.hex
            + '  rgb(' + c.rgb.join(',') + ')'
            + '  占比 ' + (c.ratio * 100).toFixed(1) + '%'
            + '  亮度 ' + c.luma
            + '  ' + c.kind)
        }

        lines.push('')
        lines.push('② 像素网格（' + analyzed.gridSize.cols + '×' + analyzed.gridSize.rows
          + '，每格 ' + analyzed.gridSize.cellPx + 'px，坐标为原图坐标）：')
        /* 按行输出格子的 HEX，模型可以按行列定位 */
        for (let ry = 0; ry < analyzed.grid.rows; ry++) {
          const row = analyzed.grid.cells.filter((c) => c.row === ry)
          lines.push('   第' + String(ry + 1).padStart(2) + '行：' + row.map((c) => c.hex).join(' '))
        }

        lines.push('')
        lines.push('③ 制作顺序建议（按颜色面积占比，附出现的格子位置）：')
        for (const b of analyzed.buildOrder) {
          lines.push('   ' + b.order + '. ' + b.hex + '（占 ' + (b.ratio * 100).toFixed(1) + '%）→ ' + b.hint)
          if (b.foundIn && b.foundIn.length) {
            lines.push('      出现在：' + b.foundIn.slice(0, 8).join('、')
              + (b.foundIn.length > 8 ? ' 等 ' + b.cellCount + ' 格' : ''))
          }
        }
        lines.push('')
        lines.push('④ 细精度区域分割（每 ' + analyzed.detailSize.cellPx + 'px 采样，'
          + analyzed.detailSize.cols + '×' + analyzed.detailSize.rows + ' = '
          + analyzed.detailSize.totalCells + ' 格，分出 ' + analyzed.regionCount + ' 个区域）：')
        for (const r of analyzed.regions.slice(0, 10)) {
          lines.push('   · ' + r.hex + ' 面积 ' + (r.areaRatio * 100).toFixed(1) + '%'
            + ' 边界密度 ' + r.edgeDensity
            + ' 内部方差 ' + r.avgVariance
            + ' · ' + r.kind)
        }
        if (analyzed.regionCount > 10) {
          lines.push('   …还有 ' + (analyzed.regionCount - 10) + ' 个更小的区域')
        }

        lines.push('')
        lines.push('⑤ **这些地方值得想清楚该做什么结构**（是引导，不是约束）：')
        lines.push('   「平」不等于「简单一块板」——下面这些读法帮你判断哪里该做实体结构、'
          + '哪里该做倒角、哪里其实可以用平面。自己判断，不必照做。')
        for (const h of analyzed.structureHints.slice(0, 10)) {
          lines.push('')
          lines.push('   【' + h.readsAs + '】' + h.hex)
          lines.push('     ' + h.think)
        }
        if (analyzed.structureHints.length > 10) {
          lines.push('')
          lines.push('   …还有 ' + (analyzed.structureHints.length - 10) + ' 条类似的提示')
        }

        lines.push('')
        lines.push('⑥ **候选区域规划**（' + analyzed.partCount + ' 组图像区域，实际分件需结构证据）：')
        lines.push('   按相邻与色差合并图像区域，再提供完整性、对称性和轮廓线索；'
          + '这些区域不直接对应物理零件，也不决定 mesh 数量。')

        for (const p of analyzed.parts.slice(0, 8)) {
          lines.push('')
          lines.push('   ── ' + p.partId + ' ' + p.hex
            + ' 面积 ' + (p.areaRatio * 100).toFixed(1) + '%'
            + ' 由 ' + p.regionCount + ' 个色块组成'
            + ' 包围盒填充率 ' + (p.fill * 100).toFixed(0) + '%')
          lines.push('     判定：' + p.meshVerdict)
          if (p.symmetry && p.symmetry.lr !== null) {
            lines.push('     形状对称：左右 ' + p.symmetry.lr + ' / 上下 ' + p.symmetry.tb)
          } else if (p.symmetry && p.symmetry.trivial) {
            lines.push('     形状对称：矩形，对称性无信息量')
          }
          if (p.edgeBlur) {
            lines.push('     轮廓：' + p.edgeBlur.verdict
              + '（锐利度 ' + p.edgeBlur.sharpRatio + '，边界平均色差 ' + p.edgeBlur.avgDelta + '）')
          }
          for (const q of p.questions) lines.push('     · ' + q)
        }
        if (analyzed.parts.length > 8) {
          lines.push('')
          lines.push('   …还有 ' + (analyzed.parts.length - 8) + ' 组更小的候选区域')
        }

        if (analyzed.partSplits && analyzed.partSplits.length) {
          lines.push('')
          lines.push('   候选色彩边界（需结合结构判断是否分件）：')
          for (const s of analyzed.partSplits.slice(0, 6)) {
            lines.push('     · ' + s.between[0] + ' ↔ ' + s.between[1]
              + '（共边 ' + s.sharedCells + ' 格，色差 ' + s.colorDelta + '）')
            lines.push('       ' + s.think)
          }
        }

        lines.push('')
        lines.push('⚠ 这些是颜色与区域线索，不是结构证明。标签、图案可用纹理，轮廓、厚度和开口要建几何；不能用照片平面冒充立体重建。')
        lines.push('⚠ 逐格对照需考虑光照、透视和遮挡；色差不直接等于材质错误，空白不直接等于漏做部件。')
        lines.push('⚠ **别照着像素轮廓描**。图片有压缩、抗锯齿、透视，'
          + '描出来是毛糙抖动的形状。要把每个 mesh 还原成完整、符合逻辑的几何：'
          + '直线就是直线、圆就是圆、该对称就对称、被遮挡的部分按结构推断补全。')

        const value = {
          kind: 'reference-image',
          path: p,
          width: analyzed.width,
          height: analyzed.height,
          imageType: analyzed.imageType,
          imageTypeReason: analyzed.imageTypeReason,
          calibration: analyzed.calibration,
          imageStats: analyzed.imageStats,
          subject: analyzed.subject,
          region: analyzed.region,
          regionSize: analyzed.regionSize,
          gridSize: analyzed.gridSize,
          detailSize: analyzed.detailSize,
          colors: analyzed.cluster,
          grid: analyzed.grid,
          regions: analyzed.regions,
          regionCount: analyzed.regionCount,
          structureHints: analyzed.structureHints,
          parts: analyzed.parts,
          partCount: analyzed.partCount,
          partSplits: analyzed.partSplits,
          buildOrder: analyzed.buildOrder,
          /* 明确标记「这不是贴图授权」，避免被误读 */
          textureAllowed: true,
          lines,
          ms: analyzed.ms,
        }
        if (remember) remember('referenceImage', value)
        /* 记录参考图分析，供运行时提示和剪影对照使用。 */
        if (typeof markRefAnalyzed === 'function') markRefAnalyzed(p, value)
        return value
      },
    },

    /* ─────────────────── 9. PBR 材质资源检索 ─────────────────── */
    {
      name: 'model_pbr_search',
      description:
        '【何时调用】需要现成 PBR 资源或比较材料做法时，取得免费材质库检索链接；建模和材质阶段均可调用。'
        + '【何时不调用】简单纯色、风格化平涂或已确定自制材质时不必检索。'
        + '\n【如何选择】扫描材质适合需要真实表面纹理的任务；纯色、风格化和可控程序材质可直接用脚本制作。'
        + '\n【做什么】把中文材质描述转成英文检索词，拼出各站的搜索 URL，'
        + '并列出每站的授权、分辨率、贴图通道、适合什么。'
        + '\n【拿到链接之后】① 用宿主可用的联网与文件工具取得所需资源；'
        + '② 按目标选择需要的通道；Normal 和 Roughness 可用贴图或材质常量，不强制每套资源都下载；'
        + '③ 用 bpy 脚本建立节点、设置色彩空间并连接所需通道。'
        + '\n【交付】程序材质可自行编写；只在目标格式不支持且适合烘焙时烘焙，导出后重开验证。',
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: '材质描述，中文英文都行，例如「锈蚀的钢板」「橡木地板」「磨砂铝」。',
        },
        fetch_results: {
          type: 'boolean',
          description: '是否顺便抓取第一个站的搜索结果页正文（默认 false，省上下文）。',
        },
      },
      output: { schema: ANY, render: renderReport },
      isConcurrencySafe: () => true,
      async execute(args) {
        const q = String(args.query || '').trim()
        if (!q) throw new Error('query 不能为空：写要查的材质')

        const r = buildMaterialSearch(q)

        const lines = []
        lines.push('材质检索：「' + q + '」→ 英文检索词 **' + r.englishQuery + '**')
        lines.push('')
        lines.push('按画风、目标格式和资源预算选择扫描资源或自制材质；不要求先检索才能写材质脚本。')
        lines.push('')

        const byId = Object.fromEntries(r.links.map((l) => [l.id, l]))
        r.recommendedOrder.forEach((id, i) => {
          const l = byId[id]
          if (!l) return
          lines.push((i + 1) + '. **' + l.name + '** — ' + l.license)
          lines.push('   检索：' + l.url)
          lines.push('   分辨率 ' + l.resolution)
          lines.push('   贴图通道：' + l.maps.join(' / '))
          lines.push('   适合：' + l.bestFor)
          if (l.note) lines.push('   注意：' + l.note)
          lines.push('')
        })

        lines.push('⚠ ' + r.tip)
        lines.push('')
        lines.push('用 bpy 脚本接材质节点：基础色按颜色数据处理，粗糙度/金属度/法线使用 Non-Color；'
          + '法线经 Normal Map 节点接入。只接实际需要的通道，不依赖专用材质工具。')

        const value = {
          kind: 'pbr-search',
          query: q,
          englishQuery: r.englishQuery,
          links: r.links,
          recommendedOrder: r.recommendedOrder,
          tip: r.tip,
          lines,
        }
        if (remember) remember('pbrSearch', value)
        return value
      },
    },

    /* ─────────────────────── 8. 结构参考检索 ─────────────────────── */
    {
      name: 'model_reference',
      description:
        '【何时调用】结构、连接方式、活动关系或历史样式拿不准，或需要拓展功能、工艺与细节思路时，针对具体问题检索。'
        + '普通建模任务按需调用；只有用户明确要求高保真复刻真实对象或场景时，'
        + '有效的结构资料才是签收门槛。'
        + '\n列任务清单或拆部件时，可先判断关键构件是否已明确；已知的内容不必重复搜索。'
        + '\n【何时不调用】熟悉且结构明确的物件、纯风格创作，或当前目标无需核实结构时。'
        + '\n【默认探索】调研提供组成、连接、功能、相对层次和可选做法，拓展设计与细节方向；'
        + '默认定性节选会略去常见的明确尺寸、数量、比例，原文可由来源链接核实。'
        + '不要提前锁死坐标、零件数量或唯一方案；原创设想须与来源事实区分。'
        + '\n【精确例外】只有用户指定尺寸、严格复刻、制造或接口配合确需数据时传 mode: verify。'
        + '\n【做什么】联网检索这个结构问题的**文字说明和来源链接**，'
        + '返回几段摘要 + 可点开的出处。'
        + '\n【这是参考，不是模板】返回里**没有可下载的模型、没有可直接复制的坐标**。'
        + '用法边界：来源中的实例事实不自动变成当前模型的硬要求。'
        + '用户的尺寸约束和风格要求优先，原创设计可自主发展结构与细节。',
      parameters: {
        query: { type: 'string', required: true, description: '要查的结构问题，用一句话描述，例如「手枪滑套与枪管的闭锁结构怎么连接」。' },
        aspect: {
          type: 'string',
          description: '从哪个角度参考：structure（结构关系，默认）/ proportion（大致比例）/ motion（活动件如何运动避让）/ material（常见做法）。',
          enum: ['structure', 'proportion', 'motion', 'material'],
        },
        max_results: { type: 'integer', description: '最多取几条来源（默认 5，上限 10）。' },
        depth: {
          type: 'string',
          description: 'brief = 只要摘要（默认，省上下文）；deep = 额外抓取前两条来源的正文。',
          enum: ['brief', 'deep'],
        },
        mode: {
          type: 'string',
          description: 'explore（默认）：定性探索结构与细节做法，略去常见的明确尺寸、数量和比例；verify：用户要求的尺寸、严格复刻、制造或接口配合需要精确依据时使用，不补猜未知数据。',
          enum: ['explore', 'verify'],
        },
      },
      output: { schema: ANY, render: renderReport },
      isConcurrencySafe: () => true,
      async execute(args) {
        const query0 = String(args.query || '').trim()
        if (!query0) throw new Error('query 不能为空：写清你要查的是哪个局部结构')

        /* ── 首选：跑本地的检索脚本 ──
         *
         * 为什么要脚本而不是直接用 ctx.web：
         *   实测 DSH 的 web.search 返回的 snippet 经常是空的，
         *   deep 模式抓百度百科/知乎全部 403，维基百科在这个环境连不上。
         *
         *   而直接抓 Bing 的结果页是可行的（200、100KB、含结构词）。
         *   脚本还做了两件 ctx.web 做不到的事：
         *     ① **按结构词判断相关性**，跑题摘要不会被当成有用结果
         *     ② 结果差时自动加重试（加领域锚点词）
         *
         * 脚本失败才回退到 ctx.web。 */
        const scriptResult = await runResearchScript(query0, {
          deep: args.depth === 'deep',
          aspect: args.aspect || 'structure',
          mode: args.mode,
          maxResults: Math.max(1, Math.min(10, Number(args.max_results) || 5)),
        })
        if (scriptResult && scriptResult.ok) {
          if (remember) remember('reference', scriptResult)
          return scriptResult
        }

        /* ── 兜底：ctx.web ── */
        const web = hostCtx && hostCtx.get ? hostCtx.get('web') : undefined
        if (!web) {
          return {
            kind: 'reference',
            lines: ['当前环境没有联网检索服务（ctx.web 不可用），这次无法查参考。',
              '按你已有的理解做，做完用 model_loop 验收。'],
            available: false,
            sources: [],
          }
        }
        const query = query0
        const aspect = String(args.aspect || 'structure')
        const mode = researchMode(args.mode)
        const maxResults = Math.max(1, Math.min(10, Number(args.max_results) || 5))
        const fullQuery = researchQuery(query, aspect, mode)

        const t0 = Date.now()
        let res
        try {
          res = await web.search({ query: fullQuery, maxResults }, undefined)
        } catch (e) {
          return {
            kind: 'reference',
            lines: ['检索失败：' + String((e && e.message) || e),
              '这次没查到参考，按你已有的理解继续；不要把"没查到"当成"结构不存在"。'],
            available: false,
            sources: [],
          }
        }
        const sources = ((res && res.sources) || []).map((s) => ({
          title: researchText(s.title, mode) || null,
          url: s.url,
          snippet: researchText(s.snippet, mode) || null,
        }))
        const lines = []
        lines.push('结构参考（' + aspect + '）：' + query)
        lines.push(...researchGuidance(mode))
        /* 摘要来源，按可靠性排序：
         *   ① res.answer —— 搜索服务直接给的答案（最有用）
         *   ② sources[].snippet —— 每条来源的摘要，拼起来
         *   都没有 → 明确告知「只有标题链接，没有正文」，
         *     并提示模型这不算真调研，要么换词重查、要么用 deep 模式 */
        let brief = ''
        if (res && typeof res.answer === 'string' && res.answer.trim()) {
          brief = researchText(res.answer, mode).replace(/\s+/g, ' ').trim()
        }
        if (!brief) {
          const snips = sources
            .map((s) => (s && typeof s.snippet === 'string' ? s.snippet.replace(/\s+/g, ' ').trim() : ''))
            .filter((x) => x.length > 0)
          if (snips.length) brief = snips.join(' ／ ')
        }
        if (brief) {
          lines.push('摘要：' + (brief.length > 1600 ? brief.slice(0, 1600) + '…' : brief))
        } else {
          /* 这是关键：明确告诉模型「这次没拿到内容」，不要让它以为查过了 */
          lines.push('⚠ **这次没有拿到正文**（搜索只回了标题和链接，没有摘要）。')
          lines.push('   → 换更具体的结构词重查，或加大 depth 到 deep 去抓正文。')
          lines.push('   不要把这当成「已经调研过」——只有链接不算查到构件组成。')
        }
        if (sources.length === 0) {
          lines.push('没有可用的来源。换个更具体的结构词再试，或按已有理解继续。')
        } else {
          lines.push('来源 ' + sources.length + ' 条：')
          for (const s of sources) {
            lines.push('· ' + (s.title || '(无标题)') + ' — ' + s.url
              + (s.snippet ? '\n  ' + String(s.snippet).replace(/\s+/g, ' ').slice(0, 260) : ''))
          }
        }

        /* ── 正文抓取（deep 模式 + 空摘要时自动降级）──
         *
         * 为什么要多轮尝试：
         *   只抓前 2 条时，遇到反爬/超时/付费墙就完全拿不到东西。
         *   实测模型调三次全是空 snippets —— 那时它就是靠常识补的构件组成，
         *   等于没调研。
         *
         * 现在的策略：
         *   ① deep 模式，或 brief 模式但摘要为空 → 都要抓正文
         *   ② 依次尝试前 5 条来源，**拿到 2 条有实质内容的就停**
         *   ③ 单条抓取设置超时，避免卡死
         *   ④ 抓到的正文按关键词筛段落，只留结构相关的（构件名、连接方式）
         */
        const NEED_FETCH = args.depth === 'deep' || !brief
        let excerpts = []
        if (NEED_FETCH && sources.length) {
          const MAX_TRY = Math.min(5, sources.length)
          const WANT_OK = 2
          let okCount = 0
          const tried = []

          for (let si = 0; si < MAX_TRY && okCount < WANT_OK; si++) {
            const s = sources[si]
            if (!s || !s.url) continue
            tried.push(s.url)
            try {
              /* 超时保护：单条最多 12 秒，避免一个慢站拖垮整次调用 */
              const fetchOnce = web.fetch({ url: s.url }, undefined)
              const timeout = new Promise((_, rej) => {
                const to = setTimeout(() => rej(new Error('抓取超时 12s')), 12000)
                /* 不让 timer 拖住进程 */
                if (to && typeof to.unref === 'function') to.unref()
              })
              const f = await Promise.race([fetchOnce, timeout])
              if (!f || !f.body || typeof f.body.content !== 'string') {
                lines.push('（第 ' + (si + 1) + ' 条来源没有正文，换下一条）')
                continue
              }
              const text = f.body.content
                .replace(/<script[\s\S]*?<\/script>/gi, ' ')
                .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                .replace(/<[^>]+>/g, ' ')
                .replace(/&nbsp;/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
              if (text.length < 120) {
                lines.push('（第 ' + (si + 1) + ' 条来源正文太短，换下一条）')
                continue
              }
              const segs = text.split(/(?<=[。！？；])/)
              const picked = []
              for (const seg of segs) {
                if (seg.length < 12) continue
                if (!STRUCT_TERMS.test(seg)) continue
                picked.push(seg.trim())
                if (picked.length >= 8) break
              }
              const body = researchText(picked.length ? picked.join('') : text.slice(0, 700), mode)
              excerpts.push({ url: s.url, excerpt: body.slice(0, 1500) })
              okCount++
              lines.push('正文节选（' + s.url + '）：' + body.slice(0, 900) + (body.length > 900 ? '…' : ''))
            } catch (e) {
              lines.push('（第 ' + (si + 1) + ' 条来源抓取失败：' + String((e && e.message) || e).slice(0, 80) + '，换下一条）')
            }
          }

          if (okCount === 0) {
            lines.push('')
            lines.push('⚠ **' + tried.length + ' 条来源全部抓取失败**（反爬/超时/付费墙）。')
            lines.push('   → 换更通用或更学术的说法重查（例如把「太和殿斗拱」改成「中国古代木构建筑 斗拱 结构」）。')
            lines.push('   → 或者用你已经知道的常识先做，但要意识到：**这次调研没有产出**，')
            lines.push('     构件组成是你自己补的，不是查到的。')
          } else if (okCount < WANT_OK) {
            lines.push('（只拿到 ' + okCount + ' 条正文，其余来源抓取失败——内容偏少，建议换个说法再查一次）')
          }
        }

        lines.push('提醒：这是参考材料，实例不自动成为设计约束；用户要求优先，原创设计由你结合当前场景决定；'
          + '查完仍然要用 model_loop 验收你自己的结果。')

        const value = {
          kind: 'reference',
          available: true,
          query,
          aspect,
          mode,
          guidance: researchGuidance(mode),
          depth: args.depth || 'brief',
          lines,
          sources: sources.map((s) => ({ title: s.title || null, url: s.url, snippet: s.snippet || null })),
          excerpts,
          ms: Date.now() - t0,
        }
        if (remember) remember('reference', value)
        return value
      },
    },
    /* ─────────────── 删除账本：交代被删物体的去留 ─────────────── */
    {
      name: 'model_deleted',
      description:
        '【何时调用】**每次删过物体之后**（用 delete_objects 或脚本里 remove 掉的）。'
        + '尤其是「为了消除穿模而删掉某些东西」的时候。'
        + '【何时不调用】从没删过任何东西时。'
        + '\n【做什么】列出被删掉的物体，给出「该不该加回」的判断依据和复原坐标。'
        + '\n【为什么要交代】删掉东西能让穿模数字归零，但场景也空了。'
        + '这个方法不阻止你删（有时确实该删），但要求你**显式说明每一个的去留**：'
        + '\n  · 确实多余（辅助对象、做错的部件）→ 说明理由，标记 keep'
        + '\n  · 误删要加回 → 标记 restore，然后用返回的坐标放回去'
        + '\n【怎么放回去才准】返回里给三种方案：'
        + '\n  · exact —— 原位置，最理想'
        + '\n  · offset —— 原处已被别的物体占了，沿某个轴让开多少'
        + '\n  · anchored —— 贴着最近的现存物体，保证不悬空'
        + '\n**不要凭印象随便放**——用这些坐标。',
      parameters: {
        action: {
          type: 'string',
          description: 'list = 看有哪些待交代的记录（默认）；verdict = 交代一条的去留。',
          enum: ['list', 'verdict'],
        },
        id: { type: 'string', description: 'verdict 时要交代的记录 id（list 里会给出）。' },
        decision: {
          type: 'string',
          description: 'verdict 时的结论：restore = 要加回；keep = 确实多余，不加回。',
          enum: ['restore', 'keep'],
        },
        reason: { type: 'string', description: 'verdict 时的理由（要具体，不能写「不需要」三个字）。' },
        include_resolved: { type: 'boolean', description: 'list 时是否也显示已交代过的（默认 false）。' },
      },
      /* output 是 defineTool 的**必需**字段。
       * 漏了它会让 ctx.tools.register 抛错，而这个 effect 抛错会让
       * 整个 preset 激活失败——表现是模式选择里显示「加载失败」。
       * （这个坑踩过一次：新加工具时只写了 description/parameters/execute。） */
      output: { schema: ANY, render: renderReport },
      isConcurrencySafe: () => false,
      /* 签名必须是 `execute(args, ctx)` —— 和其他 12 个工具一致。
       *
       * 踩过的坑：这里原来写成 `execute: ({ args, src, config }) => ...`，
       * 那是**别的框架**的解构约定。DSH 的 defineTool 调的是
       * `execute(args, ctx)`，所以整个参数对象被当成 args 解构，
       * `a.action` 永远是 undefined、`src` 永远是 undefined ——
       * 这个工具在真实环境里**根本用不了**，只会走 list 分支且拿不到场景。
       *
       * 为什么一直没发现：它只在「有删除记录」时才真正干活，
       * 而 44 个测试里没有一个真正 execute 过它（只检查了它注册成功）。
       * 补了端到端测试才暴露。 */
      execute: (args, ctx) => run(pickOverrides(args), async (src) => {
        const a = args || {}
        const action = a.action === 'verdict' ? 'verdict' : 'list'
        const log = typeof getDeletedLog === 'function' ? getDeletedLog() : { pending: [], batches: [], resolved: [], pendingCount: 0 }
        const lines = []

        if (action === 'verdict') {
          const id = String(a.id || '').trim()
          if (!id) throw new Error('verdict 需要 id（先用 action=list 看有哪些）')
          const all = (log.pending || []).concat(
            (log.batches || []).flatMap((b) => b.items || []))
          const rec = all.find((x) => String(x.id) === id || String(x.name) === id)
          if (!rec) throw new Error('没有找到记录：' + id + '（用 action=list 看现有记录）')
          const decision = a.decision === 'restore' ? 'restore' : 'keep'
          const reason = String(a.reason || '').trim()
          if (reason.length < 4) throw new Error('理由太短——要写清「为什么该删」或「为什么误删了」')
          if (typeof noteDeleteVerdict === 'function') noteDeleteVerdict(id, decision, reason)

          lines.push('已记录：「' + (rec.part || rec.name || id) + '」→ '
            + (decision === 'restore' ? '**要加回**' : '**确实多余**'))
          lines.push('  理由：' + reason)
          if (decision === 'restore') {
            const plan = rec.plan || null
            lines.push('')
            lines.push('  复原方案（用这些坐标放回去）：')
            if (plan && plan.exact) {
              lines.push('    · 原位： location = ' + JSON.stringify(plan.exact.location))
            } else if (rec.center) {
              lines.push('    · 原位： location = ' + JSON.stringify(rec.center))
            }
            if (plan && plan.offset) lines.push('    · 若原处被占：' + plan.offset.note
              + ' → location = ' + JSON.stringify(plan.offset.location))
            if (plan && plan.anchored) lines.push('    · 贴靠：' + plan.anchored.note)
            if (rec.dims) lines.push('    · 尺寸要还原成：' + rec.dims.map((d) => num(d)).join(' × '))
            if (rec.rotation) lines.push('    · 旋转： ' + JSON.stringify(rec.rotation))
            if (rec.materials && rec.materials.length) lines.push('    · 材质：' + rec.materials.join('、'))
            if (rec.collections && rec.collections.length) lines.push('    · 归回组：' + rec.collections.join('、'))
          }
          const value = { kind: 'deleted', action, id, decision, reason, plan: rec.plan || null, lines }
          return value
        }

        /* list */
        const pending = log.pending || []
        const showResolved = a.include_resolved === true
        lines.push('删除账本：待交代 ' + pending.length + ' 条'
          + (showResolved ? '，已交代 ' + (log.resolved || []).length + ' 条' : ''))

        if (!pending.length) {
          lines.push('没有待交代的删除记录。')
          if (!showResolved) lines.push('（如果从没删过东西，这是正常的）')
        } else {
          /* 拿当前场景，用于判断「该不该加回」 */
          let surviving = []
          try {
            const { meshes } = await src.extract({})
            surviving = meshes
          } catch { /* 拿不到就只报告记录本身 */ }

          const allB = surviving.map((m) => m.bbox).filter(Boolean)
          const sceneDiag = allB.length
            ? Math.hypot(
              Math.max(...allB.map((b) => b[3])) - Math.min(...allB.map((b) => b[0])),
              Math.max(...allB.map((b) => b[4])) - Math.min(...allB.map((b) => b[1])),
              Math.max(...allB.map((b) => b[5])) - Math.min(...allB.map((b) => b[2])))
            : 0
          const groupNames = Array.from(new Set(
            surviving.map((m) => m.meta && m.meta.collection).filter(Boolean)))

          for (const rec of pending.slice(0, 12)) {
            const j = judgeDeleted(rec, surviving, { sceneDiag, groupNames })
            rec.plan = j.where
            const tag = j.verdict === 'restore' ? '★ 建议加回'
              : (j.verdict === 'review' ? '⚠ 需要你判断' : '可以不加回')
            lines.push('')
            lines.push('· 「' + (rec.part || rec.name || rec.id) + '」 ' + tag
              + (rec.dims ? '  尺寸 ' + rec.dims.map((d) => num(d)).join('×') : ''))
            for (const r of j.reasons) lines.push('    - ' + r)
            if (j.where && j.where.exact) {
              lines.push('    原位：' + JSON.stringify(j.where.exact.location)
                + (j.where.offset ? '；若被占：' + JSON.stringify(j.where.offset.location) : ''))
            }
            lines.push('    交代：model_deleted({ action: \'verdict\', id: \'' + rec.id
              + '\', decision: \'restore\' | \'keep\', reason: \'...\' })')
          }
          if (pending.length > 12) lines.push('\n…还有 ' + (pending.length - 12) + ' 条未显示')
          lines.push('')
          lines.push('**每一条都要交代。** 删掉东西不是问题，删完不回头看才是——')
          lines.push('穿模归零不代表做对了，可能是该有的东西没了。')
        }

        return {
          kind: 'deleted', action: 'list',
          pendingCount: pending.length,
          pending: pending.slice(0, 12),
          lines,
        }
      })
    },
  ].map(withSanitizedOutput)
}

/**
 * 找出尺寸明显不合理的部件。
 *
 * 判据：某个维度超过**整个场景包围盒对角线**的 10 倍。
 * 一个部件比整个场景还大一个数量级，只可能是顶点坐标溢出、缩放没应用、
 * 或单位错乱——这几种错误模型光看数字是发现不了的（它不知道 5.2e12 对
 * 一个握把贴片意味着什么），所以必须由工具点名。
 */
export function findImplausibleSizes(items, factor = 10) {
  if (!items || items.length === 0) return []
  // 用中位数而不是最大值定基准：一个坏部件会污染最大值，中位数不会被带偏
  const diags = items
    .map((it) => Math.hypot(...(it.dims || [0, 0, 0]).map((d) => Math.abs(Number(d) || 0))))
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b)
  if (diags.length === 0) return []
  const median = diags[Math.floor(diags.length / 2)]
  const limit = median * factor
  const bad = []
  for (const it of items) {
    const dims = (it.dims || []).map((d) => Math.abs(Number(d) || 0))
    const maxD = Math.max(...dims, 0)
    if (!Number.isFinite(maxD) || maxD <= 0) continue
    if (maxD > limit) {
      bad.push({
        id: it.id,
        part: it.part,
        dims: it.dims,
        why: num(maxD) + '，是中位数部件对角线 ' + num(median) + ' 的 ' + Math.round(maxD / Math.max(1e-12, median)) + ' 倍',
      })
    }
  }
  bad.sort((a, b) => Math.max(...b.dims.map(Math.abs)) - Math.max(...a.dims.map(Math.abs)))
  return bad
}

/**
 * 生成渲染任务。
 *
 * 四视图用**正交投影**（工程图的标准投影），这样量出来的尺寸是真实的，
 * 不会因为透视近大远小。剪影额外关掉材质与阴影，只留轮廓。
 */
function buildShots(views, kind, dims, target, min, max) {
  const dirs = {
    front: [0, -1, 0], back: [0, 1, 0], left: [-1, 0, 0], right: [1, 0, 0],
    top: [0, 0, 1], bottom: [0, 0, -1],
    side: [-1, 0, 0],
    front_silhouette: [0, -1, 0],
    iso_ne: [1, -1, 0.8], iso_nw: [-1, -1, 0.8], iso_se: [1, 1, 0.8], iso_sw: [-1, 1, 0.8],
  }
  const center = [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2,
  ]
  const radius = Math.max(1e-4, Math.hypot(dims[0], dims[1], dims[2]) / 2)
  // 正交尺度要盖住最长边并留 10% 余量，否则贴边的部件会被裁掉
  const orthoScale = Math.max(dims[0], dims[1], dims[2]) * 1.1 || 1

  return views.map((v) => {
    const d = dirs[v] || [1, -1, 0.8]
    const len = Math.hypot(d[0], d[1], d[2]) || 1
    const dist = radius * 2.6
    const isOrtho = ['front', 'side', 'top', 'front_silhouette', 'back', 'left', 'right', 'bottom'].includes(v)
    return {
      view: v,
      from: [center[0] + (d[0] / len) * dist, center[1] + (d[1] / len) * dist, center[2] + (d[2] / len) * dist],
      lookAt: center,
      target,
      ortho: isOrtho,
      ortho_scale: isOrtho ? orthoScale : undefined,
      silhouette: v === 'front_silhouette',
    }
  })
}

function pickOverrides(args) {
  const o = {}
  if (args.source) o.source = args.source
  if (args.blend) o.blend = args.blend
  if (args.url) o.url = args.url
  if (args.cdp_port) o.cdpPort = args.cdp_port
  if (args.obj) o.obj = args.obj
  return o
}

function numOr(v, dflt) {
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}
