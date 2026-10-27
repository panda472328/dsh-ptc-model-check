/**
 * 零件规划：从区域分割结果推断「哪些像素属于同一个零件、哪些是分开的」，
 * 并给出判断「形状是否完整合理」所需的依据。
 *
 * 为什么需要这一步：
 *   颜色区域 ≠ 零件。一个零件可能由多个颜色区域组成（比如带涂装的金属件），
 *   一个颜色区域也可能跨多个零件（比如同色的两个盖子）。
 *   模型需要知道的是**零件级**的划分，才能决定「这个该做成一个 mesh，还是拆成几个」。
 *
 * 输出的三类判断：
 *   1. 零件分组：相邻、颜色接近、边界无硬边的区域 → 同一个零件
 *   2. 完整度信号：被画面截断、被遮挡、内部有大面积空洞 → 形状不完整，必须靠推断补全
 *   3. 理想化信号：对称性、边缘模糊度 → 提示「不要照抄像素轮廓，要还原成规则几何」
 */

import { colorDistance } from './color.mjs'

/**
 * 建区域邻接图，边权是「边界强度」。
 *
 * 边界强度的含义：
 *   低（< 阈值）→ 两个区域是渐变的，很可能是**同一个零件的不同受光面**
 *   高（>= 阈值）→ 有硬边，很可能是**两个零件的交界**
 */
export function buildAdjacency(regions, g, opts = {}) {
  const { cols, rows } = g
  const withIdx = regions.filter((r) => Array.isArray(r.cellsIdx))
  if (withIdx.length === 0) return { edges: [], label: null }

  const label = new Int32Array(cols * rows).fill(-1)
  for (const r of withIdx) {
    for (const idx of r.cellsIdx) label[idx] = r.id
  }
  const byId = new Map(withIdx.map((r) => [r.id, r]))

  /* 统计每对相邻区域的共边长度，以及边界上的平均色差 */
  const pairs = new Map()
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const idx = y * cols + x
      const la = label[idx]
      if (la < 0) continue
      const neighbours = []
      if (x < cols - 1) neighbours.push(idx + 1)
      if (y < rows - 1) neighbours.push(idx + cols)
      for (const nb of neighbours) {
        const lb = label[nb]
        if (lb < 0 || lb === la) continue
        const key = la < lb ? la + ':' + lb : lb + ':' + la
        let e = pairs.get(key)
        if (!e) {
          e = { a: Math.min(la, lb), b: Math.max(la, lb), shared: 0 }
          pairs.set(key, e)
        }
        e.shared++
      }
    }
  }

  const edges = []
  for (const e of pairs.values()) {
    const ra = byId.get(e.a)
    const rb = byId.get(e.b)
    if (!ra || !rb) continue
    const delta = colorDistance(ra.color, rb.color)
    edges.push({
      a: e.a,
      b: e.b,
      aHex: ra.hex,
      bHex: rb.hex,
      shared: e.shared,
      delta: Number(delta.toFixed(1)),
    })
  }
  edges.sort((x, y) => y.shared - x.shared)

  return { edges, label, byId }
}

/**
 * 按图像连续性生成候选区域组，不能证明实际物理分件。
 *
 * 分组规则（并查集）：
 *   两个区域合并为同一候选组，当**同时**满足：
 *     1. 相邻（共享边界 >= minShared 格）
 *     2. 色差 <= mergeTolerance（图像颜色相近）
 *     3. 边界上不存在「硬边」（色差在边界处是突变的，而不是渐变的）
 *
 * 色差大的区域不合并；边界也可能来自涂装、图案、光照或遮挡。
 */
