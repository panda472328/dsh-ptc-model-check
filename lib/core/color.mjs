/**
 * 参考图颜色分析：把一张图拆成可对照的颜色数据。
 *
 * 为什么需要：模型看图只能「有个印象」，说不出「这块是什么颜色、占多大面积」。
 * 但建模需要的恰恰是这些可量化的东西——占比最高的颜色，就是模型上面积最大的部分，
 * 也就是最该先做对的地方。
 *
 * 输出三类数据：
 *   1. 颜色聚类：这张图主要由哪几种颜色组成，各自占多少面积（按占比降序）
 *   2. 网格分区：切成 N×M 块，每块的主色与占比（用来定位「哪个区域是什么色」）
 *   3. 建议：按占比排出的「先做哪个」顺序
 *
 * 全部基于已有的 PNG 解码器，不引入新依赖。
 */

import { inflateSync } from 'node:zlib'
import { detectSubject } from './subject.mjs'
import { sampleGrid, segmentRegions, inferStructure } from './segment.mjs'
import {
  buildAdjacency, groupIntoParts, planParts, measureEdgeBlur,
} from './planning.mjs'
import { analyzeImageCharacteristics } from './adaptive.mjs'

/* ─────────────────────────── RGB 解码 ─────────────────────────── */

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * 解码 PNG 成 RGB 平面（不做灰度化）。
 *
 * 与 png.mjs 的 decodePngGray 不同：这里保留彩色信息，
 * 因为颜色对照必须知道 R/G/B 各是多少。
 */
export function decodePngRgb(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error('不是 PNG 文件')
  }

  let off = 8
  let ihdr = null
  const idat = []
  let palette = null
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') ihdr = data
    else if (type === 'PLTE') palette = data
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += len + 12
  }
  if (!ihdr) throw new Error('PNG 缺少 IHDR')

  const width = ihdr.readUInt32BE(0)
  const height = ihdr.readUInt32BE(4)
  const bitDepth = ihdr[8]
  const colorType = ihdr[9]
  const interlace = ihdr[12]
  if (bitDepth !== 8) throw new Error('只支持 8 位深 PNG（实际 ' + bitDepth + '）')
  if (interlace !== 0) throw new Error('不支持隔行 PNG')

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  if (!channels) throw new Error('不支持的颜色类型 ' + colorType)

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = new Uint8Array(width * height * channels)
  let pos = 0
  let prev = new Uint8Array(stride)

  const paeth = (a, b, c) => {
    const p = a + b - c
    const pa = Math.abs(p - a)
    const pb = Math.abs(p - b)
    const pc = Math.abs(p - c)
    if (pa <= pb && pa <= pc) return a
    return pb <= pc ? b : c
  }

  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]
    const line = raw.subarray(pos, pos + stride)
    pos += stride
    const cur = new Uint8Array(stride)
    for (let x = 0; x < stride; x++) {
      const b = line[x]
      const left = x >= channels ? cur[x - channels] : 0
      const up = prev[x]
      const upLeft = x >= channels ? prev[x - channels] : 0
      let v
      switch (filter) {
        case 0: v = b; break
        case 1: v = b + left; break
        case 2: v = b + up; break
        case 3: v = b + ((left + up) >> 1); break
        case 4: v = b + paeth(left, up, upLeft); break
        default: throw new Error('未知滤波类型 ' + filter)
      }
      cur[x] = v & 0xff
    }
    out.set(cur, y * stride)
    prev = cur
  }

  // 统一成 RGB 三元组
  const rgb = new Uint8Array(width * height * 3)
  for (let i = 0; i < width * height; i++) {
    const base = i * channels
    let r, g, b
    if (colorType === 0 || colorType === 4) {
      r = g = b = out[base]
    } else if (colorType === 3) {
      const idx = out[base]
      if (palette && idx * 3 + 2 < palette.length) {
        r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2]
      } else {
        r = g = b = idx
      }
    } else {
      r = out[base]; g = out[base + 1]; b = out[base + 2]
    }
    rgb[i * 3] = r
    rgb[i * 3 + 1] = g
    rgb[i * 3 + 2] = b
  }

  return { width, height, rgb }
}

/* ─────────────────────────── 颜色工具 ─────────────────────────── */

export function toHex(r, g, b) {
  const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return '#' + h(r) + h(g) + h(b)
}

/** 感知亮度 0~255 */
export function luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b
}

