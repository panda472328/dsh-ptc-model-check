#!/usr/bin/env node
/**
 * 结构检索脚本 —— 绕过 DSH web 服务的限制，直接抓 Bing。
 *
 * 为什么需要这个脚本（实测数据）：
 *   · DSH 的 web.search 只返回标题+链接，snippet 经常是空的
 *   · deep 模式去抓百度百科/知乎，全部 HTTP 403
 *   · 维基百科、DuckDuckGo 在这个环境完全连不上
 *   · **只有 Bing 能抓（200，100KB，含结构词）**
 *
 * 更重要的发现：查询词质量直接决定结果质量。
 *   「斗拱 由哪些构件组成 栌斗 散斗 华拱」→ 4/4 结果全含结构词
 *   「故宫太和殿 斗拱 结构」          → 0/4 结果全是故宫背景介绍
 *
 * 用法：
 *   node research.mjs "斗拱 由哪些构件组成"
 *   node research.mjs "飞扶壁 结构 受力" --deep
 *   node research.mjs "斗拱" --json
 *
 * 输出：结构化文本（默认）或 JSON（--json），含来源、摘要、相关性判定。
 */

import process from 'node:process'

/* 结构词表：和 lib/core/structure.mjs 里的定义保持一致。
 * 这是整个脚本的核心：没有它，跑题摘要会被当成有效结果。 */
const STRUCT_TERMS = /构件|组成|连接|支撑|承重|受力|荷载|榫|卯|斗拱|斗栱|拱|梁|柱|檩|椽|额枋|平板枋|瓦|檐|脊|戗|角梁|由昂|昂|翘|升|斗|枋|扶壁|飞扶壁|券|肋|拱顶|穹顶|穹|台基|基座|须弥座|檐口|女儿墙|栏杆|望柱|踏跺|阶|门窗|隔扇|槛窗|直棂|棂|廊|塔|叠涩|收分|侧脚|生起|举折|升起|柱础|墙|屋顶|坡|构架|框架|桁|椽条|檩条|铺作|柱头|转角|补间|栌斗|散斗|交互斗|华拱|泥道拱|瓜子拱|慢拱|令拱|耍头|衬方头|bracket|buttress|arch|vault|column|beam|truss|cantilever|masonry|pier|span/i

/* ── 参数解析 ── */
const argv = process.argv.slice(2)
const flag = (n) => argv.includes('--' + n)
const val = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
/* 带值的选项不能混进查询词；这是插件通过子进程传参时的关键。 */
const valueFlags = new Set(['max', 'aspect', 'mode'])
const queryParts = []
for (let i = 0; i < argv.length; i++) {
  const item = argv[i]
  if (item.startsWith('--')) {
    if (valueFlags.has(item.slice(2))) i++
    continue
  }
  queryParts.push(item)
}
const query = queryParts.join(' ').trim()
const wantJson = flag('json')
const deep = flag('deep')
const maxResults = Math.min(10, Math.max(1, Number(val('max', 5)) || 5))
const aspect = val('aspect', 'structure')
const mode = val('mode', 'explore') === 'verify' ? 'verify' : 'explore'
const aspectHint = {
  structure: '构件组成 连接 支撑 结构做法',
  proportion: '体块主次 相对比例 形态变化',
  motion: '运动方向 避让 连接方式 活动原理',
  material: '材料搭配 加工装配 表面层次',
}[aspect] || '构件组成 连接 支撑 结构做法'
const searchQuery = query + ' ' + aspectHint + (mode === 'verify' ? ' 尺寸规格依据' : '')

/* 探索模式只保留结构关系，避免把搜索结果的偶然尺寸变成模型约束。 */
const adaptText = (value) => {
  const text = String(value || '')
  if (mode === 'verify') return text
  const amount = '(?:\\d+(?:[.,]\\d+)*|[零〇一二两三四五六七八九十百千万]+)'
  return text
    .replace(new RegExp('(?<![A-Za-z0-9_.-])' + amount + '\\s*(?:毫米|厘米|分米|千米|微米|米|英寸|英尺|mm|cm|dm|km|μm|µm|m|inches|inch|feet|ft|度|degrees?|deg|°)(?![A-Za-z])', 'gi'), '〔尺寸略〕')
    .replace(new RegExp('(?<![A-Za-z0-9_.-])' + amount + '\\s*[:：]\\s*' + amount + '(?![A-Za-z0-9.])', 'g'), '〔比例略〕')
    .replace(new RegExp('(?<![A-Za-z0-9_.-])' + amount + '\\s*(?:个|枚|颗|块|根|片|条|件|组|层|排|列|段|处|圈|道|扇|座|对|套|只|张|支|台|孔|panels?|screws?|bolts?|layers?|rows?|segments?|holes?|pieces?)(?![A-Za-z])', 'gi'), '〔数量略〕')
}