export function groupIntoParts(regions, g, opts = {}) {
  const mergeTolerance = opts.mergeTolerance ?? 45
  const minShared = opts.minShared ?? 2
  const { edges, byId } = buildAdjacency(regions, g, opts)
  const withIdx = regions.filter((r) => Array.isArray(r.cellsIdx))

  const parent = new Map()
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)))
      x = parent.get(x)
    }
    return x
  }
  const union = (x, y) => {
    const rx = find(x)
    const ry = find(y)
    if (rx !== ry) parent.set(rx, ry)
  }
  for (const r of withIdx) parent.set(r.id, r.id)

  const mergedEdges = []
  const splitEdges = []
  for (const e of edges) {
    if (e.shared < minShared) continue
    if (e.delta <= mergeTolerance) {
      union(e.a, e.b)
      mergedEdges.push(e)
    } else {
      splitEdges.push(e)
    }
  }

  /* 组装零件 */
  const groups = new Map()
  for (const r of withIdx) {
    const root = find(r.id)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(r)
  }

  const total = g.cols * g.rows
  const parts = []
  for (const [, members] of groups) {
    let cells = 0
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    let varSum = 0
    /* 收集所有成员格子的索引，用来算真实轮廓填充率。
     * 单个色块的 bbox 往往恰好是矩形（同色像素天然连成块），
     * 所以必须把同一零件的多个色块合并后，再看轮廓是否填满包围盒。 */
    const allIdx = new Set()
    for (const m of members) {
      cells += m.cells
      varSum += m.avgVariance * m.cells
      x0 = Math.min(x0, m.bbox.x0)
      y0 = Math.min(y0, m.bbox.y0)
      x1 = Math.max(x1, m.bbox.x1)
      y1 = Math.max(y1, m.bbox.y1)
      if (Array.isArray(m.cellsIdx)) for (const idx of m.cellsIdx) allIdx.add(idx)
    }
    const bboxW = x1 - x0 + 1
    const bboxH = y1 - y0 + 1
    const bboxArea = bboxW * bboxH
    /* 主色：取成员里面积最大的那个区域的颜色 */
    const main = members.slice().sort((a, b) => b.cells - a.cells)[0]

    /* 轮廓规整度：所有格子在包围盒里的分布是否填满。
     * 用「每行的左右边界是否一致」判断：
     *   矩形 → 每行宽度相同
     *   圆/菱/梯形 → 宽度逐行变化
     * 这里算的是行宽的变异系数（越小越像矩形）。 */
    const rowWidths = new Map()
    for (const idx of allIdx) {
      const ry = Math.floor(idx / g.cols)
      rowWidths.set(ry, (rowWidths.get(ry) || 0) + 1)
    }
    let shapeRegularity = 1
    if (rowWidths.size > 2) {
      const ws = [...rowWidths.values()]
      const mean = ws.reduce((s, v) => s + v, 0) / ws.length
      const sd = Math.sqrt(ws.reduce((s, v) => s + (v - mean) ** 2, 0) / ws.length)
      shapeRegularity = mean === 0 ? 1 : Number((sd / mean).toFixed(3))
    }

    parts.push({
      regionIds: members.map((m) => m.id).sort((a, b) => a - b),
      regionCount: members.length,
      hex: main.hex,
      rgb: main.rgb,
      kind: main.kind,
      cells,
      areaRatio: Number((cells / total).toFixed(4)),
      bbox: { x0, y0, x1, y1 },
      bboxPx: { w: bboxW, h: bboxH },
      /* 填充率：零件占用自己包围盒的比例。
       * 接近 1 = 矩形/块状；明显小于 1 = 轮廓不规则，或有空洞/被遮挡。
       * 多色块零件用并集算，所以能反映真实轮廓。 */
      fill: Number((cells / bboxArea).toFixed(3)),
      /* 行宽变异系数：0 = 每行一样宽（矩形），越大越不规则 */
      shapeRegularity,
      avgVariance: Number((varSum / Math.max(1, cells)).toFixed(2)),
      cellsIdx: [...allIdx],
    })
  }

  parts.sort((a, b) => b.cells - a.cells)
  parts.forEach((p, i) => { p.partId = 'P' + (i + 1) })

  return {
    parts,
    mergedEdges: mergedEdges.slice(0, 20),
    splitEdges: splitEdges.slice(0, 20),
    edgeCount: edges.length,
  }
}

/**
 * 检测一个零件的形状对称性（基于**轮廓**，不是颜色）。
 *
 * 为什么必须用轮廓：纯色块的左右两侧颜色当然一样，
 * 用颜色比对称度会得到恒等于 1 的结果——那没有意义。
 * 形状是否对称要看「该位置有没有实体」，是二值的。
 *
 * 做法：把零件在包围盒里栅格化成二值掩码（在零件 = 1），
 * 然后与自己镜像后的掩码算 IoU。
 */
