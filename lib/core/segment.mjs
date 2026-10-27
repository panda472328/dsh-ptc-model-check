/**
 * 区域分割：在细精度下把参考图拆成「结构区域」而不是逐格列表。
 *
 * 为什么需要：5px 精度下 1024 图有 4 万格，逐格列出来没意义。
 * 但 5px 精度真正值钱的地方是——它足够细，能看出**边界在哪**。
 *
 * 所以这个模块做的是：
 *   1. 用 5px 格子扫描全图
 *   2. 把颜色相近的相邻格子合并成**区域**（region）
 *   3. 每个区域给出：颜色、面积、包围盒、边界复杂度
 *   4. 边界复杂度高的区域 = 有倒角/曲面/结构细节；低 = 平面
 *
 * 这正是回答「哪里该做结构、哪里是平的」的依据：
 *   - 边界像素多、颜色过渡多 → 曲面或倒角
 *   - 边界像素少、颜色单一 → 平面
 */

import { colorDistance, classifyColor, toHex, luma } from './color.mjs'

/**
 * 把图按 cellPx 采样成细网格。
 */
export function sampleGrid(img, region, cellPx, opts = {}) {
  const { width, rgb } = img
  const mask = opts.mask || null
  const maskW = region.x1 - region.x0 + 1
  const cols = Math.max(1, Math.round((region.x1 - region.x0 + 1) / cellPx))
  const rows = Math.max(1, Math.round((region.y1 - region.y0 + 1) / cellPx))
  const cellW = (region.x1 - region.x0 + 1) / cols
  const cellH = (region.y1 - region.y0 + 1) / rows

  const samples = new Float32Array(cols * rows * 3)
  const excluded = new Uint8Array(cols * rows)

  for (let ry = 0; ry < rows; ry++) {
    for (let rx = 0; rx < cols; rx++) {
      const x0 = Math.floor(region.x0 + rx * cellW)
      const x1 = Math.max(x0 + 1, Math.floor(region.x0 + (rx + 1) * cellW))
      const y0 = Math.floor(region.y0 + ry * cellH)
      const y1 = Math.max(y0 + 1, Math.floor(region.y0 + (ry + 1) * cellH))
      let sr = 0, sg = 0, sb = 0, n = 0, bg = 0
      for (let y = y0; y < y1 && y <= region.y1; y++) {
        for (let x = x0; x < x1 && x <= region.x1; x++) {
          const i = (y * width + x) * 3
          sr += rgb[i]; sg += rgb[i + 1]; sb += rgb[i + 2]
          n++
          if (mask) {
            const mi = (y - region.y0) * maskW + (x - region.x0)
            if (mi >= 0 && mi < mask.length && mask[mi] === 0) bg++
          }
        }
      }
      const o = (ry * cols + rx) * 3
      if (n === 0) { samples[o] = 0; samples[o + 1] = 0; samples[o + 2] = 0; continue }
      samples[o] = sr / n
      samples[o + 1] = sg / n
      samples[o + 2] = sb / n
      /* 用格子中心点判定是否属于主体。
       * 用「格内超过 70% 是背景」的判据会把边界格子留下，
       * 导致形状被填成矩形（fill 恒为 1）——形状信息就丢了。 */
      if (mask) {
        const cxp = Math.min(region.x1, Math.floor((x0 + x1) / 2))
        const cyp = Math.min(region.y1, Math.floor((y0 + y1) / 2))
        const mi = (cyp - region.y0) * maskW + (cxp - region.x0)
        if (mi >= 0 && mi < mask.length && mask[mi] === 0) excluded[ry * cols + rx] = 1
      }
    }
  }

  /* 同时算每格的局部方差：方差大 = 该格内部有细节（边、纹理、文字） */
  const variance = new Float32Array(cols * rows)
  for (let ry = 0; ry < rows; ry++) {
    for (let rx = 0; rx < cols; rx++) {
      const x0 = Math.floor(region.x0 + rx * cellW)
      const x1 = Math.max(x0 + 1, Math.floor(region.x0 + (rx + 1) * cellW))
      const y0 = Math.floor(region.y0 + ry * cellH)
      const y1 = Math.max(y0 + 1, Math.floor(region.y0 + (ry + 1) * cellH))
      const o = (ry * cols + rx) * 3
      const mr = samples[o], mg = samples[o + 1], mb = samples[o + 2]
      let sum = 0, n = 0
      for (let y = y0; y < y1 && y <= region.y1; y++) {
        for (let x = x0; x < x1 && x <= region.x1; x++) {
          const i = (y * width + x) * 3
          const dr = rgb[i] - mr
          const dg = rgb[i + 1] - mg
          const db = rgb[i + 2] - mb
          sum += dr * dr + dg * dg + db * db
          n++
        }
      }
      variance[ry * cols + rx] = n === 0 ? 0 : Math.sqrt(sum / n)
    }
  }

  return { cols, rows, cellW, cellH, samples, variance, excluded }
}

