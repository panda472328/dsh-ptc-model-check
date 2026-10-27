/**
 * 主体识别：从参考图里找出「要建模的东西」占据了哪一块。
 *
 * 为什么必须先做这一步：
 *   参考图通常有背景（纯色、渐变、场景照片）。如果直接对整张图做像素网格，
 *   大部分格子都会落在背景上，真正要建模的主体只占少数格子——
 *   等于把分析预算浪费在背景上。
 *
 * 做法（启发式，不依赖 AI）：
 *   1. 统计四边像素，取主导色作为「背景色」
 *   2. 从四边向内做洪水填充，标出与背景色连通的区域
 *   3. 剩下的连通域就是前景（主体）
 *   4. 取最大的前景连通域作为主体，给出它的包围盒
 *
 * 边界：背景是复杂场景照片时可能失效。这时退回「整图都是主体」，
 * 并在返回里标记 confidence 低，让模型自己判断。
 */

/* 本模块刻意不 import color.mjs：color.mjs 要 import 本模块的主体识别，
 * 互相 import 会形成循环依赖。所以这里自带几个小工具函数。 */

function toHex(r, g, b) {
  const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return '#' + h(r) + h(g) + h(b)
}

/**
 * 猜测背景色：取四条边上的像素，按颜色分桶，返回占比最高的那个。
 */
export function guessBackground(img) {
  const { width, height, rgb } = img
  const buckets = new Map()
  const step = Math.max(1, Math.floor(Math.min(width, height) / 200))

  const add = (x, y) => {
    const i = (y * width + x) * 3
    const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2]
    const key = (r >> 4) << 8 | (g >> 4) << 4 | (b >> 4)
    let bk = buckets.get(key)
    if (!bk) { bk = { r: 0, g: 0, b: 0, n: 0 }; buckets.set(key, bk) }
    bk.r += r; bk.g += g; bk.b += b; bk.n++
  }

  for (let x = 0; x < width; x += step) {
    add(x, 0)
    add(x, height - 1)
  }
  for (let y = 0; y < height; y += step) {
    add(0, y)
    add(width - 1, y)
  }

  let best = null
  for (const v of buckets.values()) {
    if (!best || v.n > best.n) best = v
  }
  if (!best) return { color: [0, 0, 0], ratio: 1, pixels: 0 }

  const total = [...buckets.values()].reduce((s, v) => s + v.n, 0) || 1
  return {
    color: [best.r / best.n, best.g / best.n, best.b / best.n],
    ratio: best.n / total,
    pixels: best.n,
  }
}

/**
 * 从四边洪水填充，标出背景区域。
 *
 * 用「颜色接近背景色」作为连通条件，容差可调。
 * 返回 Uint8Array，1 = 背景，0 = 前景。
 */
export function floodBackground(img, bgColor, tolerance = 60) {
  const { width, height, rgb } = img
  const mask = new Uint8Array(width * height)
  const stack = []

  const close = (x, y) => {
    const i = (y * width + x) * 3
    const dr = rgb[i] - bgColor[0]
    const dg = rgb[i + 1] - bgColor[1]
    const db = rgb[i + 2] - bgColor[2]
    return dr * dr + dg * dg + db * db <= tolerance * tolerance
  }

  /* 四条边上的接近背景色的点作为种子 */
  for (let x = 0; x < width; x++) {
    if (close(x, 0)) stack.push(x, 0)
    if (close(x, height - 1)) stack.push(x, height - 1)
  }
  for (let y = 0; y < height; y++) {
    if (close(0, y)) stack.push(0, y)
    if (close(width - 1, y)) stack.push(width - 1, y)
  }

  while (stack.length) {
    const y = stack.pop()
    const x = stack.pop()
    const idx = y * width + x
    if (idx < 0 || idx >= mask.length) continue
    if (mask[idx]) continue
    if (!close(x, y)) continue
    mask[idx] = 1
    if (x > 0) stack.push(x - 1, y)
    if (x < width - 1) stack.push(x + 1, y)
    if (y > 0) stack.push(x, y - 1)
    if (y < height - 1) stack.push(x, y + 1)
  }

  return mask
}

/**
 * 在前景掩码上找主体。
 *
 * **不能只取最大连通域**——真实零件经常在视觉上分成几块
 * （哑铃的两头 + 中间杆、带间隙的装配体、被遮挡的部件）。
 * 只取最大块会漏掉其它部分，把主体框算小，后面所有分析都偏。
 *
 * 正确做法：取所有「够大」的前景连通域并集。
 * 「够大」= 面积 >= 最大块的 minShare（默认 2%）。
 * 太碎的像素噪点不要，但明显是零件的一部分要保留。
 */
