/**
 * ptc-model-check — Host 半边
 *
 * 在 DSH 的 PTC 模式下给建模 Agent 补四件事：
 *   1. 命名工具     model_naming
 *   2. 穿模检测     （由 model_loop 一起给，不单独暴露工具）
 *   3. 未接触检测   model_isolation
 *   4. 关键节点视觉复核与交付视图验收 model_review / model_loop
 * 以及建模源门面 model_source（Blender / 网页建模 / .obj 只读）。
 *
 * 另外，本插件往系统提示里注入「建模检查纪律」与运行时上下文：
 * PTC 模式下工具是 SDK 绑定，模型看不到每个工具的调用时机，所以提示词要
 * 说明检查触发点与签收条件；不要用固定调用次数代替对实际建模批次的判断。
 */

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'
import { SceneSource } from './adapters/index.mjs'
import { buildTools, buildViewCheckReport } from './tools.mjs'
import { ensureBlenderStack, findMcpServerScript, isNativeToolMissing, isMcpClientDisconnected, classifyEnv } from './blender-boot.mjs'
import { detectHandwrittenBridge } from './core/bridge-guard.mjs'
import { researchRequired, resetResearchProgress } from './core/research.mjs'
import { ReviewProvenance } from './core/review-provenance.mjs'
import { mergeReviewActions } from './core/review.mjs'
import { AUTONOMOUS_DETAIL_WORKFLOW, buildDetailGuidance } from './core/detail.mjs'
import { MODELING_WORKFLOW } from './core/workflow.mjs'
import { WorkMemory } from './core/work-memory.mjs'
import { geometryRevision } from './core/inspection-evidence.mjs'
/* 结构词表：判定「搜索结果是不是在讲构件组成」的唯一来源。
 * 之前这里有一份本地副本，和 tools.mjs / scripts 里的不一致——现在统一。 */
import { STRUCT_TERMS, looksStructural, looksOffTopic, queryTerms } from './core/structure.mjs'

export const name = 'ptc-model-check'
export const inject = ['tools']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = path.resolve(HERE, '..')

/**
 * 插件版本号。改动门禁逻辑时必须往上加。
 *
 * 为什么要在上下文里显示它：
 *   改完插件后会话里还是旧行为，是因为 DSH 加载的还是旧实例——
 *   之前排查这类问题花了很多时间。显示版本号后，
 *   一看上下文就知道「这个会话到底加载了哪一版」。
 *   版本号与 package.json 的 version 保持一致。
 */
const PLUGIN_VERSION = '2.30.2'

/* ── schemastery ──
 *
 * 宿主把 schemastery 打包在 asar 里，普通 Node 的模块解析看不到它（asar 是
 * Electron 的虚拟路径），所以 `import('@deepseek-ai/schemastery')` 在插件这边
 * 一定失败。但宿主进程里**已经有**一份活的 schemastery —— dsh-tools 就在用它，
 * 每个已注册工具的定义也带着由它产出的结构。顺着这些已经加载的对象反查实例，
 * 比猜包名可靠得多。
 */
const SM_NAMES = ['@deepseek-ai/schemastery', 'schemastery']

function pickSchema(m) {
  for (const c of [m && m.default, m]) if (c && typeof c.object === 'function') return c
  return null
}

/** 从一个已加载模块的命名空间里找 schemastery 的构造函数。 */
function schemaFromNamespace(ns) {
  const direct = pickSchema(ns)
  if (direct) return direct
  if (!ns || typeof ns !== 'object') return null
  for (const k of Object.keys(ns)) {
    const hit = pickSchema(ns[k])
    if (hit) return hit
  }
  return null
}

async function resolveSchema() {
  // 1) 正常包名解析（源码 checkout / 非 asar 部署走这条）
  for (const id of SM_NAMES) {
    try {
      const hit = schemaFromNamespace(await import(/* webpackIgnore: true */ id))
      if (hit) return hit
    } catch { /* 试下一个 */ }
  }
  try {
    const req = createRequire(import.meta.url)
    for (const id of SM_NAMES) {
      try {
        const hit = schemaFromNamespace(req(id))
        if (hit) return hit
      } catch { /* 试下一个 */ }
    }
  } catch { /* ignore */ }
  // 2) 顺着宿主已加载的 dsh-tools 的解析链找（asar 内部路径）
  try {
    const req = createRequire(import.meta.url)
    const toolsPath = req.resolve('@deepseek-ai/dsh-tools')
    const toolsReq = createRequire(toolsPath)
    for (const id of SM_NAMES) {
      try {
        const hit = schemaFromNamespace(toolsReq(id))
        if (hit) return hit
      } catch { /* 试下一个 */ }
    }
  } catch { /* ignore */ }
  return null
}
const z = await resolveSchema()

/** 解析失败时给出一行可读现场：试过哪些名字、各自错在哪。 */
function resolveSchemaDiagnostic() {
  const tried = []
  try {
    const req = createRequire(import.meta.url)
    for (const id of SM_NAMES) {
      try { req.resolve(id); tried.push(id + ':可解析') } catch (e) { tried.push(id + ':' + (e && e.code || 'ERR')) }
    }
    try { req.resolve('@deepseek-ai/dsh-tools'); tried.push('dsh-tools:可解析') } catch (e) { tried.push('dsh-tools:' + (e && e.code || 'ERR')) }
  } catch (e) {
    tried.push('createRequire 失败:' + String(e && e.message || e))
  }
  return tried.join(' / ')
}

export const Config = z
  ? z.object({
      /* auto = 优先读活场景（通过 Blender MCP），连不上才退回磁盘文件。
       * 这是默认值，因为模型改的就是活场景，检查它才有意义。 */
      source: z.union(['auto', 'live', 'blender', 'web', 'file']).default('auto'),
      blend: z.string().default(''),
      obj: z.string().default(''),
      url: z.string().default(''),
      cdpPort: z.natural().default(0),
      targetMatch: z.string().default(''),
      blenderPath: z.string().default(''),
      minDepth: z.number().default(0.0005),
      minRatio: z.number().default(0.005),
      minGap: z.number().default(0.01),
      minGapRatio: z.number().default(0.02),
      maxObjects: z.natural().default(3000),
      maxTriangles: z.natural().default(2000000),
      injectContext: z.boolean().default(true),
      autoCheckBatch: z.natural().default(6),
      /* 看图即检测：look / render_preview 的结果后面追加穿模 + 孤立摘要 */
      viewCheck: z.boolean().default(true),
      viewCheckItems: z.natural().default(6),
      viewCheckTimeoutMs: z.natural().default(120000),
      /* Blender MCP 环境 */
      mcpUrl: z.string().default('http://127.0.0.1:8765/mcp'),
      mcpPort: z.natural().default(8765),
      blenderPort: z.natural().default(9876),
      mcpServerScript: z.string().default(''),
      autoBootBlender: z.boolean().default(true),
    })
  : undefined

const DEFAULTS = {
  source: 'auto', blend: '', obj: '', url: '', cdpPort: 0, targetMatch: '', blenderPath: '',
  minDepth: 0.0005, minRatio: 0.005, minGap: 0.01, minGapRatio: 0.02,
  maxObjects: 3000, maxTriangles: 2000000, injectContext: true,
  autoCheckBatch: 6, viewCheck: true, viewCheckItems: 6, viewCheckTimeoutMs: 120000,
  mcpUrl: 'http://127.0.0.1:8765/mcp', mcpPort: 8765, blenderPort: 9876,
  mcpServerScript: '', autoBootBlender: true,
}

function normalizeConfig(raw) {
  const cfg = { ...DEFAULTS }
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(DEFAULTS)) {
      if (raw[k] !== undefined && raw[k] !== null && raw[k] !== '') cfg[k] = raw[k]
    }
  }
  return cfg
}

function sourceOptions(cfg, overrides, selection, runtimeMcpUrl) {
  const endpointSource = overrides.url || overrides.cdpPort ? 'web'
    : overrides.obj ? 'file'
      : overrides.blend ? 'blender' : null
  const source = overrides.source || endpointSource || selection?.source || cfg.source
  const selected = selection?.source === source ? selection : {}
  const configMatches = cfg.source === source || cfg.source === 'auto'
  const supports = (kinds) => kinds.includes(source)

  return {
    source,
    blend: supports(['auto', 'blender'])
      ? overrides.blend || selected.blend || (configMatches ? cfg.blend : undefined) || undefined
      : undefined,
    obj: supports(['auto', 'file'])
      ? overrides.obj || selected.obj || (configMatches ? cfg.obj : undefined) || undefined
      : undefined,
    url: supports(['auto', 'web'])
      ? overrides.url || selected.url || (configMatches ? cfg.url : undefined) || undefined
      : undefined,
    cdpPort: supports(['auto', 'web'])
      ? overrides.cdpPort || selected.cdpPort || (configMatches ? cfg.cdpPort : undefined) || undefined
      : undefined,
    targetMatch: cfg.targetMatch || undefined,
    blenderPath: cfg.blenderPath || undefined,
    mcpUrl: runtimeMcpUrl || cfg.mcpUrl,
    maxObjects: cfg.maxObjects,
    maxTriangles: cfg.maxTriangles,
  }
}

/* ── 提示词文本 ── */

const MODEL_CHECK_SECTION = `${MODELING_WORKFLOW}

${AUTONOMOUS_DETAIL_WORKFLOW}`