/** 颜色距离（加权欧氏，接近人眼感知） */
export function colorDistance(a, b) {
  const rm = (a[0] + b[0]) / 2
  const dr = a[0] - b[0]
  const dg = a[1] - b[1]
  const db = a[2] - b[2]
  return Math.sqrt(
    (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db,
  )
}

/**
 * 颜色聚类：用简单的贪心分桶代替 k-means。
 *
 * 为什么不用 k-means：参考图通常只有几种主色（塑料件、金属件、背景），
 * 贪心分桶已经够准，而且结果稳定、跑得快、可复现。
 * 建模要的是「这块大概什么色」，不需要亚像素级精度。
 *
 * @param {{width:number,height:number,rgb:Uint8Array}} img
 * @param {object} opts
 * @returns {{clusters:Array, total:number}}
 */
export function clusterColors(img, opts = {}) {
  const tolerance = opts.tolerance ?? 48      // 两个颜色差多少算同一类
  const maxClusters = opts.maxClusters ?? 12  // 最多分几类
  const sampleStep = opts.sampleStep ?? 1     // 采样步长（大图可跳点）
  /* mask：1 = 计入，0 = 跳过（背景）。用于排除主体框内的背景像素。 */
  const mask = opts.mask || null

  const { width, height, rgb } = img

  /* 量化到 16 级一档，先粗分桶，避免每个像素都参与距离计算。
   * 16 级意味着每档 16 个色值，视觉上差异很小。 */
  const buckets = new Map()
  for (let y = 0; y < height; y += sampleStep) {
    for (let x = 0; x < width; x += sampleStep) {
      const px = y * width + x
      if (mask && mask[px] === 0) continue
      const i = px * 3
      const r = rgb[i]
      const g = rgb[i + 1]
      const b = rgb[i + 2]
      const key = (r >> 4) << 8 | (g >> 4) << 4 | (b >> 4)
      let bk = buckets.get(key)
      if (!bk) {
        bk = { r: 0, g: 0, b: 0, n: 0 }
        buckets.set(key, bk)
      }
      bk.r += r
      bk.g += g
      bk.b += b
      bk.n++
    }
  }

  /* 每个桶算出平均色，再按像素数降序 */
  let entries = [...buckets.values()]
    .map((v) => ({ color: [v.r / v.n, v.g / v.n, v.b / v.n], count: v.n }))
    .sort((a, b) => b.count - a.count)

  /* 贪心合并：把相近的颜色并到已有聚类 */
  const clusters = []
  for (const e of entries) {
    let merged = false
    for (const c of clusters) {
      if (colorDistance(c.color, e.color) <= tolerance) {
        const n = c.count + e.count
        c.color = [
          (c.color[0] * c.count + e.color[0] * e.count) / n,
          (c.color[1] * c.count + e.color[1] * e.count) / n,
          (c.color[2] * c.count + e.color[2] * e.count) / n,
        ]
        c.count = n
        merged = true
        break
      }
    }
    if (!merged) clusters.push({ color: e.color.slice(), count: e.count })
    if (clusters.length >= maxClusters * 2) break
  }

  clusters.sort((a, b) => b.count - a.count)
  const kept = clusters.slice(0, maxClusters)
  const total = kept.reduce((s, c) => s + c.count, 0) || 1

  return {
    clusters: kept.map((c, i) => ({
      rank: i + 1,
      hex: toHex(c.color[0], c.color[1], c.color[2]),
      rgb: c.color.map((v) => Math.round(v)),
      pixels: c.count,
      ratio: Number((c.count / total).toFixed(4)),
      luma: Math.round(luma(c.color[0], c.color[1], c.color[2])),
      /* 粗分类：帮助模型判断「这块该用什么材质」 */
      kind: classifyColor(c.color),
    })),
    total,
  }
}

/** 按颜色猜材质倾向（只是提示，不是结论）。 */
export function classifyColor([r, g, b]) {
  const l = luma(r, g, b)
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  const sat = mx === 0 ? 0 : (mx - mn) / mx

  if (sat < 0.1) {
    if (l < 45) return '近黑（可能是深色塑料/阴影）'
    if (l > 225) return '近白（可能是高光/背景）'
    return '中灰（可能是金属中性色）'
  }
  if (l < 40) return '深色有彩（深色涂装）'
  if (g > r && g > b) return '偏绿'
  if (b > r && b > g) return '偏蓝'
  if (r > g && r > b) {
    if (g > b * 1.6) return '偏橙/黄（可能是铜/木/警示色）'
    return '偏红'
  }
  return '其它'
}

/**
 * 把图切成网格，每格给出主色。
 *
 * 用途：模型可以按「左上角第三格是深灰」这种方式定位细节，
 * 比「整体看图」精确得多。
 */
export function gridColors(img, cols = 6, rows = 6) {
  const { width, height, rgb } = img
  const cells = []
  const cw = width / cols
  const ch = height / rows

  for (let ry = 0; ry < rows; ry++) {
    for (let rx = 0; rx < cols; rx++) {
      const x0 = Math.floor(rx * cw)
      const x1 = Math.floor((rx + 1) * cw)
      const y0 = Math.floor(ry * ch)
      const y1 = Math.floor((ry + 1) * ch)
      let sr = 0, sg = 0, sb = 0, n = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 3
          sr += rgb[i]; sg += rgb[i + 1]; sb += rgb[i + 2]
          n++
        }
      }
      if (n === 0) continue
      const c = [sr / n, sg / n, sb / n]
      cells.push({
        row: ry,
        col: rx,
        /* 行列描述，模型可以说「第 2 行第 3 格」 */
        position: '第' + (ry + 1) + '行第' + (rx + 1) + '列',
        hex: toHex(c[0], c[1], c[2]),
        rgb: c.map((v) => Math.round(v)),
        luma: Math.round(luma(c[0], c[1], c[2])),
        kind: classifyColor(c),
      })
    }
  }
  return { cols, rows, cells }
}