const guidance = mode === 'verify'
  ? ['精确核实：只为用户指定尺寸、严格复刻、制造或接口配合保留必要数据；没有可靠来源就说明未知，不能编造精度。',
    '分清用户硬要求、来源中的特定实例和原创设计建议；实例数据不自动成为整件模型的约束。']
  : ['探索调研：优先理解组成、连接、功能、形态层次和可选做法，为原创设计提供线索。',
    '下列文字为定性节选，常见的明确尺寸、数量和比例以省略标记呈现；不是逐字引文，原始数据可查来源链接。',
    '不要在调研阶段预先锁死尺寸、坐标、零件数量或唯一方案；也不要把省略的数据补猜成事实。',
    '先考虑不同的结构与细节方向，再按用途和风格选取协调方案。来源事实与原创设想分开说明，用户明确要求优先。']

if (!query) {
  console.error('用法: node research.mjs "<查询>" [--deep] [--json] [--max 5]')
  process.exit(1)
}

/* ── 工具函数 ── */
const stripTags = (s) => String(s || '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&ensp;|&nbsp;/g, ' ')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#\d+;/g, ' ')
  .replace(/\s+/g, ' ').trim()

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

/** 抓 Bing 搜索结果页 */
async function searchBing(q) {
  const url = 'https://www.bing.com/search?q=' + encodeURIComponent(q) + '&setlang=zh-CN&count=' + maxResults
  const r = await fetch(url, {
    headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    signal: AbortSignal.timeout(20000),
    redirect: 'follow',
  })
  if (!r.ok) throw new Error('Bing HTTP ' + r.status)
  return r.text()
}

/** 从结果页解析出来源列表 */
function parseBing(html) {
  const out = []
  const blocks = html.split('class="b_algo"').slice(1)
  for (const b of blocks) {
    const href = (b.match(/<a[^>]+href="(https?:\/\/[^"]+)"/) || [])[1]
    if (!href) continue
    const title = stripTags((b.match(/<h2[^>]*>([\s\S]*?)<\/h2>/) || [])[1] || '')
    const capM = b.match(/class="b_caption"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/)
    const pAny = b.match(/<p[^>]*>([\s\S]*?)<\/p>/)
    const snippet = stripTags((capM && capM[1]) || (pAny && pAny[1]) || '')
    out.push({ title, url: href, snippet })
    if (out.length >= maxResults) break
  }
  return out
}

/** 抓正文（deep 模式）。多源尝试，拿到够用的就停。 */
async function fetchBody(url) {
  const r = await fetch(url, {
    headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' },
    signal: AbortSignal.timeout(15000),
    redirect: 'follow',
  })
  if (!r.ok) throw new Error('HTTP ' + r.status)
  const html = await r.text()
  const text = stripTags(html)
  if (text.length < 150) throw new Error('正文太短')
  /* 只留含结构词的段落 */
  const segs = text.split(/(?<=[。！？；.!?;])/)
  const picked = segs.filter((s) => s.length >= 12 && STRUCT_TERMS.test(s)).slice(0, 10)
  return picked.length ? picked.join('') : text.slice(0, 900)
}

/* ── 主流程 ── */
async function main() {
  const t0 = Date.now()

  let html
  try {
    html = await searchBing(searchQuery)
  } catch (e) {
    const err = { ok: false, query, aspect, mode, error: '搜索失败：' + e.message }
    if (wantJson) console.log(JSON.stringify(err, null, 2))
    else console.error('搜索失败：' + e.message + '\n换个说法重试，或检查网络。')
    process.exit(2)
  }

  const sources0 = parseBing(html)

  /* 相关性判定（先做一遍，为了决定要不要重试） */
  const judge = (list) => list.map((s) => ({
    ...s,
    hasStructWord: STRUCT_TERMS.test(s.snippet + ' ' + s.title),
  }))

  let sources = judge(sources0)
  let triedQueries = [searchQuery]

  /* 第一次结果太差（0 条相关）→ 加领域锚点词重试 */
  if (!sources.some((s) => s.hasStructWord) && sources.length > 0) {
    /* 领域锚点：让搜索引擎知道这是建筑/机械结构问题，不是查字典 */
    const ANCHORS = '构件 组成 结构 建筑 工程'
    const retry = searchQuery + ' ' + ANCHORS
    triedQueries.push(retry)
    try {
      const html2 = await searchBing(retry)
      const s2 = judge(parseBing(html2))
      if (s2.some((x) => x.hasStructWord)) {
        sources = s2
      } else {
        /* 还是不行，就保留第一次的结果（至少让模型看到搜索确实失败了） */
        sources = sources.concat(s2.map((x) => ({ ...x, retry: true })))
      }
    } catch { /* 重试失败就用手上的 */ }
  }

  /* 相关性判定：每条来源看它自己有没有结构词 */
  const qHasStruct = STRUCT_TERMS.test(query)
  /* 查询里的具体词出现在结果里 → 更可信 */
  const qWords = query.split(/[\s，,、。／/]+/).map((w) => w.trim())
    .filter((w) => w.length >= 2 && !/^(结构|原理|组成|连接|关系|方式|做法|怎么|如何|什么)$/.test(w))
  for (const s of sources) {
    s.hitWords = qWords.filter((w) => (s.snippet + s.title).includes(w))
  }

  const relevant = sources.filter((s) => s.hasStructWord)
  const offTopic = sources.filter((s) => !s.hasStructWord)

  /* deep 模式：抓正文 */
  let bodies = []
  if (deep && sources.length) {
    for (const s of sources.slice(0, 5)) {
      if (bodies.length >= 2) break
      try {
        const body = await fetchBody(s.url)
        bodies.push({ url: s.url, title: s.title, body: adaptText(body) })
        s.bodyLen = body.length
      } catch (e) {
        s.fetchErr = String(e.message || e).slice(0, 60)
      }
    }
  }

  const ms = Date.now() - t0

  const outputSources = sources.map((s) => ({ ...s, title: adaptText(s.title), snippet: adaptText(s.snippet) }))

  if (wantJson) {
    console.log(JSON.stringify({
      ok: true, query, aspect, mode, guidance, ms,
      sourceCount: sources.length,
      relevantCount: relevant.length,
      offTopicCount: offTopic.length,
      queryHasStructWord: qHasStruct,
      /* 判定：有结构词的结果才算「拿到东西」 */
      effective: relevant.length > 0 || bodies.length > 0,
      sources: outputSources, bodies,
    }, null, 2))
    return
  }

  /* 文本输出 */
  const out = []
  out.push('# 结构检索：' + query + '（' + aspect + ' / ' + mode + '）')
  out.push(...guidance)
  out.push('')
  out.push('耗时 ' + ms + 'ms · ' + sources.length + ' 条来源 · '
    + relevant.length + ' 条含结构词' + (offTopic.length ? ' · ' + offTopic.length + ' 条跑题' : ''))
  out.push('')

  if (relevant.length) {
    out.push('## 结构相关内容（可用）')
    out.push('')
    for (const s of relevant) {
      out.push('### ' + (adaptText(s.title) || '(无标题)'))
      out.push(s.url)
      if (s.snippet) out.push('> ' + adaptText(s.snippet).slice(0, 400))
      const b = bodies.find((x) => x.url === s.url)
      if (b) {
        out.push('')
        out.push('**正文节选**：')
        out.push(adaptText(b.body).slice(0, 1200) + (b.body.length > 1200 ? '…' : ''))
      }
      out.push('')
    }
  }

  if (offTopic.length) {
    out.push('## ⚠ 跑题结果（不要当参考）')
    out.push('')
    out.push('这些结果有内容，但讲的是领域背景不是结构组成：')
    for (const s of offTopic.slice(0, 4)) {
      out.push('- ' + (adaptText(s.title) || '(无标题)') + ' — ' + adaptText(s.snippet).slice(0, 100))
    }
    out.push('')
    out.push('**这说明查询词太泛。** 搜索引擎匹配了领域大词，没匹配结构词。')
    out.push('改法：把「' + query + '」拆成具体的构件名，例如加「构件 名称 排列」「受力 支撑」「榫卯 连接」。')
    out.push('')
  }

  if (!relevant.length && !offTopic.length) {
    out.push('没有拿到任何来源。换个说法重试。')
  }

  out.push('---')
  out.push('**提醒**：这是参考材料。构件组成和连接关系可以借鉴，')
  out.push('外形、比例、装饰细节必须由你按当前场景决定。')

  console.log(out.join('\n'))
}

await main()
