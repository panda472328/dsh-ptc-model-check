/**
 * 自适应标定：从图片自身的统计量推导所有阈值，并诊断图片类型。
 *
 * 为什么必须自适应：
 *   参考图可能是插画、照片、3D 渲染、线稿、像素画、示意图。
 *   它们的信噪比、色彩数量、边缘锐利度差了几个数量级——
 *   写死一套阈值，必然只对某一类图有效，换一类就全错。
 *
 * 所以这里不写常数，改成：
 *   1. 先诊断图片类型（靠统计特征，不靠猜）
 *   2. 再用这张图自己的分布定阈值（直方图分位数 / Otsu）
 *
 * 全部判据都是相对量，任何图都能算出自己的标准。
 */

import { colorDistance, luma } from './color.mjs'

/* ─────────────────────── 图片类型诊断 ─────────────────────── */

/**
 * 诊断图片类型。返回类型 + 依据，供上层选择策略。
 *
 * 判断依据（全部是统计量，不依赖具体内容）：
 *   - 唯一颜色数很少（<64）→ 像素画/扁平插画
 *   - 边缘锐利度高、色彩数少、大面积单色 → 扁平插画/矢量图
 *   - 色彩丰富、边缘过渡多 → 照片/渲染图
 *   - 背景占比极高、前景极少、几乎无填充色 → 线稿/示意图
 */
export function diagnoseImageType(img, opts = {}) {
  const sampleStep = opts.sampleStep ?? Math.max(1, Math.round(Math.max(img.width, img.height) / 400))
  const { width, height, rgb } = img

  /* ① 颜色丰富度：量化后统计唯一颜色数 */
  const colorSet = new Set()
  let sampleCount = 0
  for (let y = 0; y < height; y += sampleStep) {
    for (let x = 0; x < width; x += sampleStep) {
      const i = (y * width + x) * 3
      /* 量化到 5 位一档，避免噪点让唯一色数虚高 */
      colorSet.add(((rgb[i] >> 3) << 10) | ((rgb[i + 1] >> 3) << 5) | (rgb[i + 2] >> 3))
      sampleCount++
    }
  }

  /* ② 边缘统计：相邻像素色差的分布 */
  const deltas = []
  for (let y = 0; y < height; y += sampleStep) {
    for (let x = 0; x < width - 1; x += sampleStep) {
      const i = (y * width + x) * 3
      const j = i + 3
      deltas.push(colorDistance(
        [rgb[i], rgb[i + 1], rgb[i + 2]],
        [rgb[j], rgb[j + 1], rgb[j + 2]],
      ))
    }
  }
  deltas.sort((a, b) => a - b)
  const pct = (p) => deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * p))] || 0
  const edgeHigh = pct(0.95)
  const edgeMid = pct(0.75)

  /* ③ 亮度直方图的峰度：扁平图是双峰（前景+背景），照片是连续分布 */
  const hist = new Array(32).fill(0)
  for (let y = 0; y < height; y += sampleStep) {
    for (let x = 0; x < width; x += sampleStep) {
      const i = (y * width + x) * 3
      const l = luma(rgb[i], rgb[i + 1], rgb[i + 2])
      hist[Math.min(31, Math.floor((l / 256) * 32))]++
    }
  }
  const histTotal = hist.reduce((s, v) => s + v, 0) || 1
  const nonEmptyBins = hist.filter((v) => v / histTotal > 0.002).length

  /* ④ 主导色占比：扁平图的背景往往占 50% 以上 */
  let topColorCount = 0
  for (const c of colorSet) { /* 只用于估算，不需要精确 */ }
  const topBin = Math.max(...hist)
  const dominantLumaShare = topBin / histTotal

  /* 综合判定 */
  const uniqueColors = colorSet.size
  let type = 'render'      // 默认：照片或 3D 渲染
  let reason = ''

  if (uniqueColors < 64) {
    type = 'pixel'
    reason = '量化后只有 ' + uniqueColors + ' 种颜色，是像素画或强量化图'
  } else if (nonEmptyBins <= 6 && dominantLumaShare > 0.35) {
    type = 'flat'
    reason = '亮度只集中在 ' + nonEmptyBins + ' 个区间、单一亮度占比 '
      + (dominantLumaShare * 100).toFixed(0) + '%，是扁平插画/矢量图'
  } else if (edgeHigh < 12 && uniqueColors > 2000) {
    type = 'line'
    reason = '几乎没有高对比边缘（95% 分位仅 ' + edgeHigh.toFixed(1)
      + '）、但颜色数 ' + uniqueColors + '，是低对比图或线稿'
  } else if (uniqueColors > 20000 || edgeMid < 6) {
    type = 'photo'
    reason = '颜色数 ' + uniqueColors + '、边缘过渡平缓，是照片或写实渲染'
  } else {
    type = 'render'
    reason = '颜色数 ' + uniqueColors + '、边缘 95% 分位 ' + edgeHigh.toFixed(1)
      + '，是干净的 3D 渲染或矢量插画'
  }

  return {
    type,
    reason,
    stats: {
      uniqueColors,
      sampleCount,
      edgeP95: Number(edgeHigh.toFixed(2)),
      edgeP75: Number(edgeMid.toFixed(2)),
      lumaBins: nonEmptyBins,
      dominantLumaShare: Number(dominantLumaShare.toFixed(3)),
      sampleStep,
    },
  }
}