/**
 * 把相邻同色格子合并成区域（洪水填充，4 邻接）。
 *
 * `g.excluded` 标记为 1 的格子（背景）会被直接跳过，不参与分割。
 *
 * @param {{cols,rows,samples,variance,excluded}} g
 * @param {number} tolerance 颜色容差
 * @returns {Array<{id,col,color,hex,cells,bbox,area,variance,edgeDensity}>}
 */
export function segmentRegions(g, tolerance = 40) {
  const { cols, rows, samples, variance } = g
  const excluded = g.excluded || null
  const n = cols * rows
  const label = new Int32Array(n).fill(-1)
  const regions = []

  const colorAt = (idx) => [samples[idx * 3], samples[idx * 3 + 1], samples[idx * 3 + 2]]

  for (let start = 0; start < n; start++) {
    if (label[start] >= 0) continue
    if (excluded && excluded[start]) continue
    const rid = regions.length
    const seed = colorAt(start)
    const stack = [start]
    label[start] = rid
    const cells = []
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    let varSum = 0

    while (stack.length) {
      const idx = stack.pop()
      const cy = Math.floor(idx / cols)
      const cx = idx % cols
      cells.push(idx)
      if (cx < x0) x0 = cx
      if (cx > x1) x1 = cx
      if (cy < y0) y0 = cy
      if (cy > y1) y1 = cy
      varSum += variance[idx]

      const nb = []
      if (cx > 0) nb.push(idx - 1)
      if (cx < cols - 1) nb.push(idx + 1)
      if (cy > 0) nb.push(idx - cols)
      if (cy < rows - 1) nb.push(idx + cols)

      for (const k of nb) {
        if (label[k] >= 0) continue
        if (excluded && excluded[k]) continue
        if (colorDistance(colorAt(k), seed) > tolerance) continue
        label[k] = rid
        stack.push(k)
      }
    }

    /* 区域平均色 */
    let sr = 0, sg = 0, sb = 0
    for (const idx of cells) {
      const o = idx * 3
      sr += samples[o]; sg += samples[o + 1]; sb += samples[o + 2]
    }
    const c = [sr / cells.length, sg / cells.length, sb / cells.length]

    /* 边界密度：区域周长 / 面积平方根。
     * 圆盘接近 3.5，长条更高，不规则形状更高。
     * 边界密度高通常意味着这个区域形状复杂（有缺口、有分叉）。 */
    const area = cells.length
    const inRegion = new Set(cells)
    let perimeter = 0
    for (const idx of cells) {
      const cy = Math.floor(idx / cols)
      const cx = idx % cols
      if (cx === 0 || !inRegion.has(idx - 1)) perimeter++
      if (cx === cols - 1 || !inRegion.has(idx + 1)) perimeter++
      if (cy === 0 || !inRegion.has(idx - cols)) perimeter++
      if (cy === rows - 1 || !inRegion.has(idx + cols)) perimeter++
    }

    regions.push({
      id: rid,
      color: c,
      hex: toHex(c[0], c[1], c[2]),
      rgb: c.map((v) => Math.round(v)),
      luma: Math.round(luma(c[0], c[1], c[2])),
      kind: classifyColor(c),
      cells: area,
      /* 索引保留下来给相邻分析用；对外输出时会被剥掉 */
      cellsIdx: cells,
      bbox: { x0, y0, x1, y1 },
      avgVariance: Number((varSum / area).toFixed(2)),
      perimeter,
      edgeDensity: Number((perimeter / Math.sqrt(area)).toFixed(2)),
    })
  }

  regions.sort((a, b) => b.cells - a.cells)
  return regions
}

/**
 * 从区域数据推断「这里该做什么结构」。
 *
 * 这是给模型**引导**用的，不是约束——每一条都是「建议考虑」，不是「必须做」。
 *
 * 判据：
 *   - 大面积 + 低方差 + 低边界密度 → 平面，可直接用平面
 *   - 大面积 + 高方差 → 表面有纹理/图案，考虑贴图或凹凸
 *   - 小面积 + 高边界密度 → 细长/复杂轮廓，可能是倒角、筋、缝
 *   - 相邻两区域颜色跳变大 → 分件边界，该做分缝
 *   - 区域间颜色渐变（中间有中间色）→ 曲面，该做圆角
 */
