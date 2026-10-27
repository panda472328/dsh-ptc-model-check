/**
 * 生成非矩形的测试图，验证对称检测和零件分组。
 *   node tests/make_shape_fixture.mjs
 */

import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

function makePng(width, height, painter) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  let p = 0
  for (let y = 0; y < height; y++) {
    raw[p++] = 0
    for (let x = 0; x < width; x++) {
      const [r, g, b] = painter(x, y)
      raw[p++] = r; raw[p++] = g; raw[p++] = b
    }
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const t = Buffer.from(type, 'ascii')
    const crc = Buffer.alloc(4)
    return Buffer.concat([len, t, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const W = 1024, H = 1024
const cx = W / 2, cy = H / 2

/* 造一个明显左右对称、但非矩形的形状：哑铃形（中间细，两头粗） */
const png = makePng(W, H, (x, y) => {
  const dx = Math.abs(x - cx)
  const dy = Math.abs(y - cy)
  const inBar = dx < 60 && dy < 300          // 中间的杆
  const inHeadL = Math.abs(x - (cx - 240)) < 110 && dy < 130  // 左头
  const inHeadR = Math.abs(x - (cx + 240)) < 110 && dy < 130  // 右头
  if (inBar || inHeadL || inHeadR) {
    // 主体深灰，头部带一点橙（模拟两个颜色区域）
    if (inBar) return [70, 70, 75]
    return [200, 110, 40]
  }
  return [250, 250, 250]
})

const out = 'D:/dsh插件制作/ptc-model-check/tests/shape_fixture.png'
writeFileSync(out, png)
console.log('已生成:', out)
console.log('内容: 白底 + 哑铃形（中间杆深灰，两头橙色圆头），左右完全对称')