/* ─────────────────────── 阈值标定 ─────────────────────── */

/** 计算一组数的分位数。 */
function quantile(sorted, p) {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))
  return sorted[idx]
}

/**
 * Otsu 阈值：给一组值自动找「两类之间的最佳分界」。
 *
 * 用途：边界色差分布里，低的那一类是「同材质受光变化」，高的是「零件交界」。
 * Otsu 找的就是这两类之间的分界——比写死一个数通用得多。
 */
export function otsuThreshold(values, bins = 64) {
  if (values.length === 0) return 0
  let max = 0
  for (const v of values) if (v > max) max = v
  if (max === 0) return 0

  const hist = new Array(bins).fill(0)
  for (const v of values) {
    const b = Math.min(bins - 1, Math.floor((v / max) * bins))
    hist[b]++
  }

  const total = values.length
  let sumAll = 0
  for (let i = 0; i < bins; i++) sumAll += i * hist[i]

  let sumB = 0
  let wB = 0
  let best = 0
  let bestVar = -1
  for (let i = 0; i < bins; i++) {
    wB += hist[i]
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += i * hist[i]
    const mB = sumB / wB
    const mF = (sumAll - sumB) / wF
    const between = wB * wF * (mB - mF) ** 2
    if (between > bestVar) {
      bestVar = between
      best = i
    }
  }
  /* 返回的阈值取这一档的中点，略高于下界��避免把过渡色算成硬边 */
  return ((best + 0.5) / bins) * max
}

/**
 * 从图片统计量标定所有阈值。
 *
 * 不依赖任何具体内容——同一套算法在照片、插画、线稿上都会算出各自的合理值。
 */