export function inferStructure(regions, g, opts = {}) {
  const hints = []
  const totalCells = g.cols * g.rows
  const bigThreshold = totalCells * 0.05

  for (const r of regions) {
    const areaRatio = r.cells / totalCells
    if (areaRatio < 0.002) continue  // 太小的碎片不提示

    /* 平面特征：面积大、内部均匀、轮廓简单 */
    if (r.cells >= bigThreshold && r.avgVariance < 12 && r.edgeDensity < 8) {
      hints.push({
        region: r.id,
        hex: r.hex,
        area: Number(areaRatio.toFixed(4)),
        readsAs: '平面',
        think:
          '这块面积大、内部颜色均匀、轮廓规整。'
          + '但**平的也要想清楚该不该真的做成一个平面**：'
          + '是承重面、装饰面、还是贴装面？边缘要不要倒角？'
          + '大面积平板在渲染时最容易显得廉价，通常会加轻微起伏或边缘处理。',
      })
      continue
    }

    /* 曲面/起伏特征：面积大但内部有渐变（方差中等） */
    if (r.cells >= bigThreshold && r.avgVariance >= 12 && r.avgVariance < 40) {
      hints.push({
        region: r.id,
        hex: r.hex,
        area: Number(areaRatio.toFixed(4)),
        readsAs: '有起伏的表面',
        think:
          '这块面积不小，但内部颜色有渐变，说明表面不是纯平的——'
          + '可能是圆角过渡、曲面、或斜面。考虑这里是否该做实体倒角或弧形。',
      })
      continue
    }

    /* 高方差：有纹理/图案/细节 */
    if (r.avgVariance >= 40) {
      hints.push({
        region: r.id,
        hex: r.hex,
        area: Number(areaRatio.toFixed(4)),
        readsAs: '有细节的表面',
        think:
          '这块内部颜色变化剧烈，说明有纹理、图案、文字或密集结构。'
          + '考虑：是凹凸结构（该建模）还是表面图案（该用材质）？'
          + '如果能看出规律（比如等距的条纹），那通常是结构，值得做出来。',
      })
      continue
    }

    /* 细长/复杂轮廓的小区域：可能是筋、缝、装饰条 */
    if (r.edgeDensity > 12 && areaRatio >= 0.002) {
      hints.push({
        region: r.id,
        hex: r.hex,
        area: Number(areaRatio.toFixed(4)),
        readsAs: '细长或复杂轮廓',
        think:
          '这块轮廓复杂或细长，常见于：分缝线、加强筋、装饰条、倒角带。'
          + '这类结构往往是「让模型看起来像成品」的关键，'
          + '不做的话整体会显得是一块糊在一起的粗模。',
      })
    }
  }

  /* 相邻区域色差大 → 分件边界 */
  const adj = findRegionBoundaries(regions, g, opts.tolerance ?? 40)
  for (const p of adj.slice(0, 12)) {
    hints.push({
      between: [p.a.hex, p.b.hex],
      hex: p.a.hex + ' ↔ ' + p.b.hex,
      readsAs: '分件边界',
      think:
        '这两个区域颜色差别明显（' + p.delta.toFixed(0) + '），且相邻 ' + p.count + ' 处。'
        + '通常意味着这是**两个零件**的交界：考虑做一道分缝（内凹 0.2~0.5mm），'
        + '而不是让它们在同一块几何上只是颜色不同。'
        + '分缝是装配感的主要来源。',
    })
  }

  return hints
}

/** 找出相邻且色差大的区域对。 */
function _unused() {}

/**
 * 相邻区域分析：找出共边且色差大的区域对。
 */
export function findRegionBoundaries(regions, g, tolerance) {
  const { cols, rows } = g
  const pairs = new Map()
  const withIdx = regions.filter((r) => Array.isArray(r.cellsIdx))
  if (withIdx.length === 0) return []

  const label = new Int32Array(cols * rows).fill(-1)
  for (const r of withIdx) {
    for (const idx of r.cellsIdx) label[idx] = r.id
  }

  const byId = new Map(withIdx.map((r) => [r.id, r]))
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const idx = y * cols + x
      const la = label[idx]
      if (la < 0) continue
      const right = x < cols - 1 ? label[idx + 1] : -1
      const down = y < rows - 1 ? label[idx + cols] : -1
      for (const lb of [right, down]) {
        if (lb < 0 || lb === la) continue
        const key = la < lb ? la + ':' + lb : lb + ':' + la
        const a = byId.get(la)
        const b = byId.get(lb)
        if (!a || !b) continue
        const cur = pairs.get(key) || { a, b, count: 0, delta: 0 }
        cur.count++
        cur.delta = colorDistance(a.color, b.color)
        pairs.set(key, cur)
      }
    }
  }

  return [...pairs.values()]
    .filter((p) => p.count >= 2 && p.delta > tolerance)
    .sort((x, y) => y.count - x.delta)
}