export function largestForegroundComponent(mask, width, height, opts = {}) {
  const minShare = opts.minShare ?? 0.02
  const seen = new Uint8Array(mask.length)
  const comps = []

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const start = y * width + x
      if (mask[start] || seen[start]) continue
      const stack = [start]
      seen[start] = 1
      let n = 0
      let x0 = x, x1 = x, y0 = y, y1 = y
      while (stack.length) {
        const idx = stack.pop()
        const cy = Math.floor(idx / width)
        const cx = idx % width
        n++
        if (cx < x0) x0 = cx
        if (cx > x1) x1 = cx
        if (cy < y0) y0 = cy
        if (cy > y1) y1 = cy
        const nb = [
          cx > 0 ? idx - 1 : -1,
          cx < width - 1 ? idx + 1 : -1,
          cy > 0 ? idx - width : -1,
          cy < height - 1 ? idx + width : -1,
        ]
        for (const k of nb) {
          if (k < 0 || seen[k] || mask[k]) continue
          seen[k] = 1
          stack.push(k)
        }
      }
      comps.push({ bbox: { x0, y0, x1, y1 }, pixels: n })
    }
  }

  if (comps.length === 0) {
    return {
      bbox: { x0: 0, y0: 0, x1: width - 1, y1: height - 1 },
      pixels: 0, coverage: 0, components: 0, keptComponents: 0,
    }
  }

  comps.sort((a, b) => b.pixels - a.pixels)
  const biggest = comps[0].pixels
  const kept = comps.filter((c) => c.pixels >= biggest * minShare)

  /* 并集包围盒 */
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  let pixels = 0
  for (const c of kept) {
    x0 = Math.min(x0, c.bbox.x0)
    y0 = Math.min(y0, c.bbox.y0)
    x1 = Math.max(x1, c.bbox.x1)
    y1 = Math.max(y1, c.bbox.y1)
    pixels += c.pixels
  }

  return {
    bbox: { x0, y0, x1, y1 },
    pixels,
    coverage: pixels / (width * height),
    components: comps.length,
    keptComponents: kept.length,
    /* 所有前景块的包围盒，供调用方判断是不是分散的装配体 */
    componentBoxes: kept.slice(0, 20).map((c) => c.bbox),
  }
}

/**
 * 完整的主体识别。
 *
 * @param {{width:number,height:number,rgb:Uint8Array}} img
 * @param {object} [opts]
 * @returns {{
 *   bbox:{x0,y0,x1,y1},
 *   width:number, height:number,
 *   coverage:number,
 *   background:{hex,rgb,ratio},
 *   confidence:string,
 *   fallback:boolean,
 *   reason:string
 * }}
 */
export function detectSubject(img, opts = {}) {
  const tolerance = opts.tolerance ?? 60
  const { width, height } = img

  const bg = guessBackground(img)

  /* 先判断背景是否够纯。背景是复杂场景照片时，洪水填充会碎成上千个连通域，
   * 那说明这张图根本没有「纯色背景」，强做主体识别只会得出垃圾结果。
   * 这时直接退回整图，并如实说明原因——比给出一个错的框好得多。 */
  if (bg.ratio < 0.35) {
    return {
      bbox: { x0: 0, y0: 0, x1: width - 1, y1: height - 1 },
      rawBbox: null,
      width,
      height,
      coverage: 1,
      background: {
        hex: toHex(bg.color[0], bg.color[1], bg.color[2]),
        rgb: bg.color.map((v) => Math.round(v)),
        ratio: Number(bg.ratio.toFixed(3)),
      },
      confidence: 'low',
      fallback: true,
      reason: '边缘像素里没有明显的主导色（最高只占 '
        + (bg.ratio * 100).toFixed(0) + '%），说明背景是复杂画面而不是纯色。'
        + '这时无法可靠区分主体与背景，改为整图分析——'
        + '你自己看图判断主体在哪，按下面的网格定位。',
      components: -1,
    }
  }

  const mask = floodBackground(img, bg.color, tolerance)
  const fg = largestForegroundComponent(mask, width, height)

  /* 连通域碎成太多块，说明背景边缘不连续（渐变色、被遮挡），
   * 主体识别同样不可靠 */
  if (fg.components > 200) {
    return {
      bbox: { x0: 0, y0: 0, x1: width - 1, y1: height - 1 },
      rawBbox: fg.bbox,
      width,
      height,
      coverage: 1,
      background: {
        hex: toHex(bg.color[0], bg.color[1], bg.color[2]),
        rgb: bg.color.map((v) => Math.round(v)),
        ratio: Number(bg.ratio.toFixed(3)),
      },
      confidence: 'low',
      fallback: true,
      reason: '背景分离后碎成 ' + fg.components + ' 个连通域，'
        + '说明背景不连续（渐变或有遮挡）。主体识别不可靠，改为整图分析。',
      components: fg.components,
    }
  }

  const bbox = fg.bbox
  const bw = bbox.x1 - bbox.x0 + 1
  const bh = bbox.y1 - bbox.y0 + 1
  const coverage = (bw * bh) / (width * height)

  /* 判定置信度 */
  let confidence = 'high'
  let fallback = false
  let reason = ''

  if (coverage < 0.05) {
    confidence = 'low'
    fallback = true
    reason = '主体只占画面 ' + (coverage * 100).toFixed(1) + '%，可能只框住了局部；退回整图分析'
  } else if (coverage > 0.98) {
    confidence = 'low'
    fallback = true
    reason = '主体几乎占满整图，说明背景不是纯色（可能是场景照片）；退回整图分析'
  } else if (bg.ratio < 0.5) {
    confidence = 'medium'
    reason = '背景色只占边缘像素的 ' + (bg.ratio * 100).toFixed(0) + '%，主体框仅供参考'
  }

  const finalBbox = fallback ? { x0: 0, y0: 0, x1: width - 1, y1: height - 1 } : bbox

  return {
    bbox: finalBbox,
    rawBbox: bbox,
    width,
    height,
    coverage: Number(coverage.toFixed(4)),
    background: {
      hex: toHex(bg.color[0], bg.color[1], bg.color[2]),
      rgb: bg.color.map((v) => Math.round(v)),
      ratio: Number(bg.ratio.toFixed(3)),
    },
    confidence,
    fallback,
    reason,
    components: fg.components,
  }
}