/**
 * 完整分析：主体识别 + 聚类 + 自适应像素网格。
 *
 * 网格密度按「1K 图至少 50px 一格」这一硬要求推出来：
 *   边长 1024 的图 → 每格 50px → 20×20 = 400 格
 *   边长 512 的图  → 每格 50px → 10×10 = 100 格
 *   边长 2048 的图 → 每格 50px → 40×40 = 1600 格（上限，否则输出太长）
 *
 * 用户指定 cellPx 就按用户的，否则按上面的规则自动算。
 *
 * @param {Buffer} buf PNG 字节
 * @param {object} opts
 * @param {number} [opts.cellPx] 每格多少像素（默认自适应到 ~50）
 * @param {number} [opts.maxCells] 格子数上限（默认 1600，防输出爆炸）
 * @param {boolean} [opts.cropToSubject] 是否只分析主体区域（默认 true）
 */
export function analyzeReference(buf, opts = {}) {
  const t0 = Date.now()
  const img = decodePngRgb(buf)

  /* ① 主体识别 */
  const subject = opts.skipSubject
    ? {
      bbox: { x0: 0, y0: 0, x1: img.width - 1, y1: img.height - 1 },
      width: img.width, height: img.height, coverage: 1,
      background: { hex: '#000000', rgb: [0, 0, 0], ratio: 0 },
      confidence: 'skipped', fallback: true, reason: '调用方跳过了主体识别',
    }
    : detectSubject(img, opts)

  /* ② 决定分析区域：只分析主体，避免把背景算进颜色占比 */
  const cropToSubject = opts.cropToSubject !== false && !subject.fallback
  const region = cropToSubject
    ? {
      x0: subject.bbox.x0,
      y0: subject.bbox.y0,
      x1: subject.bbox.x1,
      y1: subject.bbox.y1,
    }
    : { x0: 0, y0: 0, x1: img.width - 1, y1: img.height - 1 }

  const regionW = region.x1 - region.x0 + 1
  const regionH = region.y1 - region.y0 + 1

  /* ③ 自适应标定：所有阈值从这张图自己的统计量推出来。
   *
   * 这是「全品类通用」的关键。参考图可能是插画、照片、3D 渲染、线稿；
   * 写死一套阈值必然只对某一类有效。所以这里先诊断类型、再定阈值：
   *   - 纯色图 → 颜色容差 8，硬边阈值 8
   *   - 渲染图 → 颜色容差 68，硬边阈值 89
   *   - 复杂图 → 颜色容差 120，硬边阈值 200
   * 全部是相对量，任何图都能算出自己的标准。 */
  const characteristics = analyzeImageCharacteristics(img)
  const cal = characteristics.cal

  /* 采样精度：优先用标定值（按短边自适应），调用方可覆盖。
   *
   * 细采样（detailPx）的用途是区域分割——在这个精度上合并同色区域、
   * 算边界复杂度，从而推断哪里该做结构。
   * 布局网格（layoutPx）的用途是「第几行第几列是什么色」的定位。 */
  const detailPx = opts.detailPx ?? cal.detailPx
  const targetCell = opts.cellPx ?? cal.layoutPx
  const maxCells = opts.maxCells ?? 1600
  let cols = Math.max(1, Math.round(regionW / targetCell))
  let rows = Math.max(1, Math.round(regionH / targetCell))
  /* 超过上限就等比压缩（这时会牺牲一点密度，但保证输出可控） */
  while (cols * rows > maxCells) {
    cols = Math.max(1, Math.floor(cols * 0.9))
    rows = Math.max(1, Math.floor(rows * 0.9))
  }
  const cellW = regionW / cols
  const cellH = regionH / rows

  /* ④ 只对主体区域做颜色聚类。
   * 但主体框内仍然会包含背景像素（框是矩形，形状不是），
   * 所以要把接近背景色的像素排除掉，否则白底会被当成「零件」。 */
  const cropped = cropImage(img, region)
  /* 背景掩码用标定出的背景容差，而不是写死的值——
   * 干净白底和复杂背景需要完全不同的宽容度。 */
  const mask = subject.fallback
    ? null
    : buildSubjectMask(img, region, subject.background.rgb, cal.bgTolerance)
  const cluster = clusterColors(cropped, {
    ...opts,
    mask,
    tolerance: opts.tolerance ?? cal.colorTolerance,
  })

  /* ⑤ 布局网格（粗精度，给模型定位用） */
  const grid = gridColorsRegion(img, region, cols, rows)

  /* ⑥ 细精度区域分割：这是「哪里该做结构」的依据。
   * 传 mask 排除背景格，否则白底会被当成一个面积很大的零件。
   * 容差用标定值——纯色图 6.8、渲染图 57.9，各自合适。 */
  const detail = sampleGrid(img, region, detailPx, { mask })
  const regionTol = opts.regionTolerance ?? cal.regionTolerance
  const regions = segmentRegions(detail, regionTol)

  /* 结构推断用标定出的边界强度标尺，不写死 12/40 */
  const structureHints = inferStructure(regions, detail, {
    ...opts,
    edgeScale: cal.hardEdge,
  })

  /* ⑦ 零件规划：哪些色块属于同一个零件、形状是否完整、轮廓能否照抄。
   * 合并容差用标定出的「同材质变化上限」，色差超过它的不合并。 */
  const grouped = groupIntoParts(regions, detail, {
    ...opts,
    mergeTolerance: opts.mergeTolerance ?? cal.colorTolerance,
  })
  const adj = buildAdjacency(regions, detail, opts)
  /* 分析区域是否覆盖整图——决定能不能判断「零件被原图边缘截断」。
   * 裁剪到主体时，主体必然填满区域，用它判断截断会全是误报。 */
  const originIsFullFrame = region.x0 === 0 && region.y0 === 0
    && region.x1 === img.width - 1 && region.y1 === img.height - 1
  const plan = planParts(grouped, detail, {
    label: adj.label,
    byId: adj.byId,
    originIsFullFrame,
    ...opts,
  })

  /* 每个零件的轮廓锐利度：模糊度高就不能照抄像素轮廓 */
  for (const item of plan.parts) {
    const p = grouped.parts.find((x) => x.partId === item.partId)
    if (!p) continue
    const mainRegion = regions.find((r) => r.id === p.regionIds[0])
    if (!mainRegion) continue
    const blur = measureEdgeBlur(mainRegion, detail, opts)
    if (!blur) continue
    item.edgeBlur = blur
    if (blur.sharpRatio < 0.5 && item.areaRatio > 0.005) {
      item.questions.push(
        '这个零件的轮廓' + blur.verdict + '（锐利度 ' + blur.sharpRatio + '）。'
        + '**不要照着像素轮廓描**——图片有压缩和抗锯齿，描出来会是毛糙抖动的形状。'
        + '应该还原成规则几何：直线就是直线、圆就是圆、对称就是对称。')
    }
  }

  /* 对外输出时剥掉 cellsIdx（那是内部用的索引表，很长） */
  const regionsOut = regions.slice(0, 40).map((r) => ({
    id: r.id,
    hex: r.hex,
    rgb: r.rgb,
    kind: r.kind,
    cells: r.cells,
    areaRatio: Number((r.cells / (detail.cols * detail.rows)).toFixed(4)),
    bbox: r.bbox,
    avgVariance: r.avgVariance,
    edgeDensity: r.edgeDensity,
  }))

  /* ⑦ 制作顺序：按占比降序，附加「哪些格子是这个颜色」便于定位 */
  const buildOrder = cluster.clusters
    .filter((c) => c.ratio >= 0.01)
    .map((c) => {
      const cellsOfColor = grid.cells
        .filter((g) => colorDistance(g.rgb, c.rgb) <= cal.colorTolerance)
        .slice(0, 20)
        .map((g) => g.position)
      return {
        order: c.rank,
        hex: c.hex,
        ratio: c.ratio,
        hint: c.kind,
        foundIn: cellsOfColor,
        cellCount: cellsOfColor.length,
      }
    })

  return {
    width: img.width,
    height: img.height,
    /* 自适应标定结果：图片类型 + 从本图统计量推出的所有阈值。
     * 上层用它解释「为什么这张图的判定标准和别的不一样」。 */
    imageType: characteristics.diag.type,
    imageTypeReason: characteristics.diag.reason,
    calibration: cal,
    imageStats: characteristics.diag.stats,
    subject,
    region,
    regionSize: { width: regionW, height: regionH },
    gridSize: { cols, rows, cellPx: Math.round(cellW), cellPxY: Math.round(cellH) },
    detailSize: {
      cellPx: detailPx,
      cols: detail.cols,
      rows: detail.rows,
      totalCells: detail.cols * detail.rows,
    },
    cluster: cluster.clusters,
    grid,
    regions: regionsOut,
    regionCount: regions.length,
    structureHints,
    /* 零件规划：哪些色块是一个零件、形状是否完整、能否照抄轮廓 */
    parts: plan.parts,
    partCount: plan.partCount,
    partSplits: plan.splits,
    buildOrder,
    ms: Date.now() - t0,
  }
}

