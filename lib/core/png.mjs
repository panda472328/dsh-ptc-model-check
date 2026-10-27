/**
 * 最小 PNG 解码器：只做剪影比对需要的那一件事——把图变成灰度平面。
 *
 * 为什么自己写：宿主没有 pngjs / sharp，而剪影比对只需要"每个像素是亮还是暗"。
 * PNG 的 IDAT 用 zlib 压缩，Node 自带 inflateSync，所以真正要写的只有
 * 分块解析 + 反滤波 + 转灰度，不到 200 行，比引入一个依赖更可控。
 *
 * 支持：8 位深、颜色类型 0(灰度)/2(RGB)/3(调色板)/4(灰度+α)/6(RGBA)、
 * 非隔行。遇到不支持的形式抛错，由调用方降级，不会静默给出错数据。
 */

import { inflateSync } from 'node:zlib'

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function readChunks(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error('不是 PNG 文件')
  }
  const chunks = []
  let off = 8
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const dataStart = off + 8
    const dataEnd = dataStart + len
    if (dataEnd > buf.length) break
    chunks.push({ type, data: buf.subarray(dataStart, dataEnd) })
    off = dataEnd + 4 // 跳过 CRC
    if (type === 'IEND') break
  }
  return chunks
}

/** Paeth 预测器（PNG 反滤波用） */
function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/**
 * 解码 PNG 并返回灰度平面。
 * @returns {{width:number, height:number, gray:Uint8Array}}
 */
export function decodePngGray(buf) {
  const chunks = readChunks(buf)
  const ihdr = chunks.find((c) => c.type === 'IHDR')
  if (!ihdr) throw new Error('缺少 IHDR')
  const width = ihdr.data.readUInt32BE(0)
  const height = ihdr.data.readUInt32BE(4)
  const bitDepth = ihdr.data[8]
  const colorType = ihdr.data[9]
  const interlace = ihdr.data[12]
  if (bitDepth !== 8) throw new Error('只支持 8 位深，实际 ' + bitDepth)
  if (interlace !== 0) throw new Error('不支持隔行 PNG')

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  if (!channels) throw new Error('不支持的颜色类型 ' + colorType)

  let palette = null
  const plte = chunks.find((c) => c.type === 'PLTE')
  if (plte) palette = plte.data

  const idat = chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)
  if (idat.length === 0) throw new Error('缺少 IDAT')
  const raw = inflateSync(Buffer.concat(idat))

  const bpp = channels
  const stride = width * bpp
  const out = new Uint8Array(width * height * bpp)
  let pos = 0
  let prev = new Uint8Array(stride)

  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]
    const line = raw.subarray(pos, pos + stride)
    pos += stride
    const cur = new Uint8Array(stride)
    for (let x = 0; x < stride; x++) {
      const rawByte = line[x]
      const left = x >= bpp ? cur[x - bpp] : 0
      const up = prev[x]
      const upLeft = x >= bpp ? prev[x - bpp] : 0
      let v
      switch (filter) {
        case 0: v = rawByte; break
        case 1: v = rawByte + left; break
        case 2: v = rawByte + up; break
        case 3: v = rawByte + ((left + up) >> 1); break
        case 4: v = rawByte + paeth(left, up, upLeft); break
        default: throw new Error('未知滤波类型 ' + filter)
      }
      cur[x] = v & 0xff
    }
    out.set(cur, y * stride)
    prev = cur
  }

  const gray = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const base = i * bpp
    let r, g, b, a = 255
    if (colorType === 0 || colorType === 4) {
      r = g = b = out[base]
      if (colorType === 4) a = out[base + 1]
    } else if (colorType === 3) {
      const idx = out[base]
      if (palette && idx * 3 + 2 < palette.length) {
        r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2]
      } else {
        r = g = b = idx
      }
    } else {
      r = out[base]; g = out[base + 1]; b = out[base + 2]
      if (colorType === 6) a = out[base + 3]
    }
    // 亮度按人眼权重；透明像素当作背景（暗）
    const lum = 0.299 * r + 0.587 * g + 0.114 * b
    gray[i] = a < 8 ? 0 : Math.round(lum)
  }

  return { width, height, gray }
}

/**
 * 最近邻缩放到目标尺寸（只用于剪影比对，不需要高质量插值）。
 */
export function resizeGray(src, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return src
  const out = new Uint8Array(dw * dh)
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / dh))
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / dw))
      out[y * dw + x] = src[sy * sw + sx]
    }
  }
  return out
}

/**
 * 裁掉四周的空白边距，只留内容包围盒。
 *
 * 为什么：参考图几乎总是带白边或黑边的照片，而我们的剪影是满幅渲染。
 * 不裁边距的话，两边"实体占画面的比例"对不上，IoU 会被边距差异拉低。
 * 阈值用 (最暗+最亮)/2 自动适配：剪影是白物体黑背景，照片可能相反。
 */
export function cropToContent(gray, w, h) {
  let lo = 255, hi = 0
  for (let i = 0; i < gray.length; i++) {
    if (gray[i] < lo) lo = gray[i]
    if (gray[i] > hi) hi = gray[i]
  }
  const mid = (lo + hi) / 2
  let minX = w, minY = h, maxX = -1, maxY = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (gray[y * w + x] > mid) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return { gray, w, h } // 全空，原样返回
  const cw = maxX - minX + 1
  const ch = maxY - minY + 1
  const out = new Uint8Array(cw * ch)
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      out[y * cw + x] = gray[(y + minY) * w + (x + minX)]
    }
  }
  return { gray: out, w: cw, h: ch }
}

/** 灰度取反（处理"物体比背景暗"的参考图）。 */
export function invertGray(gray) {
  const out = new Uint8Array(gray.length)
  for (let i = 0; i < gray.length; i++) out[i] = 255 - gray[i]
  return out
}

/**
 * 剪影比对前的标准流程：裁边距 → 归一化到同一尺寸。
 * 极性（物体亮还是暗）由调用方试两种取最大。
 */
export function preparePair(a, b, size = 256) {
  const ca = cropToContent(a.gray, a.width, a.height)
  const cb = cropToContent(b.gray, b.width, b.height)
  return {
    a: resizeGray(ca.gray, ca.w, ca.h, size, size),
    b: resizeGray(cb.gray, cb.w, cb.h, size, size),
    w: size, h: size,
  }
}