export function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig)
  const workMemory = new WorkMemory()
  let geometryBaseline = null
  let scriptPending = false
  let automaticChecking = false
  let autoAttemptEdit = -1
  let autoCheckError = ''
  let pendingScriptSnapshot = null

  /* ── 启动探针 ──
   *
   * 为什么需要：DSH 显示「加载失败」时我们看不到任何错误信息，分不清是
   *   ① 模块根本没被加载
   *   ② 加载了但 apply 中途抛错
   *   ③ apply 成功但 preset 组装失败
   * 这个探针把「走到哪一步」写进文件，之后一看文件就知道卡在哪。
   * 写失败绝不影响主流程。
   *
   * 注意：本文件是 ESM，顶部没有 `fs` 也没有 `require`。
   * 必须自己 createRequire 一次（踩过两次：直接写 fs.xxx 会抛 ReferenceError）。 */
  const probe = (stage, extra) => {
    try {
      const nfs = createRequire(import.meta.url)('node:fs')
      nfs.appendFileSync(path.join(createRequire(import.meta.url)('node:os').tmpdir(), 'ptc-model-check-apply.log'),
        new Date().toISOString() + ' ' + stage
        + (extra ? ' ' + String(extra).slice(0, 500) : '') + '\n', 'utf8')
    } catch { /* 探针失败不能影响插件 */ }
  }
  probe('BOOT', 'pid=' + process.pid + ' v=' + PLUGIN_VERSION)

  probe('STEP1-state')
  const state = {
    source: null,
    sourceSelection: null,
    runtimeMcpUrl: null,
    check: null,
    screenshot: null,
    lastError: null,
    blenderReady: null,
    updatedAt: 0,
  }

  /* ── MCP 原生工具可用性信号 ──
   *
   * 为什么需要它：ensureBlenderStack 只能证明「MCP 服务器进程活着」，
   * 证明不了「DSH 把它注册成了 mcp__blender__* 工具」。这两件事在
   * 建模测试 27/28 里第一次分离：探测全绿、环境显示「已就绪」，
   * 但模型的工具列表里根本没有这些工具，于是它另开无头 Blender 硬做，
   * 插件的检查与看图检测全程看不见那个场景（28 一次检查都没跑）。
   *
   * 唯一的确证方式是**观察真实失败**：模型调过 mcp__blender__* 且被拒。
   * 反过来不成立——没观察到 ≠ 没注册，所以这里只由失败置位，永不推断。 */
  const nativeSignal = { nativeMissing: false, deniedCount: 0, lastCall: '', at: 0, mcpDisconnected: false, disconnectedAt: 0 }
  const getNativeSignal = () => ({ ...nativeSignal })
  const noteNativeDenied = (name) => {
    nativeSignal.nativeMissing = true
    nativeSignal.deniedCount += 1
    nativeSignal.lastCall = String(name || '').slice(0, 60)
    nativeSignal.at = Date.now()
  }
  /* 客户端断连：工具名注册了但链路是死的。
   * 与「没注册」分开记——前者要重启 DSH，后者要装 bundle，提示完全不同。 */
  const noteMcpDisconnected = (name) => {
    nativeSignal.mcpDisconnected = true
    nativeSignal.disconnectedAt = Date.now()
    if (!nativeSignal.lastCall) nativeSignal.lastCall = String(name || '').slice(0, 60)
  }

  const remember = (kind, value) => {
    state[kind] = value
    state.updatedAt = Date.now()
  }

  const sessions = new Map()
  const sourceFor = (overrides = {}) => {
    const opts = sourceOptions(cfg, overrides, state.sourceSelection, state.runtimeMcpUrl)
    const key = JSON.stringify(opts)
    let s = sessions.get(key)
    if (!s) {
      s = new SceneSource(opts, { packageDir: PACKAGE_DIR })
      sessions.set(key, s)
      state.source = s.describe()
    }
    return s
  }
  const setSourceSelection = (selection) => {
    state.sourceSelection = selection
      ? { ...selection }
      : null
    for (const s of sessions.values()) {
      try { void s.dispose() } catch { /* ignore */ }
    }
    sessions.clear()
    state.source = new SceneSource(
      sourceOptions(cfg, {}, state.sourceSelection, state.runtimeMcpUrl),
      { packageDir: PACKAGE_DIR },
    ).describe()
  }
  const setMcpUrl = (url) => {
    state.runtimeMcpUrl = url || null
    /* Keep existing sessions alive for in-flight calls; endpoint changes are
     * reflected in sourceOptions and therefore get a distinct cache entry. */
    state.source = new SceneSource(
      sourceOptions(cfg, {}, state.sourceSelection, state.runtimeMcpUrl),
      { packageDir: PACKAGE_DIR },
    ).describe()
  }

  /* 参考图分析状态：用于提醒和结果说明。
   *
   * given   —— 用户是否给过参考图
   * analyzed —— 是否已用 model_reference_image 分析过
   * paths   —— 分析过的图（换图要重新分析）
   *
   * 这些状态不构成 done 硬门槛。 */
  const refState = { given: false, analyzed: false, paths: [], analyzedAt: 0 }
  const getRefState = () => ({ ...refState })
  const markRefAnalyzed = (p, value) => {
    refState.analyzed = true
    if (p && !refState.paths.includes(p)) refState.paths.push(p)
    refState.analyzedAt = Date.now()
    refState.subjectCoverage = value && value.subject ? value.subject.coverage : null
    refState.gridSize = value && value.gridSize ? value.gridSize : null
  }

  /* ── 结构调研状态：把「调研」变成可度量、可门禁的东西 ──
   *
   * 为什么必须有这个账本（真实事故）：
   *   一个「1:1 还原哥特式大教堂」的任务，模型在清单里写了
   *   「调研：查哥特式大教堂结构」，然后第二次更新时直接标成 completed——
   *   一次 model_reference 都没调。插件完全没拦住，因为调研这一步
   *   零可验证产出。
   *
   *   规律：**Agent 会对着有度量的门禁优化，对没有度量的一律降优先级。**
   *   这是必然的，不是道德问题。所以要么给它度量，要么它永远不会做。
   *
   * 记什么：
   *   calls    —— 调了几次 model_reference
   *   queries  —— 每次查的问题（用于核对「查的是不是这件事」）
   *   required —— 明确高保真复刻任务的最少有效查询数
   *   subject  —— 识别出的「专有名词任务」（巴黎圣母院、AK-47 这类） */
  const researchState = {
    /** 总调用次数（含空结果） */
    calls: 0,
    /** **拿到正文的次数**——门禁用这个 */
    effectiveCount: 0,
    /** 拿到空结果的次数（只有标题链接） */
    emptyCount: 0,
    /** 拿到内容但**和查询无关**的次数（跑题） */
    offTopicCount: 0,
    queries: [],
    required: 0,
    subject: null,
    why: '',
    resetRequirement: null,
    lastAt: 0,
    lastGoodAt: 0,
    /** 每次调用的质量记录：{ at, query, effective, chars } */
    log: [],
  }

  /* 只有明确提出高保真复刻时才有硬门槛：至少拿到一条有效结构资料。
   * 普通场景、熟悉道具和仅提到真实对象的任务按需调研，不因关键词强制搜索。 */
  /** 记录一次 model_reference 调用 */
  /**
   * 记录一次结构调研。
   *
   * @param {string} query 查的问题
   * @param {object} result model_reference 的返回值
   *
   * **关键：只有拿到正文的调用才算「有效调研」。**
   * 只返回标题链接的空结果不计入 effectiveCount——
   * 否则空结果也会被误当成完成调研。
   */
  const noteResearch = (query, result) => {
    researchState.calls++
    researchState.lastAt = Date.now()

    /* 判断这次到底拿到了什么——**必须同时满足「有内容」和「相关内容」**。
     *
     * 为什么不能只看长度（实测翻车）：
     *   问「故宫太和殿 斗拱 结构」→ 返回「故宫建于1925年，占地72万平方米」
     *   问「哥特式教堂 飞扶壁 结构原理」→ 返回「哥特是艺术风格，恐怖超自然」
     *   两条都有 100+ 字，长度判定会认为「有效」，但那和结构毫无关系。
     *
     *   搜索引擎匹配的是「故宫」「哥特」这些大词，不是「斗拱」「飞扶壁」。
     *   如果这种跑题摘要算有效，模型就会拿到一堆废话还以为是调研成果。
     *
     * 所以加一道相关性门槛：**摘要里必须出现查询中的结构关键词**。 */
    let effective = false
    let howMuch = 0
    let collected = ''

    try {
      const v = result || {}
      /* 把这次能拿到的所有文本拼起来，用于相关性检查 */
      const parts = []
      if (typeof v.answer === 'string') parts.push(v.answer)
      if (Array.isArray(v.sources)) {
        for (const s of v.sources) {
          if (s && typeof s.snippet === 'string') parts.push(s.snippet)
          if (s && typeof s.title === 'string') parts.push(s.title)
        }
      }
      if (Array.isArray(v.excerpts)) {
        for (const e of v.excerpts) {
          if (e && typeof e.excerpt === 'string') parts.push(e.excerpt)
        }
      }
      collected = parts.join(' ').replace(/\s+/g, ' ').trim()
      howMuch = collected.length

      /* ── 内容长度门槛 ── */
      /* 长度只是防止「参见」「暂无」这类垃圾的下限。
       * 实测：一条切题摘要「斗拱由斗、拱、昂、翘等构件组成…
       * 把屋顶重量传递到柱子上」只有 57 字，但信息足够。
       * 所以门槛设 40，真正的质量靠下面的相关性判据。 */
      const longEnough = howMuch >= 40


      /* 查询里明确写了结构词时，返回必须命中同类结构词 */
      const queryHasStructWord = STRUCT_TERMS.test(String(query || ''))
      const responseHasStructWord = STRUCT_TERMS.test(collected)

      /* 也检查 query 里的具体术语（去掉泛词后）有没有出现在返回里。
       * 用来兜住「大明宫」这类不常见但具体的词。 */
      const STOP = /^(结构|原理|怎么|如何|什么|说明|介绍|组成|连接|关系|方式|做法|我要|帮我|做一个|一张)$/
      const qWords = String(query || '')
        .split(/[\s，,、。／/\\]+/)
        .map((w) => w.trim())
        .filter((w) => w.length >= 2 && !STOP.test(w))
      const specificHits = qWords.filter((w) => collected.includes(w))

      /* 判定：
       *   · 查询里有结构词 → 返回里也必须有结构词（否则是跑题）
       *   · 查询里没有结构词（很泛的问题）→ 用具体词命中兜底
       *   · 两者都过不了 → 判无效 */
      let relevant = false
      if (queryHasStructWord) {
        relevant = responseHasStructWord
      } else if (qWords.length) {
        relevant = specificHits.length > 0 || responseHasStructWord
      } else {
        relevant = responseHasStructWord
      }

      effective = longEnough && relevant
      if (effective) {
        researchState.lastRelevance = specificHits.length
      } else if (longEnough && !relevant) {
        /* 有内容但跑题——单独记，便于状态行提示 */
        researchState.offTopicCount++
      }
    } catch { /* 判定失败就当无效，宁可严一点 */ }

    if (effective) {
      researchState.effectiveCount++
      researchState.lastGoodAt = Date.now()
    } else {
      researchState.emptyCount++
    }

    if (query) {
      const q = String(query).trim().slice(0, 120)
      if (q && !researchState.queries.includes(q)) {
        researchState.queries.push(q)
        if (researchState.queries.length > 20) researchState.queries.shift()
      }
    }
    /* 记录每次的质量，供状态行展示 */
    researchState.log.push({
      at: Date.now(),
      query: String(query || '').slice(0, 80),
      effective,
      chars: howMuch,
    })
    if (researchState.log.length > 20) researchState.log.shift()
  }

  /** 识别任务规模；另存最近用户请求，供 reset 切换任务时重置门槛。 */
  const noteTaskText = (text, forReset = false) => {
    const r = researchRequired(text)
    if (forReset) researchState.resetRequirement = r
    if (r.required > researchState.required) {
      researchState.required = r.required
      researchState.subject = r.subject
      researchState.why = r.why
    }
  }

  const getResearchState = () => ({
    calls: researchState.calls,
    effectiveCount: researchState.effectiveCount,
    emptyCount: researchState.emptyCount,
    offTopicCount: researchState.offTopicCount,
    queries: researchState.queries.slice(),
    required: researchState.required,
    subject: researchState.subject,
    why: researchState.why || '',
    lastAt: researchState.lastAt,
    log: researchState.log.slice(),
    /* **门禁判据看 effectiveCount，不看 calls** */
    satisfied: researchState.effectiveCount >= researchState.required,
    missing: Math.max(0, researchState.required - researchState.effectiveCount),
  })

  const resetResearchState = () => resetResearchProgress(researchState)

  /* 建模签收是当前场景检查状态，不是材质工具的许可证。 */
  const phaseState = {
    /** 建模是否已完全结束 */
    modelingComplete: false,
    /** 什么时候、以什么理由签收的 */
    signedOffAt: 0,
    signoff: null,
  }

  const getPhaseState = () => ({ ...phaseState })

  /** 建模完成签收：由 model_loop 在 done 且 gate 通过时调用 */
  const markModelingComplete = (signoff) => {
    phaseState.modelingComplete = true
    phaseState.signedOffAt = Date.now()
    phaseState.signoff = signoff || null
  }

  /** 回到建模阶段（新任务、reset 时调用） */
  const resetPhase = (options = {}) => {
    phaseState.modelingComplete = false
    phaseState.signedOffAt = 0
    phaseState.signoff = null
    resetReviewState()
    if (options.newTask !== false) {
      resetResearchState()
      resetTodoState()
      workMemory.reset()
    }
    resetMaterialState()
  }

  /* ── 建模窗口状态：防止「只建模不检查」──
   *
   * 踩过的坑：真实会话里模型用 execute_python 写脚本建了整个场景，
   * 然后自己用 look 渲染了 15 张图「看着不错」，就宣布完成了——
   * **model_loop 一次都没调**，所以分组五视图、穿模、孤立、精度
   * 这些检查一个都没跑。
   *
   * 根因：model_loop 的分组五视图是「被调用时才生成」的。
   * 不调用就没有，而模型可以绕开它直接自己看图。
   *
   * 修法：记录下来「最后一次建模改动」和「最后一次检查」的时间。
   * 建模改动之后如果没做过检查，就拦住「收尾类」操作
   * （render_preview / export_file），
   * 并明确告诉它：先调 model_loop。
   *
   * 为什么只拦收尾类、不拦全部：
   * 建模过程中当然要反复改、反复看，那不该被拦。
   * 最终导出前检查最新几何；过程预览和存盘始终可用。 */
  const modelingState = {
    /** 最后一次建模改动（建/改/删对象）的时间 */
    lastEditAt: 0,
    /** 最后一次 model_loop 的时间 */
    lastCheckAt: 0,
    /** 最后一次 model_loop 是否通过 */
    lastCheckPassed: false,
    /** 完整全场景检查通过，或有效复核支持当前范围签收 */
    lastCheckAccepted: false,
    /** 建模改动次数（用来判断「改了但没查」） */
    editCount: 0,
    /** 检查次数 */
    checkCount: 0,
    /** 改完之后用 look 看了几次图（没走检查） */
    lookSinceEdit: 0,
    /** 最后一次建模改动用的工具 */
    lastEditTool: '',
    /** 距离上次检查调用了多少次建模工具；只作上下文提示 */
    editsSinceCheck: 0,
  }
  const getModelingState = () => ({ ...modelingState })

  /** 建模工具动了场景 → 记账 */
  const noteModelingEdit = (toolName) => {
    modelingState.provisionalExport = null
    phaseState.modelingComplete = false
    phaseState.signedOffAt = 0
    phaseState.signoff = null
    modelingState.lastEditAt = Date.now()
    modelingState.editCount++
    /* 改动之后，之前的检查结论作废 */
    modelingState.lastCheckPassed = false
    modelingState.lastCheckAccepted = false
    modelingState.dirtySinceCheck = true
    modelingState.lastEditTool = toolName
    /* Keep a coarse count for status context; scripts and one-off edits each count once. */
    modelingState.editsSinceCheck++
  }

  /** model_loop 跑过 → 记账 */
  const noteCheck = (passed, result) => {
    if (result?.target === 'scene' && result.geometryRevision) {
      geometryBaseline = result.geometryRevision
      scriptPending = false
      pendingScriptSnapshot = null
      autoCheckError = ''
    }
    modelingState.lastCheckAt = Date.now()
    modelingState.checkCount++
    /* 是否执行过检查与是否取得完整整场景覆盖是两回事。
     * 局部/超预算检查也重置「自上次检查以来」的观察计数，不放行最终导出。 */
    modelingState.lookSinceEdit = 0
    modelingState.editsSinceCheck = 0
    if (result?.target !== 'scene') return
    const fullScene = result?.interference?.complete === true
    modelingState.lastCheckPassed = fullScene && !!passed
    /* 完整视觉复核可作为技术命中的结构证据；疑点不会因此从账本消失。 */
    modelingState.lastCheckAccepted = fullScene && (!!passed || result.stopped === true
      || result.reviewTechnicalOverride === true)
    modelingState.provisionalExport = result.deliveryStatus === 'provisional'
      ? { limitations: result.handoffLimitations, blockers: result.stopBlockers || [] } : null
    if (!fullScene) return
    modelingState.dirtySinceCheck = false
    modelingState.mergeSinceCheck = false
  }

  /* ── 检测智能体的结论：记账 + 强制落实 ──
   *
   * 为什么要记账：
   *   主智能体是作品的自评人，天然倾向「我已经改过了」。
   *   把检测结论存下来，才能在它想宣布完成时核对：
   *   **检测要求的修改到底改了没？**
   *
   *   不记账的话，它可以调用 model_review 拿到清单，
   *   然后当作没看见直接进下一步——那这个专职检测就白派了。 */
  const reviewState = {
    pendingByGroup: {},
    /** 最近一次检测要求改的条目 */
    pendingActions: [],
    /** 收到检测结论的时间 */
    receivedAt: 0,
    /** 检测认为无需修改吗 */
    noChangeNeeded: false,
    /** 三个问题的结论 */
    conclusions: {},
    /** 收到结论之后，主智能体改了几次场景 */
    editsAfterReview: 0,
    /** 上次派检测智能体的时间（0 = 从没派过） */
    lastSubagentAt: 0,
    lastSubagentSuccessfulAt: 0,
    lastSubagentPromptCount: 0,
    /** 派了几次 */
    subagentCount: 0,
    /** 最近一次拿到检测任务文本的时间（用于判断「先拿任务、再派」的顺序） */
    lastPromptAt: 0,
    /** 任务文本序号与已回传结果序号，用于判断当前复核是否真正闭环 */
    reviewPromptCount: 0,
    reviewResultPromptCount: 0,
    lastPromptImageCount: 0,
    lastPromptExpectedImageCount: 0,
    lastPromptVisualComplete: false,
    resultValid: false,
    resultParsed: false,
    /** 最近一次派发的模式（structure / material） */
    lastMode: null,
    /** 最近一次的目标组名 */
    lastTarget: null,
    /**
     * 已检测过的物品组（材质阶段按组推进，要核对每组都过了）。
     * key = 组名，value = { at, mode, actionCount }
     */
    reviewedGroups: {},
    resultTaskId: null,
    resultMode: null,
    resultScope: null,
    resultCoverageComplete: false,
    resultVisualComplete: false,
    resultProvenanceComplete: false,
    resultTechnicalOverride: false,
  }
  const reviewProvenance = new ReviewProvenance()

  /**
   * 记录「派了检测智能体」。
   *
   * 为什么必须记录：`model_review({ apply_result })` 是主智能体回传检测结论的入口。
   * 但主智能体完全可以**不派子智能体**，自己编一段符合格式的回答回传——
   * 那就回到了「自己评判自己」，整个专职检测机制就白设了。
   *
   * 所以：回传结果时核对「这一轮到底派过没有」。没派过就拒绝。
   * 这是硬约束，不是提示——提示拦不住偷懒。
   */
  const noteSubagentDispatch = (prompt, subagentId) => {
    if (!reviewProvenance.register(prompt, subagentId)) return
    reviewState.lastSubagentAt = Date.now()
    reviewState.lastSubagentPromptCount = reviewState.reviewPromptCount
    reviewState.subagentCount++
  }

  const noteSubagentEnd = (subagentId, stopReason, text) => {
    if (reviewProvenance.complete(subagentId, stopReason, text)) {
      reviewState.lastSubagentSuccessfulAt = Date.now()
    }
  }

  /** 记录「拿到了检测任务文本」（model_review 非 apply 分支） */
  const noteReviewPrompt = (info) => {
    reviewState.lastPromptAt = Date.now()
    reviewState.reviewPromptCount++
    if (info) {
      reviewState.lastPromptImageCount = Number(info.imageCount) || 0
      reviewState.lastPromptExpectedImageCount = Number(info.expectedImageCount) || 0
      reviewState.lastPromptVisualComplete = info.visualComplete === true
      if (info.mode) reviewState.lastMode = info.mode
      if (info.target) reviewState.lastTarget = info.target
      reviewProvenance.begin(info)
    }
  }
  const getReviewState = () => ({
    ...reviewState,
    pendingActions: [...reviewState.pendingActions],
    pendingByGroup: Object.fromEntries(Object.entries(reviewState.pendingByGroup).map(([group, actions]) => [group, [...actions]])),
    reviewedGroups: { ...reviewState.reviewedGroups },
    latestTask: reviewProvenance.snapshot(),
  })

  const resetReviewState = () => {
    reviewState.pendingByGroup = {}
    reviewState.pendingActions = []
    reviewState.receivedAt = 0
    reviewState.noChangeNeeded = false
    reviewState.conclusions = {}
    reviewState.editsAfterReview = 0
    reviewState.lastSubagentAt = 0
    reviewState.lastSubagentSuccessfulAt = 0
    reviewState.lastSubagentPromptCount = 0
    reviewState.subagentCount = 0
    reviewState.lastPromptAt = 0
    reviewState.reviewPromptCount = 0
    reviewState.reviewResultPromptCount = 0
    reviewState.lastPromptImageCount = 0
    reviewState.lastPromptExpectedImageCount = 0
    reviewState.lastPromptVisualComplete = false
    reviewState.resultValid = false
    reviewState.resultParsed = false
    reviewState.lastMode = null
    reviewState.lastTarget = null
    reviewState.reviewedGroups = {}
    reviewState.resultTaskId = null
    reviewState.resultMode = null
    reviewState.resultScope = null
    reviewState.resultCoverageComplete = false
    reviewState.resultVisualComplete = false
    reviewState.resultProvenanceComplete = false
    reviewState.resultTechnicalOverride = false
    reviewState.resultReviewer = null
    reviewProvenance.reset()
  }

  const noteReviewResult = (r) => {
    reviewState.pendingByGroup = mergeReviewActions(reviewState.pendingByGroup, r)
    reviewState.pendingActions = [...new Set(Object.values(reviewState.pendingByGroup).flat())]
    reviewState.noChangeNeeded = !!r?.noChangeNeeded && reviewState.pendingActions.length === 0
    reviewState.resultParsed = !!(r && r.parsed)
    reviewState.resultValid = !!(r && r.valid)
    reviewState.conclusions = (r && r.conclusions) || {}
    reviewState.receivedAt = Date.now()
    reviewState.reviewResultPromptCount = reviewState.reviewPromptCount
    reviewState.resultTaskId = r && r.taskId || null
    reviewState.resultMode = r && r.mode || null
    reviewState.resultScope = r && r.scope || null
    reviewState.resultCoverageComplete = !!(r && r.coverageComplete)
    reviewState.resultVisualComplete = !!(r && r.visualComplete)
    reviewState.resultProvenanceComplete = !!(r && r.provenanceComplete)
    reviewState.resultTechnicalOverride = !!(r && r.technicalOverride)
    reviewState.resultReviewer = r?.reviewer || 'independent'
    /* 新一轮结论到来，之前「改过几次」的计数清零重算 */
    reviewState.editsAfterReview = 0

    /* 按组记账：材质阶段要核对「每个物品组都检测过」。
     * 组名来自 model_review 的 target 参数 —— 不传就记成整场景。 */
    const g = (r && r.target) || reviewState.lastTarget || 'scene'
    const mode = (r && r.mode) || reviewState.lastMode || 'structure'
    reviewState.reviewedGroups[g] = {
      at: Date.now(),
      mode,
      actionCount: reviewState.pendingActions.length,
    }

    /* 材质模式下，标记这个组「已检测过」。
     * 材质门禁靠这个判断「上完材质后有没有派检测员看过」。 */
    if (mode === 'material' && r?.valid && !(r.actions || []).length) {
      const covered = r.scope === 'scene' && r.coverageComplete
        ? Object.keys(materialState.touchedGroups) : (r.groups || [g])
      for (const k of covered) {
        if (materialState.touchedGroups[k]) {
          materialState.touchedGroups[k].reviewed = true
          materialState.touchedGroups[k].reviewedAt = Date.now()
        }
      }
    }
  }

  /** 建模改动时同步记账：检测结论之后改了几次 */
  const noteEditForReview = () => {
    if (reviewState.receivedAt) reviewState.editsAfterReview++
  }

  /* ── 材质改动记账 ──
   *
   * 材质阶段的门禁要回答这个问题：**这个组上完材质后检测过吗？**
   * 所以要区分「材质改动」和「建模改动」——两者的检查标准不一样。
   *
   * 哪些算材质改动：建材质、赋材质、改材质属性、UV 操作。
   * （写脚本搭节点树也算，但脚本内容读不到，所以只在模型自己声明的层面上记账） */
  const MATERIAL_EDIT_TOOLS = new Set([
    'create_material', 'assign_material', 'set_material_property',
    'uv_unwrap', 'uv_pack', 'uv_scale', 'uv_auto_all',
  ])

  const materialState = {
    /** 上过材质的组（按组记账，材质阶段逐组推进） */
    touchedGroups: {},
    /** 材质改动次数 */
    editCount: 0,
    /** 最近一次材质改动时间 */
    lastEditAt: 0,
  }
  const getMaterialState = () => ({
    ...materialState,
    touchedGroups: { ...materialState.touchedGroups },
  })

  const noteMaterialEdit = (toolName, target) => {
    materialState.editCount++
    materialState.lastEditAt = Date.now()
    /* 没指定组就记成整场景 */
    const g = target || 'scene'
    materialState.touchedGroups[g] = {
      at: Date.now(),
      tool: toolName,
      /* 这个组改过材质之后还没检测过 */
      reviewed: false,
    }
  }

  const resetMaterialState = () => {
    materialState.touchedGroups = {}
    materialState.editCount = 0
    materialState.lastEditAt = 0
  }

  /* 会改变场景几何的建模工具（调用后需要重新检查） */
  const MODELING_EDIT_TOOLS = new Set([
    'add_primitive', 'add_text', 'add_empty',
    'extrude', 'inset', 'bevel', 'subdivide', 'loop_cut', 'smooth_shade',
    'transform_object', 'align_objects', 'mirror_object', 'duplicate_object',
    'add_modifier', 'remove_modifier',
    'join_objects', 'separate_object', 'set_origin',
    'delete_objects', 'rename_object',
    'import_file',
    'group_create', 'group_split', 'group_delete',
    'execute_python',
  ])

  /* 已知最终导出入口要求最新场景检查；保存和过程预览不受此限制。
   * 任意 Python 内部的导出调用不在这个工具名拦截范围，仍需遵守交付流程。 */
  const FINALIZE_TOOLS = new Set([
    'export_file',
  ])

  // Merges are reported for editability review; they are valid modeling operations.
  const scanJoinUsage = (code) => {
    const source = String(code || '').replace(/"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|#[^\n]*/g, ' ')
    return /\bbpy\s*\.\s*ops\s*\.\s*object\s*\.\s*join\s*\(/.test(source)
  }

  const hasScriptExport = (code) => /\bbpy\s*\.\s*ops\s*\.\s*(?:export_scene\s*\.|wm\s*\.\s*\w+_export\s*\()/
    .test(String(code || '').replace(/"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|#[^\n]*/g, ' '))

  const inspectAutomatically = async () => {
    if (automaticChecking || autoAttemptEdit === modelingState.editCount) return
    automaticChecking = true
    autoAttemptEdit = modelingState.editCount
    try {
      const result = await tools.find(t => t.name === 'model_loop').execute({
        quick_check: true, verdict: 'continue', purpose: '插件按批次自动检查',
        next_improvement: state.loop?.nextImprovement || '依据当前待办和疑点继续建模',
        mesh_pair_budget: Math.min(200000, Math.max(5000, state.check?.interference?.candidatePairs || 0)),
        _automatic: true,
      })
      if (result?.kind === 'error' || result?.error) throw new Error(result.error || result.lines?.join('；') || '自动检查未返回结果')
      autoCheckError = ''
    } catch (e) {
      autoCheckError = String(e.message || e).slice(0, 240)
    } finally { automaticChecking = false }
  }


  /* ── 任务清单快照：在上下文中恢复已建立清单的范围 ──
   *
   * 为什么需要（真实事故）：
   *   DSH 的 todo_write 是**整体替换**语义，状态只存在会话事件流里，
   *   **它不会把清单回显到模型上下文**。模型只有主动调用时才知道清单内容。
   *
   *   实测（建模测试7）：
   *     10:56 建房清单 → 11:22 才第二次更新（隔了 26 分钟）→ 之后不再更新。
   *   期间它跑了 14 次 model_loop，但清单一直是旧的 12 条，
   *   于是「做到哪、还剩什么」全靠记忆——记不住就停下来。
   *
   * 只回显最近一次清单的进度和剩余项；清单是可选的规划辅助，
   * 不用时间阈值催促更新。
   */
  const todoState = {
    /** 最近一次清单里的统计 */
    lastTotal: 0,
    lastDone: 0,
    /** 最近一次清单的未完成项（用于回显「还剩什么」） */
    lastRemaining: [],
  }
  const getTodoState = () => ({ ...todoState, lastRemaining: todoState.lastRemaining.slice() })
  const resetTodoState = () => {
    todoState.lastTotal = 0
    todoState.lastDone = 0
    todoState.lastRemaining = []
  }

  /** 记录一次 todo_write。args 是工具参数。 */
  const noteTodoWrite = (args) => {
    const todos = Array.isArray(args && args.todos) ? args.todos : []
    workMemory.captureTodo(todos)
    if (!todos.length) return
    todoState.lastTotal = todos.length
    todoState.lastDone = todos.filter((x) => x && x.status === 'completed').length
    todoState.lastRemaining = todos
      .filter((x) => x && x.status !== 'completed')
      .map((x) => String(x.content || '').slice(0, 60))
      .slice(0, 12)
  }

  /* ── 删除守卫：记录被删的物体 ──
   *
   * 为什么需要：模型遇到穿模时最省事的做法是把碍事的东西删掉。
   * 删完穿模当然清零，但场景也空了，而且它不会再回头看。
   *
   * 这里不阻止删除（有时确实该删），只做两件事：
   *   ① 删之前把物体的位置/尺寸/所属组记下来（deletedLog）
   *   ② 之后通过 model_deleted 工具让它**显式交代**每一个的去留
   *
   * 记录为什么必须在删除**之前**拿：删完位置信息就没了，
   * 只剩一个名字，没法知道该放回哪。
   */
  const deletedLog = {
    /** 最近的删除批次：{ at, tool, items: [snapshot] } */
    batches: [],
    /** 未交代的记录（模型还没说明该不该加回） */
    pending: [],
    /** 已交代的：{ id, verdict, reason, at } */
    resolved: new Map(),
  }
  const getDeletedLog = () => ({
    batches: deletedLog.batches.slice(),
    pending: deletedLog.pending.slice(),
    resolved: Array.from(deletedLog.resolved.entries()),
    pendingCount: deletedLog.pending.length,
  })

  /** 记录一批删除。snapshots 是删除前抓的 mesh 快照。 */
  const noteDeleted = (toolName, snapshots) => {
    const items = (snapshots || []).filter(Boolean)
    if (!items.length) return
    deletedLog.batches.push({ at: Date.now(), tool: toolName, items })
    if (deletedLog.batches.length > 20) deletedLog.batches.shift()
    deletedLog.pending.push(...items)
    /* 挂着不交代的最多留 50 条，避免无限膨胀 */
    if (deletedLog.pending.length > 50) {
      deletedLog.pending = deletedLog.pending.slice(-50)
    }
  }

  /** 模型交代了一条删除记录的去留。 */
  const noteDeleteVerdict = (id, verdict, reason) => {
    deletedLog.resolved.set(String(id), { verdict, reason: reason || '', at: Date.now() })
    deletedLog.pending = deletedLog.pending.filter((p) => String(p.id) !== String(id))
  }


  /* 工具注册 */
  probe('STEP2-before-buildTools')
  const tools = buildTools({
    sourceFor,
    setSourceSelection,
    setMcpUrl,
    config: () => cfg,
    remember,
    packageDir: PACKAGE_DIR,
    hostCtx: ctx,
    getRefState,
    markRefAnalyzed,
    getResearchState,
    getPhaseState,
    markModelingComplete,
    resetPhase,
    getModelingState,
    noteCheck,
    noteModelingEdit,
    noteReviewResult,
    getReviewState,
    noteReviewPrompt,
    getMaterialState,
    noteMaterialEdit,
    /* 删除守卫 */
    getDeletedLog,
    noteDeleted,
    noteDeleteVerdict,
    /* 任务清单守卫 */
    getTodoState,
    noteTodoWrite,
    getNativeSignal,
    workMemory,
  })
  probe('STEP3-buildTools-done')
  for (const spec of tools) {
    /* 逐个探针：哪个工具 defineTool 抛错就一目了然 */
    probe('TOOL-TRY', spec.name)
    ctx.effect(() => {
      try {
        const def = defineTool(spec)
        ctx.tools.register(def)
        probe('TOOL-OK', spec.name)
      } catch (e) {
        probe('TOOL-FAIL', spec.name + ' :: ' + ((e && e.message) || e))
        throw e
      }
    }, 'ptc-model-check:tool:' + spec.name)
  }

  /* 诊断：宿主里 schemastery 到底能不能拿到。拿不到只影响 Config 校验，不影响工具。 */
  if (!z) {
    const diag = resolveSchemaDiagnostic()
    try {
      const sample = tools[0] && tools[0].parameters
      const hint = sample && Object.keys(sample).length ? '工具参数 schema 正常' : '工具参数 schema 为空'
      /* 判「是不是函数」而不是判「存不存在」。
       * ctx.logger 存在但不是函数时，`ctx.logger ? ...` 为真 → 调用即抛
       * TypeError: ctx.logger(...) is not a function。
       * 而这段包在 try 里，会把整段诊断静默吞掉——真出问题时反而没有线索。 */
      if (typeof ctx.logger === 'function') ctx.logger('warn')('ptc-model-check: 没解析到 schemastery（Config 不校验），' + hint + ' · ' + diag)
      else console.warn('[ptc-model-check] 没解析到 schemastery（Config 不校验），' + hint + ' · ' + diag)
    } catch { /* 诊断失败不影响加载 */ }
  }

  probe('STEP4-tools-registered')
  /* 释放长驻子进程 */
  ctx.effect(() => () => {
    for (const [, s] of sessions) { try { void s.dispose() } catch { /* ignore */ } }
    sessions.clear()
  }, 'ptc-model-check:dispose')

  /* ── 环境自检：分「检查」与「拉起」两级，绝不因为会话被恢复就开窗口 ──
   *
   * 踩过两次坑：
   *   第一次：把自检放在 apply() 里 → DSH 一启动就拉 Blender。
   *           原因是 preset 会被**预激活**，apply() 在启动时就跑了。
   *   第二次：改到 agent/created → 仍然一启动就拉。
   *           原因是 DSH 重启会**自动恢复上次会话**，恢复即创建 agent，
   *           于是又把 Blender 拉起来了（实测启动后 12 秒拉起）。
   *
   * 所以最终策略是**彻底惰性**：
   *   - agent/created  → 只**检查**（不打开任何窗口），把状态写进上下文
   *   - agent/pre-step → 用户真的发消息了，才允许**拉起**
   *   - blender_ready  → 模型主动要求，允许拉起
   *   - mcp__blender__* 首次调用 → 允许拉起（模型开始建模了）
   *
   * 结论：打开 DSH、恢复会话都不会开 Blender；只有你开始建模才会。
   */
  let checkStarted = false
  let launchStarted = false
  let bootCancelled = false

  /** 记录每次触发到临时文件，方便以后查「到底是谁把 Blender 拉起来的」。 */
  const traceBoot = (reason, mode) => {
    try {
      const os = require('node:os')
      const fs = require('node:fs')
      const p = path.join(os.tmpdir(), 'ptc-model-check-boot.log')
      fs.appendFileSync(p, new Date().toISOString() + '\t' + mode + '\t' + reason
        + '\tdshPid=' + process.pid + '\n')
    } catch { /* 日志失败不影响主流程 */ }
  }

  /**
   * @param {string} reason 触发原因（写进状态与日志）
   * @param {boolean} allowLaunch 是否允许真的拉起 Blender
   */
  const runBoot = async (reason, allowLaunch) => {
    if (bootCancelled) return
    // 检查只做一次；拉起也只做一次，但「拉起」可以覆盖之前只检查过的状态
    if (allowLaunch) {
      if (launchStarted) return
      launchStarted = true
      checkStarted = true
    } else {
      if (checkStarted) return
      checkStarted = true
    }
    traceBoot(reason, allowLaunch ? 'launch' : 'check-only')

    try {
      /* 没配 mcpServerScript 时自动发现（两次建模测试里它都是空的，
       * 于是服务器永远起不来，只能靠模型自己 Start-Process，
       * 那次「就绪」就不再是插件拉起的了）。 */
      const found = findMcpServerScript(cfg.mcpServerScript || '', { packageDir: PACKAGE_DIR })
      const res = await ensureBlenderStack({
        mcpUrl: cfg.mcpUrl,
        mcpPort: cfg.mcpPort,
        blenderPort: cfg.blenderPort,
        serverScript: found ? found.script : null,
        blenderExe: cfg.blenderPath || '',
        blend: cfg.blend || null,
        autoLaunch: allowLaunch && cfg.autoBootBlender !== false,
      })
      if (bootCancelled) return
      /* nativeMissing 每次都要重读：bundle 装好并重启后，上一会话留下的
       * 拒绝记录不应继续把新会话判成「没注册」。这里取的是本会话的观察值。 */
      state.blenderReady = {
        ...res, reason, launched: allowLaunch, at: Date.now(),
        nativeMissing: nativeSignal.nativeMissing,
        /* 客户端断连也是本会话观察到的事实，一并交给状态文本 */
        mcpDisconnected: nativeSignal.mcpDisconnected,
        /* 拒绝次数与最后一次被拒的工具名给状态文本用，让它能说事实而不是套话 */
        deniedCount: nativeSignal.deniedCount,
        lastNativeCall: nativeSignal.lastCall,
        serverScriptFound: !!found,
      }
      /* 同上：判「是不是函数」。这个是启动自检路径上的关键日志，
       * 它一崩，「Blender 环境：拉起失败」后面就变成空的报错串。 */
      const log = typeof ctx.logger === 'function'
        ? (m, x) => {
          try { ctx.logger(m)(x) } catch { console.error('[ptc-model-check] ' + x) }
        }
        : (m, x) => console.error('[ptc-model-check] ' + x)
      if (res.ok) {
        log('info', '[ptc-model-check] Blender 环境就绪（' + reason + '）：' + res.steps.join(' / '))
      } else {
        log('warn', '[ptc-model-check] Blender 环境未就绪（' + reason + '）：' + res.steps.join(' / ')
          + (res.hint ? ' · ' + res.hint : ''))
      }
    } catch (e) {
      if (!bootCancelled) {
        state.blenderReady = {
          ok: false, action: 'error', steps: [], hint: String((e && e.message) || e),
          reason, launched: allowLaunch, at: Date.now(),
        }
      }
    }
  }

  /* ① 会话创建：**只检查，不拉起**。
   * 恢复会话也会走到这里，所以这里绝对不能开窗口。 */
  ctx.effect(() => {
    const off = ctx.on ? ctx.on('agent/created', () => { void runBoot('会话创建', false) }) : () => {}
    return () => {
      bootCancelled = true
      try { off && off() } catch { /* ignore */ }
    }
  }, 'ptc-model-check:boot-on-agent')

  /* ② 用户真的发消息了：这时才允许拉起。
   * agent/pre-step 在每次模型步进前触发，用 once 标志保证只拉一次。
   *
   * 同时记录用户是否给了图片素材，便于提供相关提示。 */
  const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|tga|exr)\b/i
  /* 「参考图」字样检测。
   *
   * 这条规则**本身很脆**：任何提到这三个字的文本都会命中。
   * 所以：
   *   ① 前面的循环必须先排除 runtime-context（插件自己注入的状态文本），
   *      否则会自我污染 → done 永久被拒（实测过的死循环）。
   *   ② 正则收紧到「明确在说要给图」的说法，避免「没有参考图」这种否定句命中。
   *
   * 误判代价很高（永久阻断），收益只是省一次分析调用——所以宁可漏判。
   * 真正的结构信号（图片附件、图片路径）才是主判据。 */
  const REFERENCE_WORD = /(参考图|原画|reference\s*image|ref\s*image)/i
  /** 否定表达：说了「参考图」但意思是没有它。 */
  const REFERENCE_NEGATED = /(没有|没给|未给|不带|不需要|无需|不用|没有提供|never\s+given|no\s+reference)/i

  /* ── 删除记账：观察 delete_objects 的结果，把快照记进删除账本 ──
   *
   * 为什么必须用 tools/result 而不是 pre-execute：
   *   快照是 addon 在**删除瞬间**抓的（那时对象还在），
   *   从 pre-execute 拿不到——它只有调用参数，没有返回结果。
   *
   * 为什么要记账：
   *   模型遇到穿模时最省事的做法是把碍事的物体删掉。删完穿模清零，
   *   但场景也空了，而且它不会回头确认那些东西是不是本来就该在。
   *   这里把「删了什么、原来在哪、多大、属于哪个组」记下来，
   *   之后要它逐条交代去留（model_deleted 工具）。
   */
  ctx.effect(() => {
    const off = ctx.on
      ? ctx.on('tools/result', (exec, result) => {
        try {
          const name = exec && exec.name ? String(exec.name) : ''
          const base = name.includes('__') ? name.split('__').pop() : name
          /* 第①层观察：模型真的调用过 mcp__blender__* 且被 DSH 拒绝
           * （tool not found 之类）→ 这是「MCP 没接进 DSH」的确证。
           * 只由失败置位；「没看到成功」不能推断成没注册。 */
          if (isNativeToolMissing(name, result)) noteNativeDenied(name)
          /* 断连信号：模型可能先探 resource 才发现断连，所以不限定工具名。 */
          if (isMcpClientDisconnected(name, result)) noteMcpDisconnected(name)
          if (base === 'subagent' || base === 'subagent_fork') {
            if (!result || result.isError) return
            const value = result.value || result
            const subagentId = value && value.subagentId
            const prompt = exec && exec.arguments && exec.arguments.prompt
            if (value && value.kind === 'activation' && subagentId) {
              noteSubagentDispatch(prompt, subagentId)
            }
            return
          }
          /* 结构调研记账：这里能拿到返回值，可以判断有没有拿到正文。
           * 只数次数不行——空结果不能算作完成调研。 */
          if (base === 'model_reference') {
            try {
              const q = exec && exec.arguments && exec.arguments.query
              const v = (result && (result.value || result)) || {}
              noteResearch(q, v)
            } catch { /* 记账失败不影响工具 */ }
            return
          }

          if (base !== 'delete_objects' && base !== 'delete_object') return
          if (!result || result.isError) return
          /* 从结果里取快照。MCP 工具的结果通常放在 value / content。 */
          const v = result.value || result
          const snaps = (v && (v.snapshots || (v.content && v.content.snapshots))) || null
          if (Array.isArray(snaps) && snaps.length) {
            noteDeleted(name, snaps.map((s) => ({
              id: s.name || s.id,
              name: s.name || s.id,
              part: s.custom_props && (s.custom_props.ptc_part || s.custom_props.part) || s.name,
              bbox: s.bbox || null,
              center: s.center || s.location || null,
              dims: s.dimensions || null,
              rotation: s.rotation || null,
              triangles: s.triangles || 0,
              vertices: s.vertices || 0,
              materials: s.materials || [],
              collection: (s.collections && s.collections[0]) || null,
              collections: s.collections || [],
              at: Date.now(),
            })))
          }
        } catch { /* 记账失败不能影响工具本身 */ }
      })
      : () => {}
    return () => {
      try { off && off() } catch { /* ignore */ }
    }
  }, 'ptc-model-check:note-deleted')

  ctx.effect(() => {
    const off = ctx.on
      ? ctx.on('subagent/end', (event, next) => {
        try {
          const payload = event || {}
          const final = payload.lastAssistantMessage
          let text = ''
          if (typeof final === 'string') text = final
          else if (final && typeof final.text === 'string') text = final.text
          else if (final && Array.isArray(final.content)) {
            text = final.content.map((part) => part && (part.text || part.content) || '')
              .filter((part) => typeof part === 'string').join('\n')
          }
          noteSubagentEnd(payload.id, payload.stopReason, text)
        } catch { /* 审计事件不能中断子智能体工作 */ }
        return typeof next === 'function' ? next() : undefined
      })
      : () => {}
    return () => {
      try { off && off() } catch { /* ignore */ }
    }
  }, 'ptc-model-check:review-subagent-end')

  ctx.effect(() => {
    const off = ctx.on
      ? ctx.on('agent/pre-step', async (payload, next) => {
        if (!launchStarted) void runBoot('用户开始建模', true)
        try {
          const msgs = (payload && payload.messages) || []
          let latestTaskText = null
          for (const m of msgs) {
            if (!m || m.role !== 'user') continue
            /* **排除插件自己注入的运行时状态快照。**
             *
             * 宿主 RuntimeContextProjection.project() 用 createUserMessage 注入状态文本，
             * 所以 role 同样是 'user'，来源标记是 source.kind === 'runtime-context'。
             *
             * 不排除的后果（**实测过的死循环**）：
             *   状态文本里含「参考图」三个字（第 2311 行那句提示），
             *   → 被下面的正则命中 → refState.given = true
             *   → canStop 永久报「用户给了参考图但没分析过」，无论用户到底给没给
             *   → 模型永远无法签收，done 被拒到天荒地老。
             *   而用户自始至终只说了一句「做一个末日废墟的场景」。
             */
            const src = m.source
            const kind = src && (src.kind || src.source)
            if (kind === 'runtime-context') continue
            if (src && src.form === 'snapshot') continue
            const textParts = []
            for (const part of (m.content || [])) {
              if (!part) continue
              /* 结构信号最可靠：真的图片附件才算给了参考图 */
              if (part.type === 'image') { refState.given = true; continue }
              if (part.type === 'text' && typeof part.text === 'string') {
                /* 路径信号：消息里出现图片文件名，说明用户在指一张图 */
                if (IMAGE_EXT.test(part.text)) refState.given = true
                /* 「参考图」字样作为兜底。
                 * 注意这条很容易误判，所以排在最后，且已经被上面的
                 * runtime-context 过滤挡掉了自己注入的文本。 */
                if (REFERENCE_WORD.test(part.text) && !REFERENCE_NEGATED.test(part.text)) {
                  refState.given = true
                }
                textParts.push(part.text)
              }
            }
            const taskText = textParts.join('\n')
            latestTaskText = taskText
            /* 扫描历史用户请求以恢复活跃任务门槛；reset 候选只取最近请求。 */
            if (taskText.length > 4) {
              try { noteTaskText(taskText) } catch { /* ignore */ }
            }
          }
          if (latestTaskText !== null) {
            try { noteTaskText(latestTaskText, true) } catch { /* ignore */ }
          }
        } catch { /* 检测失败不影响主流程 */ }
        // Reconcile scripts against real geometry, including edits made before a Python error.
        if (scriptPending && geometryBaseline) {
          try {
            const extracted = await sourceFor().extract({ maxObjects: cfg.maxObjects, maxTriangles: cfg.maxTriangles })
            if (!(extracted.skipped || []).length && geometryRevision(extracted.meshes || []) === geometryBaseline && pendingScriptSnapshot) {
              const saved = pendingScriptSnapshot
              Object.assign(modelingState, saved.modeling)
              Object.assign(phaseState, saved.phase)
              if (reviewState.resultMode === 'structure') reviewState.editsAfterReview = saved.reviewEdits
            }
          } catch (e) { autoCheckError = '脚本后几何状态未确认：' + String(e.message || e).slice(0, 200) }
          scriptPending = false
          pendingScriptSnapshot = null
        }
        const batch = Math.max(0, Number(cfg.autoCheckBatch) || 0)
        if (batch > 0 && modelingState.editsSinceCheck >= batch) await inspectAutomatically()
        return next()
      })
      : () => {}
    return () => {
      bootCancelled = true
      try { off && off() } catch { /* ignore */ }
    }
  }, 'ptc-model-check:boot-on-pre-step')

  /* ③ 工具执行前：启动环境、记录场景改动与合并、核对最终导出前的检查状态。 */
  ctx.effect(() => {
    const off = ctx.on
      ? ctx.on('tools/pre-execute', (exec, next) => {
        const name = exec && exec.name ? String(exec.name) : ''
        const base = name.includes('__') ? name.split('__').pop() : name
        /* ── 禁止自建 MCP / socket 桥 ──
         * 建模测试 32：MCP 客户端断连后，模型自己写 Python 直连 addon 的 9876，
         * 建出了东西但全程零插件检查。这条路必须堵死——它看起来能用，
         * 一旦成功模型就会一直走。 */
        const bridgeReason = detectHandwrittenBridge(name, exec && exec.arguments)
        if (bridgeReason) return { kind: 'deny', reason: bridgeReason }

        if (base === 'execute_python' && hasScriptExport(exec?.arguments?.code)) {
          return { kind: 'deny', reason: '脚本中的直接导出请改用 export_file，让交付沿用同一检查状态。保存和材质脚本始终可用；工具受限时先用整场景 model_loop(done, handoff_limitations=具体未验证项) 记录阶段交付，不等于验收通过。' }
        }
        if (name.startsWith('mcp__blender__') && !launchStarted) {
          void runBoot('调用 Blender 工具', true)
        }

        /* ── 任务清单记账：记录模型最后一次写的清单 ──
         *
         * 为什么在这里记账：todo_write 的状态在 DSH 侧不回流到上下文，
         * 我们只能从调用参数里截下来，之后在运行时状态里回显。 */
        if (base === 'todo_write') {
          try { noteTodoWrite(exec && exec.arguments) } catch { /* 记账失败不影响工具 */ }
        }

        /* ── 调研记账已移到 tools/result ──
         *
         * 原因：pre-execute 只能拿到调用参数，拿不到返回结果。
         * 而我们要判断「这次调研有没有拿到正文」——
         * 只数次数的话，模型调 3 次拿空结果就能过门禁，
         * 那比不调更糟（它以为自己查过了）。
         *
         * 所以记账放到 tools/result，能读返回值。 */

        /* ── 任务规模识别由 agent/pre-step 在做 ──
         * 见 noteTaskText：从用户消息里抓专有名词（巴黎圣母院、AK-47），
         * 命中的话设置本任务的有效结构资料要求。这里不用重复处理。 */

        /* 合并操作有效；只提醒保留源结构和检查内部关系，不能靠工具名证明合并是否合理。 */
        if (base === 'join_objects'
          || (base === 'execute_python' && scanJoinUsage(exec?.arguments?.code))) {
          modelingState.mergeSinceCheck = true
        }

        if (MODELING_EDIT_TOOLS.has(base)) {
          if (base === 'execute_python') {
            if (!scriptPending) pendingScriptSnapshot = { modeling: { ...modelingState }, phase: { ...phaseState }, reviewEdits: reviewState.editsAfterReview }
            scriptPending = true
            noteMaterialEdit(name, null)
          } else {
            pendingScriptSnapshot = null
          }
          noteModelingEdit(name)
          noteEditForReview()
        }
        /* 材质改动单独记账：材质阶段的门禁要核对「每组上完材质后检测过没」 */
        if (MATERIAL_EDIT_TOOLS.has(base)) {
          noteMaterialEdit(name, null)
        } else if (FINALIZE_TOOLS.has(base) && (modelingState.dirtySinceCheck || !modelingState.lastCheckAccepted)
          && modelingState.editCount > 0 && !modelingState.provisionalExport) {
          return {
            kind: 'deny',
            reason:
              '【流程门禁】最新几何尚未完成有效的全场景检查，暂不能最终导出。\n'
              + '工具「' + name + '」正在导出文件，需要先检查最新场景。\n'
              + (modelingState.checkCount > 0
                ? '已经执行过检查；缺的是最新整场景的有效结论，不是调用次数。'
                  + '重复同一检查不会消除命中；不要为过关提高阈值、删细节或合并物品。\n'
                  + ((state.check?.stopBlockers || []).length
                    ? '最近检查未签收原因：' + state.check.stopBlockers.join('；').slice(0, 1000) + '\n' : '')
                : '')
              + '\n'
              + '刚才改的是：' + (modelingState.lastEditTool || '（未知）') + '\n'
              + '建模改动 ' + modelingState.editCount + ' 次，检查 ' + modelingState.checkCount + ' 次\n'
              + '\n'
              + (modelingState.checkCount > 0
                ? '先按报告恢复覆盖、修正有证据的错误或完成合理命中的复核，再用 tools.model_loop 更新结果；它包含：\n'
                : '**必须先调 tools.model_loop**，中间修复可传 quick_check: true；它会给你：\n')
              + '  ① 穿模检测（分「组内插入/穿出」和「组间穿模」）\n'
              + '  ② 孤立检测\n'
              + '  ③ 逐 mesh 完整性 + 精度一致性\n'
              + '  ④ 分组可靠性及各组问题排序\n'
              + '最终 done 会自动补跑完整场景五视图；重点组隔离图按需用 model_review 或 per_mesh_views。\n'
              + '\n'
              + '重点检查某组：model_review({ target: \'物品组名\' })\n'
              + '准备交付：model_loop({ target: \'scene\', verdict: \'done\', stop_reason: \'...\' })\n'
              + '检测持续受限时可用 handoff_limitations 列明未验证范围，交付阶段成果；状态仍是未验收，不能称全部合格。\n'
              + '\n'
              + '（look 会附带穿模与孤立摘要，但没有五视图和逐组完整层次——'
              + '签收仍以 model_loop 的完整验收为准）',
          }
        }

        /* ── look 的软提示：看图可以，但别拿它当检查 ──
         *
         * 不拦截 look（建模中要反复手动观察），只记录次数。
         * 连续看了很多次还没检查过，说明模型可能在「看一眼觉得不错就收工」。
         * 这个计数会被 model_groups / model_loop 读到，写进返回文案里提醒。 */
        if (base === 'look' && modelingState.dirtySinceCheck && modelingState.editCount > 0) {
          modelingState.lookSinceEdit = (modelingState.lookSinceEdit || 0) + 1
        }

        /* 阶段门禁已移除（材质工具不再受限）*/

        return next()
      })
      : () => {}
    return () => {
      try { off && off() } catch { /* ignore */ }
    }
  }, 'ptc-model-check:boot-on-tool')

  /* ④ 兜底：第一次组装提示词时只做「检查」，不拉起 */
  const bootOnFirstPrompt = () => {
    if (!checkStarted && !bootCancelled) void runBoot('首轮对话', false)
  }

  /* ⑤ 看图即检测：把「穿模 + 孤立」追加到 look / render_preview 的同一个结果里。
   *
   * 为什么用 tools/post-execute：这是宿主唯一能在「已渲染归一化」的结果上
   * 追加内容、又不会被工具自己的 render 覆盖的扩展点。宿主 0.2.1-rc.3 的契约：
   *   决策 = { kind: 'accept', content? } | { kind: 'block', feedback }
   *   ① content 与 value 不能同时替换；② 监听器抛错会把整次调用变成 isError。
   * 所以这里全程 try/catch + 超时：最坏情况只是没有检测数据，绝不能让看图失败。
   * 检测与 model_isolation 同源（buildViewCheckReport），不另立阈值。 */
  const VIEW_TOOLS = new Set(['look', 'render_preview'])
  const withTimeout = (promise, ms) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('检测超时（' + Math.round(ms / 1000) + 's）')), ms)
    if (timer && typeof timer.unref === 'function') timer.unref()
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
  ctx.effect(() => {
    const off = ctx.on
      ? ctx.on('tools/post-execute', async (exec, result, next) => {
        const decision = await next()
        const contentOf = () => (decision && decision.content) || (result && result.content) || []
        try {
          if (cfg.viewCheck === false) return decision
          const name = exec && exec.name ? String(exec.name) : ''
          const base = name.includes('__') ? name.split('__').pop() : name
          if (!VIEW_TOOLS.has(base)) return decision
          if (!decision || decision.kind !== 'accept' || (result && result.isError)) return decision
          const report = await withTimeout(
            buildViewCheckReport(sourceFor(), cfg, { maxItems: cfg.viewCheckItems }),
            Math.max(5000, Number(cfg.viewCheckTimeoutMs) || 120000),
          )
          return { ...decision, content: contentOf().concat([{ type: 'text', text: report.text }]) }
        } catch (e) {
          /* 检测失败/超时也要让模型知道「这次没检测到」，否则它会把缺失当成干净 */
          try {
            return {
              ...decision,
              content: contentOf().concat([{
                type: 'text',
                text: '【看图附带检测】未完成：' + String((e && e.message) || e).slice(0, 160)
                  + '。这张图只用于视觉判断，不能当作穿模/孤立检查结果。',
              }]),
            }
          } catch { return decision }
        }
      })
      : () => {}
    return () => {
      try { off && off() } catch { /* ignore */ }
    }
  }, 'ptc-model-check:view-checks')

  if (!cfg.injectContext) return

  /* 静态段只保留决策流程，工具细节由 native schema 提供；限当前 preset。 */
  const sp = ctx.get ? ctx.get('systemPrompt') : undefined
  if (sp) {
    ctx.effect(() => sp.section({
      name: 'modeling:mode',
      order: 3600,
      text: MODEL_CHECK_SECTION,
      interpolate: false,
    }), 'ptc-model-check:section')

    /* 自动注入 2：运行时状态（当前建模源 + 上次检查结果）。
     * 模型不必重复调用就能知道还剩什么问题，也避免它以为"没跑过检查就是干净的"。 */
    ctx.effect(() => sp.context({
      name: 'modeling:state',
      order: 3600,
      required: false,
      interpolate: false,
      text: () => {
        /* 兜底触发：第一次组装提示词说明真的有人在用这个模式了。
         * 放在这里而不是 apply()，是因为 preset 会被预激活——
         * apply() 在 DSH 启动时就跑了，那时还没有任何建模会话。 */
        bootOnFirstPrompt()
        /* 这个函数每轮请求前都会执行，崩了整个请求就失败（本轮运行失败
         * Cannot read properties of undefined 的教训）。所以整体 try/catch，
         * 出错时降级成一行提示，绝不把异常抛给请求管线。 */
        try {
          /* 把当前状态、清单快照、阶段状态、建模节奏一起交给组装函数。
           * 这些都不在 state 里（各在独立账本），所以现取一次。 */
          return buildStateText({
            ...state,
            /* 缺环境时模型要自己去装：给它两个它猜不出来的绝对路径。
             * 相对路径在装好之后是找不到的（插件在 node_modules 里，cwd 是用户工程）。 */
            installDocPath: path.join(PACKAGE_DIR, 'docs', 'install-blender-mcp.md'),
            profileDir: process.env.DSH_PROFILE_DIR || '',
            /* DSH 自带 CLI 的绝对路径：装第③层时要用它（内含 pnpm，不需要系统装）。 */
            dshCliPath: process.platform === 'win32'
              ? path.join(path.dirname(process.execPath), 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd')
              : 'dsh',
            todo: getTodoState(),
            phase: getPhaseState(),
            modeling: getModelingState(),
            research: getResearchState(),
            review: getReviewState(),
            memoryText: workMemory.context(),
            designIntent: workMemory.design(),
          })
        } catch (e) {
          return '场景建模模式已激活。（运行时状态生成失败：' + String((e && e.message) || e) + '）'
        }
      },
    }), 'ptc-model-check:context')
  }

  /* 走到这里说明 apply 完整跑完了：所有 effect 注册成功、工具都注册了。
   * 如果这个标记没出现，说明 apply 中途抛错。 */
  probe('OK', 'apply 完整执行完毕')
}

/** 组装运行时状态文本。所有字段访问都做空值保护。 */
function buildStateText(state) {
  const lines = []
  /* 安装文档怎么引用：本函数会被测试用 new Function 单独抽取执行，拿不到模块级
   * 常量，所以绝对路径由 state.installDocPath 传入；缺失时退回相对路径
   * （测试走这条，历史行为不变）。相对路径对模型没用——插件装在
   * node_modules/@local/ptc-model-check 下，模型的 cwd 是用户工程目录。 */
  const docRef = state.installDocPath || 'docs/install-blender-mcp.md'
  const profileDir = state.profileDir || ''
  /* 审美测试声明：放在运行时上下文的第一行，先于任务记忆与其它状态出现。
   * 末尾的限定从句是为了不和既有规则打架——它只否决「因预算提前收工」，
   * 不覆盖用户目标优先、真实限制如实说明这些边界。
   * 必须写成内联字面量——本函数会被测试用 new Function 单独抽取执行，
   * 引用模块级常量会直接 ReferenceError。 */
  lines.push('这个任务是一个极致的审美测试任务，目标是测试模型最高的审美和作品完成度上限，实验数据将用于学术研究，'
    + '你现在拥有无限的 token 和时间预算，你现在需要尽最大的能力来保证测试的美术和造型是美丽的，好看的，'
    + '以及一个完整的作品，不需要太追求极致的写实，但是需要追求极致的作品完成度和美术风格及造型风格，'
    + '所有的工具和资源都将为这个任务让步，你现在拥有无限制的 token 来完成这个伟大！的足以载入史册的作品'
    + '（该声明只要求不因预算、轮数或耗时顾虑而提前收工或放松检查标准；用户目标优先、工具真实限制和遗留项如实说明、无证据不编造缺口等既有规则不变）。')
  if (state.memoryText) lines.push(state.memoryText)
  if (!state.phase?.modelingComplete && !state.loop) {
    lines.push('开工先按用户意图区分单件与整体场景；场所型目标先做分区、动线与全局体块，用任务记忆固定布局，不能等建出多个组才考虑场景。')
    lines.push('默认自主细化：主体成型后主动补轮廓特征、连接与功能结构、符合风格的表面几何，再看图修正；'
      + '按用户的草模/低模、用途和预算控制细节，不等用户逐轮催促，不为凑数量堆装饰。')
  }

  /* 插件版本 + 门禁自检：方便确认这个会话到底加载了哪一版代码。
   * 踩过坑：改了插件但会话里还是旧行为，查半天查不到原因。 */
  lines.push('插件版本：v' + PLUGIN_VERSION
    + '（中间支持快速检查；done 自动执行完整视图验收）')

  const review = state.review
  if (review) {
    const promptCount = Number(review.reviewPromptCount) || (review.lastPromptAt ? 1 : 0)
    const resultCount = Number(review.reviewResultPromptCount)
      || (review.receivedAt && !review.lastPromptAt ? 1 : 0)
    if (promptCount > resultCount) {
      if (review.lastPromptExpectedImageCount > 0 && !review.lastPromptVisualComplete) {
        lines.push('视觉复核：最新任务缺少完整五视图，恢复图片输出后按原复核方式重新生成任务。')
      } else {
        lines.push(review.latestTask?.reviewer === 'self'
          ? '视觉复核：当前为自查任务，不调用子代理；按附图完成三问并带任务标识回传 apply_result。'
          : '视觉复核：最新任务已生成，结果还未回传；按并发预算完成独立检查，再调用 model_review({ apply_result })。')
      }
    } else if (promptCount > 0 && review.resultValid === false && review.receivedAt) {
      lines.push('视觉复核：最新回传格式无效；需要补全三问和「必须修的」清单，或明确写「无需修改」及依据。')
    } else if ((review.pendingActions || []).length) {
      lines.push('视觉复核：还有 ' + review.pendingActions.length + ' 条待办；完成后重新复核确认。')
    } else if (promptCount > 0 && review.resultValid === true) {
      lines.push('视觉复核：最新' + (review.resultReviewer === 'self' ? '自查' : '独立复核')
        + '结果有效，当前没有待处理修改项。')
    }
  }

  /* Blender 环境状态：这是进入模式后模型最需要知道的一件事。
   *
   * 环境缺失时**不把安装文档灌进上下文**，只给出文档路径并强制阅读。
   * 为什么这样设计：安装文档约 7 千字（下载地址、addon 单文件落位、端口核对、
   * 七项验收），环境正常时全读一遍纯属浪费 token，而且会把建模指令挤到
   * 后面去。所以默认只检测、只报结论；缺了才让它去读。
   *
   * 分类交给 classifyEnv（纯函数，可单测），这里只负责措辞。 */
  const br = state.blenderReady
  if (br) {
    /* classifyEnv 来自模块作用域；本函数会被测试用 new Function 单独抽取执行，
     * 那里没有这个标识符。用 typeof 守卫：取不到时退回「按 hint 有无」的粗判，
     * 绝不能让整个运行时状态因为一个分类函数缺失而崩掉。 */
    const env = typeof classifyEnv === 'function'
      ? classifyEnv(br)
      : {
        /* 降级路径也要认清「断连」：它和「没注册」的处理方式相反
         * （前者重启，后者装包），混在一起会给出错误指令。 */
        kind: br.mcpDisconnected
          ? 'mcp-client-disconnected'
          : (br.nativeMissing ? 'mcp-not-registered' : (br.ok ? 'ok' : 'incomplete')),
        needsInstallDoc: br.mcpDisconnected ? false : (br.nativeMissing ? true : !br.ok),
        label: br.mcpDisconnected
          ? 'MCP 服务器在线，但 DSH 的 MCP 客户端已断开'
          : (br.nativeMissing ? 'MCP 服务器可达，但没接进 DSH' : (br.ok ? 'Blender 与 MCP 均可用' : 'Blender 环境未就绪')),
      }
    if (env.kind === 'mcp-client-disconnected') {
      /* 建模测试 32 的真实故障：服务器在线、工具名也注册了，但链路断了。
       * 模型探到断连后自己写了 Python socket 桥直连 9876，全程零插件检查。
       * 三个要点：说清症状、说清唯一解法（重启）、点名禁止搭桥。 */
      lines.push('Blender 环境：**MCP 服务器在线，但 DSH 的 MCP 客户端已断连**')
      lines.push('  本会话调用时报 `mcp-client(blender): server is disconnected`。'
        + '服务器进程活着（' + ((br.steps || []).join(' / ') || '探测通过') + '），'
        + '但 DSH 到它的链路是死的——这时 ' + (br.lastNativeCall || 'mcp__blender__*')
        + ' 一个都调不动。')
      lines.push('⛔ **必须完全退出 DSH 再启动**（不是刷新页面，也不是重装插件）：'
        + '客户端连接只在进程启动时建立，运行中的断连不会自愈。')
      lines.push('⛔ **禁止自己搭桥**：不要写 Python / Node 脚本去连 '
        + '127.0.0.1:9876（addon socket）或 127.0.0.1:8765（MCP HTTP）直接发命令。'
        + '那样绕过了 mcp 客户端，插件的几何检查、看图检测、五视图和签收门禁全部失效'
        + '（建模测试 32 就是这样跑完全程零检查）。')
      lines.push('→ 重启后先调 blender_ready({}) 看到「就绪 ✓」，再开始建模。')
    } else if (env.kind === 'mcp-not-registered') {
      /* 最危险的一类：探测全绿，但工具不存在。
       * 必须抢在 br.ok 分支前面说，否则这里会显示「已就绪」，
       * 模型就会像建模测试 28 那样自己开无头 Blender 硬做，
       * 插件的检查与看图检测全程看不见那个场景，最后零检查交付。 */
      lines.push('Blender 环境：**MCP 服务器可达，但没接进 DSH**')
      lines.push('  本会话调用 ' + (br.lastNativeCall || 'mcp__blender__*') + ' 被拒绝 '
        + (br.deniedCount || 1) + ' 次（tool not found）。服务器在线（'
        + ((br.steps || []).join(' / ') || '探测通过') + '）只说明进程活着，不说明工具存在。')
      lines.push('⛔ **必须装配套包 blender-mcp 才能继续**：它自带 cordis.patch.yml，'
        + '把 http://127.0.0.1:8765/mcp 注册成 mcp__blender__* 工具。'
        + '下载 https://github.com/panda472328/dsh-blender-mcp/releases 的 zip，'
        + '按 ' + docRef + ' §2 装进 profile 并**完全重启 DSH**。')
      /* 只发一个包时，接收方的 AI 必须能自己补齐这一层。
       * 两个它猜不出来的东西直接给：安装文档的绝对路径、当前 profile 的绝对路径。
       * 另外说明清楚：本模式没有 plugin_manager 工具（preset 里 disabled），
       * 所以别让它去找那个工具，按文档 §2.2 方式 B 用 pwsh 做。 */
      if (state.installDocPath) lines.push('  安装文档（绝对路径）：' + state.installDocPath)
      if (profileDir) lines.push('  当前 profile：' + profileDir)
      /* 自装步骤必须用 CLI，不能用 `pnpm install`。
       * 实测：陌生机器上没有 pnpm（不在 PATH），而 DSH 自带的 CLI 内含 pnpm，
       * 且 `dsh plugin ... add` 会自动把包登记进 dsh.profile.bundles——
       * 手工改 package.json 时最容易漏的正是这一步（漏了等于没装）。 */
      if (profileDir) {
        const profName = profileDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '<profile>'
        const cli = state.dshCliPath || '<DSH 安装目录>\\resources\\runtime\\cli\\bin\\dsh.cmd'
        lines.push('  怎么自己装（本模式没有 plugin_manager 工具；不需要系统装 pnpm，CLI 自带）：')
        lines.push('    1) 下载并解压 '
          + 'https://github.com/panda472328/dsh-blender-mcp/releases/latest/download/blender-mcp-1.2.4.zip')
        lines.push('    2) "' + cli + '" plugin --profile ' + profName
          + ' add file:<解压出的 blender-mcp-1.2.4 目录绝对路径>')
        lines.push('       这条命令会自动写 dependencies 与 dsh.profile.bundles，不用手改 package.json。')
        lines.push('    3) 完全退出 DSH 再启动（bundle 列表只在启动时读取，刷新页面无效）')
      } else {
        lines.push('  怎么自己装：见安装文档 §2.2；不要用 `pnpm install`，普通机器上没有 pnpm。')
      }
      lines.push('⛔ **禁止绕过**：不要用 pwsh 起 `blender -b` 自己跑 bpy 脚本、'
        + '不要自己 Start-Process 拉服务器后手写 JSON-RPC，'
        + '也不要写脚本直连 127.0.0.1:9876（addon）或 8765（MCP HTTP）搭桥。'
        + '那样插件的 live 源看不见你的场景，'
        + 'model_loop / 看图检测 / 五视图 / 签收门禁全部失效，等于没有做过任何几何检查。')
      lines.push('→ 请用户安装 blender-mcp bundle 并重启 DSH；'
        + '装好后调 blender_ready({})，看到「就绪 ✓」再开始建模。')
    } else if (br.endpointMismatch || br.nativeEndpointAligned === false) {
      lines.push('Blender 环境：**插件检查端点与 DSH 原生建模端点不一致**')
      if (br.steps && br.steps.length) lines.push('  ' + br.steps.join(' / '))
      if (br.hint) lines.push('→ ' + br.hint)
      lines.push('→ 两端点指向不同服务时，检查结果和建模对象会对不上。先按 ' + docRef + ' §4.3 核对 mcpUrl 与 mcpPort。')
    } else if (br.ok) {
      /* 环境齐全：一行结论，**不出现安装文档**，避免诱导模型去读。 */
      lines.push('Blender 环境：**已就绪**（' + (br.steps || []).join(' / ') + '）')
      lines.push('→ 直接开始建模，第一步建议 mcp__blender__get_scene_info 看场景。')
    } else if (br.launched === false) {
      /* 只检查过、还没拉起：常见于「刚开会话还没动手」。 */
      lines.push('Blender 环境：**未就绪**（只检查过，还没拉起）：' + env.label)
      lines.push('  ' + (br.steps || []).join(' / '))
      if (br.hint) lines.push('  ' + br.hint)
      lines.push('→ 你现在这个会话还没开始建模，所以没有自动打开 Blender。'
        + '一旦调用 blender_ready 或任何 mcp__blender__* 工具，会自动拉起。')
      if (env.needsInstallDoc) {
        lines.push('→ **如果拉起后仍然失败**（缺 Blender、缺 MCP 或 addon 没监听），'
          + '先读 ' + docRef + ' 按文档装好，再回来建模。不要跳过环境直接写脚本。')
      }
    } else {
      lines.push('Blender 环境：**拉起失败**：' + env.label)
      lines.push('  ' + (br.steps || []).join(' / '))
      if (br.hint) lines.push('  ' + br.hint)
      if (env.needsInstallDoc) {
        /* 强制阅读：缺环境时建模不可能成功，先让它把文档读完再动手。
         * 措辞要点：说清 addon 是「单文件」，因为最容易出错的就是这一步——
         * 网上找一个同名项目装上去，工具名全对不上。 */
        lines.push('⛔ **动手建模前必须先读 ' + docRef + '**'
          + '（路径相对插件包根目录，即本仓库 docs/ 下）。'
          + '这份文档包含下载、安装、启用 addon、端口核对和七项验收命令；'
          + '只按上面的 hint 猜一步往往装不完整。')
        lines.push('   注意：配套 addon 是**单文件 blender_mcp.py**（1.2.3），拷到 '
          + '%APPDATA%\\Blender Foundation\\Blender\\<版本>\\scripts\\addons\\ 后启用；'
          + '不要从网上找同名项目顶替，工具名会全部对不上。')
        lines.push('   读完按文档装好，再调 blender_ready({}) 确认 ok: true，然后才开始建模。'
          + '没有可用的 Blender 时不要用 execute_python 伪造场景，也不要声称「环境应该没问题」。')
      } else {
        lines.push('→ 调 blender_ready 重试；仍不行就按上面的提示让用户处理。')
      }
    }
  } else {
    lines.push('Blender 环境：首轮只读检查尚未返回；状态未就绪或连接报错时再调 blender_ready。')
  }

  /* 参考图分析结果：展示颜色与区域数据，供建模按需参考 */
  const ref = state.referenceImage
  if (ref) {
    const g = ref.gridSize || {}
    const subj = ref.subject || {}
    lines.push('参考图：**已分析** ' + (ref.path || '')
      + ' · ' + (ref.colors || []).length + ' 种主色'
      + (g.cols ? ' · 网格 ' + g.cols + '×' + g.rows + '（每格 ' + g.cellPx + 'px）' : '')
      + (subj.fallback ? ' · 主体识别退回整图' : ' · 主体占 ' + ((subj.coverage || 0) * 100).toFixed(1) + '%'))
    const top = (ref.colors || [])[0]
    if (top) {
      lines.push('最大面积颜色：' + top.hex + '（' + (top.ratio * 100).toFixed(1) + '%）'
        + '；像素占比不代表结构重要性或真实表面积')
    }
  } else {
    /* 措辞注意：**不要在这里写「参考图」这三个字。**
     * 这段文本每轮都作为 user 消息注入，而上面的检测器会扫 user 消息。
     * 虽然检测器已经排除了 runtime-context 来源，但多一层保险：
     * 万一宿主的 source 标记变了，也不会再自我污染。 */
    lines.push('如任务附带图片素材且需要精确颜色或区域数据，可调用 model_reference_image；'
      + '该分析为可选辅助，不是签收硬门槛。')
  }

  /* ── 结构调研状态 ──
   *
   * 和「参考图」并列显示：之前只有参考图有状态行，调研没有——
   * 注意力被有度量的东西牵引，没被显示的就被忘掉。
   *
   * 调研是「这东西由什么组成」的唯一来源，比参考图更基础：
   * 参考图告诉你外观，调研告诉你构件清单。 */
  const rs = state.research
  if (rs && rs.required > 0) {
    /* 显示「有效次数 / 要求次数」，并在有空调用的空结果时单独警告。
     * 空调用是关键信号：模型以为查过了，其实只拿到链接——
     * 必须让它明确知道「这次白查了」，否则它会以为自己做了调研。 */
    const eff = rs.effectiveCount || 0
    const empt = rs.emptyCount || 0
    const off = rs.offTopicCount || 0
    if (eff >= rs.required) {
      lines.push('结构调研：**已完成**（有效资料 ' + eff + '/' + rs.required + ' 条'
        + (empt > 0 ? '，另有 ' + empt + ' 次空结果' : '') + '）'
        + (rs.queries.length ? ' 最近查的：「' + rs.queries[rs.queries.length - 1] + '」' : ''))
    } else {
       lines.push('高保真复刻结构调研：**有效资料 ' + eff + '/' + rs.required + ' 条 ⚠ 还不够**'
        + (rs.subject ? '（任务要还原「' + rs.subject + '」）' : ''))
      if (empt > 0) {
        lines.push('   ⚠ 有 ' + empt + ' 次调用**只拿到标题和链接、没有正文**——那不算查到内容。')
        lines.push('   换更具体的结构词重查，或用 depth:"deep" 抓正文。')
      }
      if (off > 0) {
        lines.push('   ⚠ 有 ' + off + ' 次**内容跑题**：拿到了字，但讲的不是你要查的结构。')
        lines.push('   这通常是因为查询词太泛（「故宫」「哥特」），搜索引擎给的是背景介绍。')
        lines.push('   改成更具体的中文结构词，例如「斗拱 构件 名称 排列」「飞扶壁 受力 支撑」。')
      }
      lines.push('   → 还差 ' + rs.missing + ' 条**有效结构资料**（拿到构件组成说明才算）。')
       lines.push('   **这项只对用户明确要求高保真复刻的任务构成签收条件。**')
      if (rs.queries.length) {
        lines.push('   已经查过：' + rs.queries.slice(-3).map((q) => '「' + q + '」').join('、'))
      }
    }
  } else if (rs && rs.required === 0) {
    lines.push('结构调研：按需调用，不是签收条件')
  }

  if (state.source) lines.push('建模源：' + state.source)

  /* 检查节奏提示：工具调用数只作上下文，不代表实际几何量或风险。 */
  const ms = state.modeling
  if (ms?.mergeSinceCheck) {
    lines.push('合并提醒：核实独立功能件、分组和可恢复源仍保留；合并体内部的零件碰撞不在对象间检测覆盖范围内。')
  }
  if (ms && (ms.editCount || 0) > 0) {
    const since = ms.editsSinceCheck || 0
    if (since >= 12) {
      lines.push('')
      lines.push('ⓘ 自上次检查以来有 ' + since + ' 次建模工具调用；这只是上下文，'
        + '一次脚本也可能生成很多几何。')
      lines.push('   按一批几何或逻辑阶段完成、结构风险和未解决的问题判断何时检查；'
        + '无需为了计数立即中断。')
    }
  }
  const c = state.check
  if (c) {
    lines.push('上次自检（' + new Date(ms?.lastCheckAt || state.updatedAt).toLocaleTimeString() + '）：'
      + (c.target === 'scene' ? '整场景' : '范围「' + (c.target || '未记录') + '」') + ' · ' + c.meshes + ' 个 mesh，'
      + '相交候选 ' + (c.interference?.hits ?? '?') + ' 对，未接触 ' + (c.isolation?.hits ?? '?') + ' 个'
      + (c.naming && c.naming.generic ? '，未命名 ' + c.naming.generic + ' 个' : ''))
    if (c.interference?.complete === false) {
      lines.push('检查已执行，但覆盖不完整；未检查部分不能算通过，按报告恢复检测覆盖并保留模型。')
    }
    if (c.hierarchy) {
      const h = c.hierarchy
      const disconnected = h.internal.filter(g => g.isolation.applicable && g.isolation.componentCount > 1)
      lines.push('两层检测：全局 ' + h.global.groupCount + ' 个组、' + h.global.isolation.componentCount
        + ' 个连接簇；' + disconnected.length + ' 个组内部有分离簇'
        + (h.complete ? '。' : '；存在未完成检查，不能把未知当通过。'))
      if (h.global.isolation.componentCount > 1 || disconnected.length) {
        lines.push('按报告核对整组悬空、组内未连接小团和仅接触组外的零件；背景或预期间隙需具体说明，不把接触等同正确支撑。')
      }
    }
    if (c.target !== 'scene') lines.push('本次为局部检查，不能替代整场景最终签收。')
    if ((ms?.editsSinceCheck || 0) > 0) {
      lines.push('检查后又有场景改动，上述数值是改动前的快照；完成当前批次后复查受影响范围。')
    }
    const first = (c.interference?.items || [])[0]
    if (first) lines.push('最严重的穿模：' + first.a + ' ↔ ' + first.b + '（' + (first.ratio * 100).toFixed(2) + '%）')
    const iso = (c.isolation?.items || [])[0]
    if (iso) lines.push('未接触件：' + iso.part + '（' + (iso.gapKind === 'bbox-lower-bound' ? '包围盒距离下界 ' : '间距 ') + iso.gap + '）')
    /* 逐 mesh 与精度状态：这是验收项，必须让模型随时看到 */
    const pm = c.perMesh
    if (pm) {
      const bad = (pm.problems || []).length
      lines.push('逐 mesh 隔离检查：' + (bad === 0
        ? '未发现当前网格检查支持的问题；这不证明封闭性或自相交全部正确'
        : bad + ' 个 mesh 有待核实的诊断（' + (pm.problems || []).map((p) => p.part).slice(0, 5).join('、') + '）'))
      const prec = pm.precision || {}
      const out = (prec.outliers || []).length
      if (prec.tooFew) {
            lines.push('精度一致性：有效 mesh 少于 4 个，跳过')
      } else if (out === 0) {
        lines.push('精度一致性：所有零件一致 ✓（中位面密度 ' + (prec.median?.faceDensityRel ?? '?') + '）')
      } else {
        lines.push('精度一致性：' + out + ' 个零件偏离主流（'
          + (prec.outliers || []).map((o) => o.part).slice(0, 5).join('、')
          + '）；这是提示，按曲率、轮廓和目标视距判断，不为统一面数改几何')
      }
    }
  } else {
    lines.push('还没跑过自检：首次主体与主要连接成型后就用 model_loop 快速检查；不要等灯光材质全部完成才首检。')
  }
  if (state.loop) {
    const l = state.loop
    if (!state.phase?.modelingComplete && l.detailGuidance) {
      /* 复核可在两次 loop 之间完成；按实时状态重算，不能反复催旧清单。 */
      const currentDetail = buildDetailGuidance({
        target: l.target,
        stopped: l.stopped && state.modeling?.dirtySinceCheck !== true,
        quickCheck: l.quickCheck || state.modeling?.dirtySinceCheck === true,
        inspectionComplete: l.interference?.complete,
        groupingOk: l.groupingState?.ok,
        visualReady: l.detailGuidance.visualReady,
        review: state.review,
        sceneGroups: l.groups,
        designIntent: state.designIntent,
        groupDigest: l.groupDigest,
        meshCount: l.meshes,
        round: l.round,
        modelingComplete: state.phase?.modelingComplete,
        sceneDetail: l.sceneDetail || l.detailGuidance.sceneDetail,
      })
      if (currentDetail.next) lines.push('自主细化下一步：' + currentDetail.next)
      const sceneDetail = currentDetail.sceneDetail || l.sceneDetail || l.detailGuidance.sceneDetail
      if (sceneDetail?.active
        && (currentDetail.stage === 'assess_detail' || currentDetail.stage === 'prepare_visual')) {
        lines.push('当前场景细化阶段：第 ' + (Number(sceneDetail.stageIndex) + 1)
          + ' 阶段「' + sceneDetail.stage + '」（' + sceneDetail.groupCount + ' 个物品组）')
        if (sceneDetail.next) lines.push('场景级下一步：' + sceneDetail.next)
        if (sceneDetail.checklist?.length) {
          lines.push('场景级核对：' + sceneDetail.checklist.slice(0, 3).join('；'))
        }
        lines.push('本轮不要只给单件物体加零件；处理至少一个有依据的组间关系、空间过渡或环境层次。')
      }
    }
    let line = '上次小循环（第 ' + (l.round || 1) + ' 轮）：' + (l.target || 'scene')
      + (l.quickCheck ? ' · 快速检查（未渲图）' : ' · ' + (l.views || []).join('/'))
    if (l.silhouette && l.silhouette.ok) {
      line += ' · 剪影 ' + l.silhouette.iouPercent + (l.silhouette.pass ? ' ✓' : ' ✗未达标')
    }
    lines.push(line)
    /* 闭环状态：这是模型「接下来该干什么」的唯一提醒，必须写清 */
    if (l.stopped && state.modeling?.dirtySinceCheck === true) {
      lines.push('旧签收后又有场景改动，旧结论已过期；完成当前批次后重新检查受影响范围，最终再验收整场景。')
    } else if (l.stopped) {
      lines.push('上述范围的检查已结束。理由：' + (l.stopReason || '（未写）')
        + (l.visualComplete === false ? '；本轮缺少完整附图，只能说明技术检查结果。' : ''))
    } else if (l.verdict === 'continue') {
      lines.push('迭代未结束。你上一轮承诺的改进项：「' + (l.nextImprovement || '（没写，下一轮必须写）') + '」')
      lines.push('→ 按当前待办执行；若下一步是恢复视图、调研或调整检测预算，先完成相应动作，无需强制造几何改动。')
      if (l.stopBlockers && l.stopBlockers.length) {
        lines.push('距离可以停还差：' + l.stopBlockers.join('；'))
      }
    } else if (l.verdict === 'done' && l.canStop === false) {
      lines.push('⚠ 你上轮想停但被拒绝。还差：' + (l.stopBlockers || []).join('；'))
      lines.push('→ 继续迭代，别急着收尾。')
    }
  } else if (state.screenshot && state.screenshot.target) {
    lines.push('上次看图：' + state.screenshot.target + ' · ' + (state.screenshot.finalViews || []).join('/'))
  }

  /* todo_write 状态不自动进入上下文；仅当模型已选择使用清单时回显。 */
  if (state.todo && state.todo.lastTotal > 0) {
    const td = state.todo
    lines.push('任务清单：' + td.lastDone + '/' + td.lastTotal + ' 已完成')
    if (td.lastRemaining && td.lastRemaining.length) {
      lines.push('   后续项：')
      for (const r of td.lastRemaining.slice(0, 6)) lines.push('     · ' + r)
      if (td.lastRemaining.length > 6) lines.push('     · …还有 ' + (td.lastRemaining.length - 6) + ' 项')
    }
  }

  return lines.join('\n')
}