export function detectSymmetry(part, g, opts = {}) {
  const { x0, y0, x1, y1 } = part.bbox
  const w = x1 - x0 + 1
  const h = y1 - y0 + 1
  if (w < 3 || h < 3) return { lr: null, tb: null }

  const regionIds = new Set(part.regionIds)
  const label = opts.label
  const inPart = (x, y) => {
    if (x < 0 || y < 0 || x >= g.cols || y >= g.rows) return 0
    const lab = label ? label[y * g.cols + x] : -1
    return lab >= 0 && regionIds.has(lab) ? 1 : 0
  }

  /* 左右镜像 IoU：把 x 映射到 (x1 - (x - x0)) */
  const iou = (mirrorX, mirrorY) => {
    let inter = 0
    let union = 0
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const a = inPart(x, y)
        const mx = mirrorX ? (x1 - (x - x0)) : x
        const my = mirrorY ? (y1 - (y - y0)) : y
        const b = inPart(mx, my)
        if (a && b) inter++
        if (a || b) union++
      }
    }
    return union === 0 ? null : Number((inter / union).toFixed(3))
  }

  /* 如果零件填满整个包围盒（矩形），镜像 IoU 必然是 1，
   * 这种「对称」没有信息量，标记为 null 避免误导。 */
  const isFullRect = part.fill > 0.98
  const lr = iou(true, false)
  const tb = iou(false, true)

  return {
    lr: isFullRect ? null : lr,
    tb: isFullRect ? null : tb,
    /* 形状本身是矩形时，对称是平凡的，不算「对称件」的证据 */
    trivial: isFullRect,
  }
}

/**
 * 测量边缘模糊度：这个零件轮廓的锐利程度。
 *
 * 用途：像素压缩、抗锯齿、失焦都会让边缘变糊。
 * 模糊度高说明**不能照着像素轮廓描**——描出来会是一个毛糙的、抖动的形状，
 * 必须还原成规则几何（直线就是直线、圆就是圆）。
 */
export function measureEdgeBlur(region, g, opts = {}) {
  if (!Array.isArray(region.cellsIdx) || region.cellsIdx.length === 0) return null
  const { cols, rows, samples } = g
  const inRegion = new Set(region.cellsIdx)

  /* 沿边界找「一半在内一半在外」的格子，看两侧色差有多大。
   * 色差大 = 边缘锐利；色差小 = 边缘模糊（渐变过渡）。 */
  let sharp = 0
  let blurred = 0
  const deltas = []

  for (const idx of region.cellsIdx) {
    const y = Math.floor(idx / cols)
    const x = idx % cols
    const o = idx * 3
    const c = [samples[o], samples[o + 1], samples[o + 2]]
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue
      const nidx = ny * cols + nx
      if (inRegion.has(nidx)) continue
      const no = nidx * 3
      const d = colorDistance(c, [samples[no], samples[no + 1], samples[no + 2]])
      deltas.push(d)
      if (d >= (opts.sharpThreshold ?? 80)) sharp++
      else if (d >= 15) blurred++
    }
  }

  if (deltas.length === 0) return null
  const avg = deltas.reduce((s, v) => s + v, 0) / deltas.length
  const sharpRatio = sharp / Math.max(1, sharp + blurred)

  return {
    avgDelta: Number(avg.toFixed(1)),
    sharpRatio: Number(sharpRatio.toFixed(3)),
    samples: deltas.length,
    verdict: sharpRatio > 0.75 ? '边缘锐利' : (sharpRatio > 0.4 ? '边缘中等' : '边缘模糊'),
  }
}

/**
 * 生成零件规划建议。
 *
 * 这是给模型的**判断依据 + 追问**，不是施工单。
 */