/**
 * 生成主体掩码：区域里哪些像素是主体（1），哪些是背景（0）。
 *
 * 用途：颜色聚类时排除背景。主体框是矩形，但形状往往不是矩形，
 * 框内的背景像素如果参与聚类，会被当成「一个面积很大的零件」。
 */
export function buildSubjectMask(img, region, bgRgb, tolerance = 45) {
  const { width, rgb } = img
  const w = region.x1 - region.x0 + 1
  const h = region.y1 - region.y0 + 1
  const mask = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const srcY = region.y0 + y
    for (let x = 0; x < w; x++) {
      const src = (srcY * width + (region.x0 + x)) * 3
      const dr = rgb[src] - bgRgb[0]
      const dg = rgb[src + 1] - bgRgb[1]
      const db = rgb[src + 2] - bgRgb[2]
      const isBg = dr * dr + dg * dg + db * db <= tolerance * tolerance
      mask[y * w + x] = isBg ? 0 : 1
    }
  }
  return mask
}

/** 按矩形区域截取图像。 */
export function cropImage(img, region) {
  const { width, rgb } = img
  const w = region.x1 - region.x0 + 1
  const h = region.y1 - region.y0 + 1
  const out = new Uint8Array(w * h * 3)
  for (let y = 0; y < h; y++) {
    const srcY = region.y0 + y
    for (let x = 0; x < w; x++) {
      const src = (srcY * width + (region.x0 + x)) * 3
      const dst = (y * w + x) * 3
      out[dst] = rgb[src]
      out[dst + 1] = rgb[src + 1]
      out[dst + 2] = rgb[src + 2]
    }
  }
  return { width: w, height: h, rgb: out }
}