export function calibrate(img, diag, opts = {}) {
  const step = diag.stats.sampleStep || 1
  const { width, height, rgb } = img

  /* ① 收集全域相邻色差，用来定「边界强度」的标尺 */
  const deltas = []
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width - 1; x += step) {
      const i = (y * width + x) * 3
      const j = i + 3
      const d = colorDistance(
        [rgb[i], rgb[i + 1], rgb[i + 2]],
        [rgb[j], rgb[j + 1], rgb[j + 2]],
      )
      if (d > 0.5) deltas.push(d)
    }
  }
  deltas.sort((a, b) => a - b)

  const edgeP50 = quantile(deltas, 0.50)
  const edgeP75 = quantile(deltas, 0.75)
  const edgeP95 = quantile(deltas, 0.95)
  const edgeP99 = quantile(deltas, 0.99)

  /* 硬边阈值：用 Otsu 在色差分布上找「同色 vs 异色」的分界。
   * 退化的情形要防：
   *   - 纯色图：分布集中在 0 和极大值两点，Otsu 给出 3（太低）或 423（太高）
   *   - 用 p75 做下限、p95 做上限夹逼，并限制在 [8, 200]
   *     （colorDistance 理论上限约 764，但真实的「硬边」很少超过 200） */
  const otsu = otsuThreshold(deltas)
  const lowerBound = Math.max(edgeP75, 8)
  const upperBound = Math.max(edgeP95, lowerBound + 1)
  const hardEdge = Math.min(200, Math.max(lowerBound, Math.min(upperBound, otsu)))

  /* ② 颜色聚类容差：必须反映「同一种材质的受光变化有多大」。
   *
   * 统计口径很关键：纯色块图里绝大多数相邻像素完全相同（差 0），
   * 少数是硬边界（差 300+）。全图分布的中位数会落在极端值上，不可用。
   *
   * 正确做法：只在**「不是硬边界」的那些相邻对**里取变化量。
   * 这些对代表同材质内部的自然变化（受光、噪点、渐变）。
   * 用它们的 90% 分位作为容差——意思是「95% 的同材质变化都能被容纳」。 */
  const softPairs = deltas.filter((d) => d < hardEdge)
  const intraVariation = softPairs.length
    ? quantile(softPairs, 0.90)
    : 0

  /* 颜色容差 = 同材质变化量的上限 × 1.4（留一点余量），
   * 下限 8（避免纯色图把噪声分开），上限 160（不许大得荒唐）。
   * 纯色图 → 8；扁平插画 → 10~25；照片 → 30~80。 */
  const MAX_COLOR_DIST = 764  // colorDistance 的理论上限
  const colorTolerance = Math.min(160, Math.max(8, intraVariation * 1.4))

  /* ③ 背景容差：取边缘像素颜色的离散程度。
   * 背景越干净容差越小，背景越杂容差越大。 */
  const edgeColors = []
  for (let x = 0; x < width; x += step) {
    let i = x * 3
    edgeColors.push([rgb[i], rgb[i + 1], rgb[i + 2]])
    i = ((height - 1) * width + x) * 3
    edgeColors.push([rgb[i], rgb[i + 1], rgb[i + 2]])
  }
  for (let y = 0; y < height; y += step) {
    let i = (y * width) * 3
    edgeColors.push([rgb[i], rgb[i + 1], rgb[i + 2]])
    i = (y * width + width - 1) * 3
    edgeColors.push([rgb[i], rgb[i + 1], rgb[i + 2]])
  }
  const mean = [0, 0, 0]
  for (const c of edgeColors) {
    mean[0] += c[0]; mean[1] += c[1]; mean[2] += c[2]
  }
  mean[0] /= edgeColors.length; mean[1] /= edgeColors.length; mean[2] /= edgeColors.length
  let varSum = 0
  for (const c of edgeColors) varSum += colorDistance(c, mean) ** 2
  const edgeSd = Math.sqrt(varSum / Math.max(1, edgeColors.length))

  /* 背景容差 = 边缘颜色离散度的 2.5 倍，下限 25、上限 120。
   * 干净白底 → 接近下限；复杂背景 → 接近上限。 */
  const bgTolerance = Math.max(25, Math.min(120, edgeSd * 2.5))

  /* ④ 区域分割容差：比聚类容差略严，因为区域要更精细 */
  const regionTolerance = Math.max(6, colorTolerance * 0.85)

  /* ⑤ 采样精度：按图片短边自适应，保证小图不会过采样。
   * 目标是短边分成 120~400 个采样格。 */
  const shortEdge = Math.min(width, height)
  const detailPx = Math.max(2, Math.round(shortEdge / 200))

  /* ⑥ 布局网格：目标是 20~40 格，让模型能定位又不淹没 */
  const layoutPx = Math.max(8, Math.round(shortEdge / 30))

  return {
    imageType: diag.type,
    typeReason: diag.reason,

    /* 边界判定 */
    hardEdge: Number(hardEdge.toFixed(1)),
    softEdge: Number(edgeP50.toFixed(1)),

    /* 颜色相似判定 */
    colorTolerance: Number(colorTolerance.toFixed(1)),
    regionTolerance: Number(regionTolerance.toFixed(1)),

    /* 背景判定 */
    bgTolerance: Number(bgTolerance.toFixed(1)),
    edgeSd: Number(edgeSd.toFixed(1)),

    /* 采样精度 */
    detailPx,
    layoutPx,

    /* 原始分位，便于调试与说明 */
    percentiles: {
      p50: Number(edgeP50.toFixed(1)),
      p75: Number(edgeP75.toFixed(1)),
      p90: Number(quantile(deltas, 0.90).toFixed(1)),
      p95: Number(edgeP95.toFixed(1)),
      p99: Number(edgeP99.toFixed(1)),
      otsu: Number(otsu.toFixed(1)),
    },
  }
}

/** 一次调用得到诊断 + 标定。 */
export function analyzeImageCharacteristics(img, opts = {}) {
  const diag = diagnoseImageType(img, opts)
  const cal = calibrate(img, diag, opts)
  return { diag, cal }
}