export function planParts(grouped, g, opts = {}) {
  const { parts, splitEdges } = grouped
  const total = g.cols * g.rows
  const hints = []

  /* 原图边界在采样网格里的位置。
   * 调用方传入 originIsFullFrame（分析区域是否等于整图）：
   *   - true  → 采样网格的第 0 行/列就是原图边缘，可以据此判断截断
   *   - false → 分析区域是裁剪过的，无法从网格判断截断，一律不报 */
  const fullFrame = opts.originIsFullFrame === true

  for (const p of parts) {
    if (p.areaRatio < 0.002) continue
    const sym = detectSymmetry(p, g, { label: opts.label, byId: opts.byId })
    const item = {
      partId: p.partId,
      hex: p.hex,
      areaRatio: p.areaRatio,
      regionCount: p.regionCount,
      fill: p.fill,
      cells: p.cells,
      bbox: p.bbox,
      bboxPx: p.bboxPx,
      avgVariance: p.avgVariance,
      symmetry: sym,
      questions: [],
    }

    /* 原图边缘截断判断（只在分析区域覆盖整图时有效） */
    const sides = []
    if (fullFrame) {
      if (p.bbox.x0 <= 0) sides.push('左')
      if (p.bbox.y0 <= 0) sides.push('上')
      if (p.bbox.x1 >= g.cols - 1) sides.push('右')
      if (p.bbox.y1 >= g.rows - 1) sides.push('下')
    }
    item.frameTouch = { any: sides.length > 0, sides }

    /* ① 是不是一个 mesh */
    if (p.regionCount === 1) {
      item.meshVerdict = '单个连续色块，真实分件待结构证据确认'
      item.questions.push(
        '同色与轮廓连续不能证明这是单个实体。结合遮挡、接缝、功能和参考判断分件，'
        + '再决定内部是否有需要表现的凹槽或开口；不可仅凭色块数量决定 mesh 数量。')
    } else {
      item.meshVerdict = '由 ' + p.regionCount + ' 个色块组成，需要判断是否同一零件'
      item.questions.push(
        '这个零件在图上由 ' + p.regionCount + ' 个色块组成（色差都不大，所以归为一组）。'
        + '可能是受光变化、涂装、图案或不同零件；先看形体连续性、遮挡和连接证据，再决定合并或拆分。')
    }

    /* ② 形状完整吗 */
    /* 注意 touchesFrame 判断的是**原图**边缘，不是分析区域边缘。
     * 分析区域是裁到主体后的框，主体必然填满它——
     * 用分析区域判断会让每个零件都被误报成「被截断」。
     * 所以这里看 frame 边界（调用方传入原图的边界）。 */
    const frameHit = p.frameTouch || {}
    if (frameHit.any) {
      item.complete = false
      item.questions.push(
        '⚠ 这个零件触到了**原图边缘**（' + frameHit.sides.join('、') + '），'
        + '可能被画幅裁切，也可能本来就延伸到边缘。完整资产任务需参考结构合理补全，'
        + '并标注无法确认的部分；局部重建或固定视角任务按用户范围处理。')
    } else if (p.fill < 0.5) {
      item.complete = 'uncertain'
      item.questions.push(
        '这个零件只填满了自己包围盒的 ' + (p.fill * 100).toFixed(0) + '%，'
        + '说明轮廓不规则，或者中间有空洞/被别的件挡住。'
        + '如果是被遮挡，要推断被挡住的部分是什么形状；'
        + '如果是本身就这个形状（比如 L 形、U 形支架），那没问题。')
    } else {
      item.complete = true
    }

    /* ③ 对称性 */
    if (sym.lr !== null && sym.lr > 0.85) {
      item.questions.push(
        '左右对称度 ' + sym.lr + '（高）——这大概率是个对称件。'
        + '建模时应该做成**严格对称**，不要照抄像素轮廓的微小偏差'
        + '（透视和受光会让对称件在图上看起来不对称）。')
    } else if (sym.lr !== null && sym.lr < 0.6 && p.areaRatio > 0.02) {
      item.questions.push(
        '左右对称度只有 ' + sym.lr + '（低）——要么它本来就不对称，'
        + '要么**有一部分被挡住了**导致看起来不对称。'
        + '先判断是哪种情况再动手。')
    }

    /* ④ 表面是否有细节 */
    if (p.avgVariance > 30) {
      item.questions.push(
        '这个零件内部颜色变化大（方差 ' + p.avgVariance + '），说明表面有结构或图案。'
        + '关键判断：**它是立体结构（该建模）还是平面图案（该用材质）**？'
        + '结合遮挡、高光和厚度判断；图案也可在不同视角持续可见，不能仅凭这一点断定它是几何。')
    }

    hints.push(item)
  }

  /* 分件边界 */
  const splits = splitEdges.slice(0, 8).map((e) => ({
    between: [e.aHex, e.bHex],
    sharedCells: e.shared,
    colorDelta: e.delta,
    think: '这两个零件在图上共边 ' + e.shared + ' 格、色差 ' + e.delta + '。'
      + '可能是分件、涂装或受光边界；只有结构证据支持分件时才做接缝，'
      + '缝宽与深度按真实尺度、工艺和目标视距确定，不使用统一毫米数。',
  }))

  return { parts: hints, splits, partCount: parts.length }
}