/** 在指定区域内切网格（坐标是原图坐标，便于对照）。 */
export function gridColorsRegion(img, region, cols, rows) {
  const { width, rgb } = img
  const cells = []
  const cw = (region.x1 - region.x0 + 1) / cols
  const ch = (region.y1 - region.y0 + 1) / rows

  for (let ry = 0; ry < rows; ry++) {
    for (let rx = 0; rx < cols; rx++) {
      const x0 = Math.floor(region.x0 + rx * cw)
      const x1 = Math.floor(region.x0 + (rx + 1) * cw)
      const y0 = Math.floor(region.y0 + ry * ch)
      const y1 = Math.floor(region.y0 + (ry + 1) * ch)
      let sr = 0, sg = 0, sb = 0, n = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 3
          sr += rgb[i]; sg += rgb[i + 1]; sb += rgb[i + 2]
          n++
        }
      }
      if (n === 0) continue
      const c = [sr / n, sg / n, sb / n]
      cells.push({
        row: ry,
        col: rx,
        position: '第' + (ry + 1) + '行第' + (rx + 1) + '列',
        /* 原图坐标，便于精确对照 */
        px: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
        hex: toHex(c[0], c[1], c[2]),
        rgb: c.map((v) => Math.round(v)),
        luma: Math.round(luma(c[0], c[1], c[2])),
        kind: classifyColor(c),
      })
    }
  }
  return { cols, rows, cells, cellPx: Math.round(cw), cellPxY: Math.round(ch) }
}
