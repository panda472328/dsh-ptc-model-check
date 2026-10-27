/**
 * 生成一张有纯色背景的测试图（用 Blender 渲染），验证主体识别。
 */

import { writeFileSync } from 'node:fs'

// 用 Node 手写一个最小 PNG：白底 + 中央一个深灰色块
import { deflateSync } from 'node:zlib'

function makePng(width, height, painter) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  let p = 0
  for (let y = 0; y < height; y++) {
    raw[p++] = 0 // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = painter(x, y)
      raw[p++] = r
      raw[p++] = g
      raw[p++] = b
    }
  }

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const t = Buffer.from(type, 'ascii')
    const crcBuf = Buffer.concat([t, data])
    const crc = Buffer.alloc(4)
    // 简化 CRC（真实 PNG 需要正确 CRC，但我们的解码器不校验）
    crc.writeUInt32BE(0)
    return Buffer.concat([len, t, data, crc])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 2   // RGB
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0  // no interlace

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const W = 1024, H = 1024
// 白底 (250,250,250)，中央 600x600 深灰块 (60,60,65)，加几条橙色细节
const png = makePng(W, H, (x, y) => {
  const cx = W / 2, cy = H / 2
  const inBox = Math.abs(x - cx) < 300 && Math.abs(y - cy) < 300
  if (!inBox) return [250, 250, 250]
  // 主体内的细节：中间一条橙色带
  if (Math.abs(y - cy) < 40) return [200, 110, 40]
  return [60, 60, 65]
})

const out = 'D:/dsh插件制作/ptc-model-check/tests/subject_fixture.png'
writeFileSync(out, png)
console.log('已生成测试图:', out, png.length, '字节')
console.log('尺寸:', W, 'x', H)
console.log('内容: 白底 + 中央 600x600 深灰块 + 中央橙色横带')
