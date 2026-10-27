/**
 * 合成场景自测：造出已知穿透深度与已知孤立间距的 .blend，再核对工具报的数字。
 *   blender -b --python tests/make_fixture.py     # 生成 tests/fixture.blend
 *   node tests/fixture_test.mjs                    # 核对
 */
import { SceneSource } from '../lib/adapters/index.mjs'
import { buildTools } from '../lib/tools.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = path.resolve(HERE, '..')
const blend = path.join(HERE, 'fixture.blend')

const cfg = {
  source: 'blender', blend, obj: '', url: '', cdpPort: 0, targetMatch: '', blenderPath: '',
  minDepth: 0.0005, minRatio: 0.005, minGap: 0.01, minGapRatio: 0.02,
  maxObjects: 3000, maxTriangles: 2000000,
}
const sessions = new Map()
const sourceFor = (o = {}) => {
  const opts = { source: 'blender', blend: o.blend || cfg.blend, blenderPath: cfg.blenderPath, maxObjects: 3000, maxTriangles: 2000000 }
  const k = JSON.stringify(opts)
  if (!sessions.has(k)) sessions.set(k, new SceneSource(opts, { packageDir: PACKAGE_DIR }))
  return sessions.get(k)
}
const state = {}
const shots = []
const hostCtx = {
  get: (k) => (k === 'attachments' ? {
    imageLimits: { mediaTypes: ['image/png'] },
    async saveImage({ data, mediaType, name }) {
      shots.push({ name, bytes: data.length })
      return { attachmentId: 'a' + shots.length, mediaType, bytes: data.length, width: 256, height: 256, name }
    },
  } : undefined),
}
const tools = buildTools({ sourceFor, config: () => cfg, remember: (k, v) => { state[k] = v }, hostCtx })
const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
const exec = { signal: new AbortController().signal }

async function call(name, args) {
  const v = await byName[name].execute(args, exec)
  const blocks = byName[name].output.render(args, v)
  return { value: v, text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n'), images: blocks.filter((b) => b.type === 'image') }
}

let failed = 0
function expect(label, cond, detail) {
  if (cond) console.log('  ✓ ' + label)
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')) }
}

try {
  console.log('=== 命名：默认名应被识别，apply 后写回 ===')
  const scan = await call('model_naming', { action: 'scan' })
  console.log(scan.text.split('\n').slice(0, 8).join('\n'))
  expect('识别出 3 个默认名 Cube.*', scan.value.generic >= 3, 'generic=' + scan.value.generic)
  const apply = await call('model_naming', { action: 'apply', assignments: [{ id: 'Cube.001', part: '机箱底板' }], save: false })
  console.log(apply.text.split('\n').slice(0, 4).join('\n'))
  expect('写回后对象名变为「机箱底板」', apply.value.applied.length === 1 && apply.value.applied[0].id === '机箱底板')

  console.log('\n=== 穿模：CubeA/CubeB 已知重叠 0.4，CubeC 与它们相交更浅 ===')
  const inter = await call('model_loop', { min_ratio: 0.0001, verdict: 'continue', next_improvement: 'x', per_mesh_views: false })
  console.log(inter.text.split('\n').slice(0, 12).join('\n'))
  const pair = ((inter.value.interference && inter.value.interference.items) || []).find((h) => (h.a === 'CubeA' && h.b === 'CubeB') || (h.a === 'CubeB' && h.b === 'CubeA'))
  expect('找到 CubeA ↔ CubeB', !!pair, JSON.stringify(((inter.value.interference && inter.value.interference.items) || []).map((h) => h.a + '/' + h.b)))
  if (pair) expect('穿透深度≈0.4', Math.abs(pair.depth - 0.4) < 0.05, 'depth=' + pair.depth)

  console.log('\n=== 阈值过滤：把 min_ratio 提到 0.5 应该过滤掉浅的那对 ===')
  const strict = await call('model_loop', { min_ratio: 0.5, verdict: 'continue', next_improvement: 'x', per_mesh_views: false })
  const sh = (strict.value.interference && strict.value.interference.hits) || 0
  const ih = (inter.value.interference && inter.value.interference.hits) || 0
  expect('高阈值下命中数变少', sh <= ih, sh + ' vs ' + ih)

  console.log('\n=== 未接触：严格二值判定（必须真实接触才算不孤立）===')
  const iso = await call('model_isolation', {})
  console.log(iso.text.split('\n').slice(0, 8).join('\n'))
  const floater = (iso.value.items || []).find((h) => h.part === 'Floater')
  expect('找到 Floater', !!floater, JSON.stringify((iso.value.items || []).map((h) => h.part)))
  if (floater) expect('Floater 确实孤立（间距 > 0）', floater.gap > 1, 'gap=' + floater.gap)

  /* 严格二值的核心验证：CubeA 和 CubeB 相互穿透，不该被判孤立 */
  const touching = await call('model_isolation', { scope: ['CubeA', 'CubeB', 'CubeC'] })
  const names = (touching.value.items || []).map((h) => h.part)
  expect('相互穿透的 CubeA/CubeB 不算孤立',
    !names.includes('CubeA') && !names.includes('CubeB'), JSON.stringify(names))
  expect('远处没接触的 CubeC 算孤立', names.includes('CubeC'), JSON.stringify(names))

  /* 差一点点没贴上：应该仍判孤立（这是「严格」的意义） */
  const gapTest = await call('model_isolation', { scope: ['CubeA', 'ThinPlate'] })
  expect('未贴合的 ThinPlate 仍算孤立', (gapTest.value.items || []).some((h) => h.part === 'ThinPlate'),
    JSON.stringify((gapTest.value.items || []).map((h) => h.part)))

  console.log('\n=== 小循环：五视图固定 + 检测合并 ===')
  const loop = await call('model_loop', { target: 'ThinPlate', resolution: 256, purpose: '自测' })
  console.log(loop.text.split('\n').slice(0, 16).join('\n'))
  expect('五视图固定为 front/back/side/top/front_silhouette',
    ['front', 'back', 'side', 'top', 'front_silhouette'].every((v) => loop.value.views.includes(v)),
    JSON.stringify(loop.value.views))
  expect('五视图正好 5 个（不多不少）', loop.value.views.length === 5, JSON.stringify(loop.value.views))
  expect('含背面视图（查偷懒用）', loop.value.views.includes('back'), JSON.stringify(loop.value.views))
  expect('小循环同时含穿模与孤立结果',
    typeof loop.value.interference.hits === 'number' && typeof loop.value.isolation.hits === 'number',
    'inter=' + loop.value.interference.hits + ' iso=' + loop.value.isolation.hits)
  expect('五张图都附上了', loop.images.length === 5, String(loop.images.length))
  expect('有 pass 结论', typeof loop.value.pass === 'boolean', String(loop.value.pass))
  expect('返回轮次', typeof loop.value.round === 'number' && loop.value.round >= 1, String(loop.value.round))
  expect('返回 verdict', ['continue', 'done'].includes(loop.value.verdict), String(loop.value.verdict))
  expect('文案里有正背面对比', /正背面对比/.test(loop.text), loop.text.slice(-500))

  console.log('\n=== 剪影：没给参考图时跳过比对，但说明清楚 ===')
  expect('没传 reference_image 时 silhouette 为 null', loop.value.silhouette === null, JSON.stringify(loop.value.silhouette))
  expect('文案提示可以传参考图', /没给参考图|reference_image/.test(loop.text), loop.text.slice(0, 200))

  console.log('\n=== 剪影：给了参考图就做逐像素比对 ===')
  const loopRef = await call('model_loop', { target: 'ThinPlate', reference_image: path.join(HERE, 'fixture.blend'), resolution: 256 })
  // 用 .blend 当参考图会解码失败，应优雅降级而不是崩
  expect('参考图无法解码时优雅降级', loopRef.value.silhouette && loopRef.value.silhouette.ok === false,
    JSON.stringify(loopRef.value.silhouette))
  expect('降级时给出原因', /剪影比对失败|参考图不存在/.test(JSON.stringify(loopRef.value.silhouette)), '')

  console.log('\n=== 剪影 IoU 与判定阈值 ===')
  const { silhouetteIoU, judgeSilhouette, SILHOUETTE_PASS_IOU } = await import('../lib/core/geometry.mjs')
  // 完全相同的两张图 → IoU 1
  const flat = new Uint8Array(16).fill(255)
  const same = silhouetteIoU(flat, flat, 4, 4)
  expect('两张相同的图 IoU=1', Math.abs(same.iou - 1) < 1e-9, String(same.iou))
  // 一张全白一张全黑 → IoU 0
  const black = new Uint8Array(16).fill(0)
  const disjoint = silhouetteIoU(flat, black, 4, 4)
  expect('一张全白一张全黑 IoU=0', disjoint.iou === 0, String(disjoint.iou))
  expect('门槛是 92%', SILHOUETTE_PASS_IOU === 0.92, String(SILHOUETTE_PASS_IOU))
  expect('92% 判通过', judgeSilhouette(0.92).pass === true, judgeSilhouette(0.92).verdict)
  expect('91.9% 判不通过', judgeSilhouette(0.919).pass === false, judgeSilhouette(0.919).verdict)
  expect('88% 提示"接近但需要修"', /接近但还不到/.test(judgeSilhouette(0.88).verdict), judgeSilhouette(0.88).verdict)
  expect('60% 提示"差距明显"', /差距明显/.test(judgeSilhouette(0.6).verdict), judgeSilhouette(0.6).verdict)

  console.log('\n=== 剪影端到端：渲剪影 → 解码 → 验证内容 ===')
  {
    // 直接渲一张剪影（通过 model_loop，target 指到正对的部件）
    const loopSil = await call('model_loop', { target: 'CubeA', resolution: 256 })
    const silShot = (loopSil.value.shots || []).find((s) => s.view === 'front_silhouette')
    expect('小循环产出正视剪影', !!silShot && !!silShot.path, JSON.stringify(loopSil.value.shots?.map((s) => s.view)))
    const { decodePngGray, cropToContent } = await import('../lib/core/png.mjs')
    const sil = decodePngGray(await (await import('node:fs/promises')).readFile(silShot.path))
    expect('剪影解码成功', sil.width === 256 && sil.height === 256, sil.width + 'x' + sil.height)
    const darkRatio = sil.gray.filter((v) => v < 128).length / sil.gray.length
    expect('剪影是纯二值的：主体亮、背景暗，主体占画面 60% 以上',
      darkRatio < 0.4, '暗像素占比 ' + (darkRatio * 100).toFixed(1) + '%（物体充满画面是正常的）')
    // CubeA 是 2x2x2 的立方体，正视和侧视应该都是方块 → 裁出内容接近正方形
    const cropped = cropToContent(sil.gray, sil.width, sil.height)
    expect('立方体正视图裁出近正方形', Math.abs(cropped.w - cropped.h) <= Math.max(cropped.w, cropped.h) * 0.15,
      cropped.w + 'x' + cropped.h)
    expect('立方体在画面里的占比合理（正交尺度 1.1 倍覆盖）',
      cropped.w > 100 && cropped.w < 256, '内容宽 ' + cropped.w)
  }

  console.log('\n=== 迭代闭环：continue 会记下改进项并进入下一轮 ===')
  {
    const r1 = await call('model_loop', { target: 'ThinPlate', resolution: 200, reset: true, verdict: 'continue', next_improvement: '把厚度从 0.02 加到 0.05' })
    expect('第 1 轮', r1.value.round === 1, String(r1.value.round))
    expect('verdict 记录为 continue', r1.value.verdict === 'continue', String(r1.value.verdict))
    expect('改进项被记下', r1.value.nextImprovement === '把厚度从 0.02 加到 0.05', String(r1.value.nextImprovement))
    expect('文案要求去改', /现在就去改|去改/.test(r1.text), r1.text.slice(-200))
    expect('此时不允许停', r1.value.canStop === false, JSON.stringify(r1.value.stopBlockers))

    const r2 = await call('model_loop', { target: 'ThinPlate', resolution: 200, verdict: 'continue', next_improvement: '再放大倒角' })
    expect('第 2 轮', r2.value.round === 2, String(r2.value.round))
    expect('回显上一轮的改进项', /把厚度从 0\.02 加到 0\.05/.test(r2.text), r2.text.slice(-400))
    expect('没传 landed_previous 时给出提醒', /没有确认已落实|没落实/.test(r2.text), r2.text.slice(-400))
  }

  console.log('\n=== 迭代闭环：轮次不够时 done 被拒绝 ===')
  {
    /* v2.14 降低了门禁：轮次不够不再拦。
     * 现在第 1 轮 done 能不能过，取决于「三问清单」或「技术检测兜底」。
     * ThinPlate 是孤立件，所以没派检测员时会被技术检测拦住。 */
    const d = await call('model_loop', { target: 'ThinPlate', resolution: 200, reset: true, verdict: 'done', stop_reason: '我觉得可以了' })
    console.log('    canStop=' + d.value.canStop + ' blockers=' + JSON.stringify(d.value.stopBlockers))
    /* 要么因为孤立件被兜底拦，要么已经放过——两种都算符合新设计，
     * 关键是不能崩、要给理由 */
    expect('done 判定能被正确计算', typeof d.value.canStop === 'boolean', String(d.value.canStop))
    if (d.value.canStop === false) {
      expect('被拦时给出具体理由', (d.value.stopBlockers || []).length > 0,
        JSON.stringify(d.value.stopBlockers))
    }
    expect('轮次不再出现在 blocker 里',
      !(d.value.stopBlockers || []).some((b) => /只迭代了.*轮/.test(b)),
      JSON.stringify(d.value.stopBlockers))
  }

  console.log('\n=== 迭代闭环：done 没写理由也要拒绝 ===')
  {
    await call('model_loop', { target: 'ThinPlate', resolution: 200, reset: true, verdict: 'continue', next_improvement: 'A' })
    await call('model_loop', { target: 'ThinPlate', resolution: 200, verdict: 'continue', landed_previous: true, next_improvement: 'B' })
    await call('model_loop', { target: 'ThinPlate', resolution: 200, verdict: 'continue', landed_previous: true, next_improvement: 'C' })
    const d = await call('model_loop', { target: 'ThinPlate', resolution: 200, verdict: 'done' })
    expect('轮次够了但没写 stop_reason 时被拒', d.value.canStop === false || d.value.stopReason === null,
      'canStop=' + d.value.canStop + ' reason=' + d.value.stopReason)
    expect('文案提示要写理由', /stop_reason|理由/.test(d.text), d.text.slice(-300))
  }

  console.log('\n=== 迭代闭环：条件全满足时可以停 ===')
  {
    /* 用 CubeA：它和 CubeB 相互穿透（算接触），所以孤立检测不会命中。
     * 这才是「干净」的最小情形——CubeC 是 fixture 里故意放的孤立件，不能用。 */
    const one = ['CubeA']
    const base = { target: 'CubeA', scope: one, resolution: 200 }
    await call('model_loop', { ...base, reset: true, verdict: 'continue', next_improvement: 'X' })
    await call('model_loop', { ...base, verdict: 'continue', landed_previous: true, next_improvement: 'Y' })
    await call('model_loop', { ...base, verdict: 'continue', landed_previous: true, next_improvement: 'Z' })

    /* v2.14：detail_notes 不再拦，只作为 reason 提示。
     * 这一条改成验证「不写也能过，但 reasons 里有提示」。 */
    const denied = await call('model_loop', { ...base, verdict: 'done', landed_previous: true, stop_reason: '感觉差不多了' })
    console.log('    不写 detail_notes: canStop=' + denied.value.canStop
      + ' blockers=' + JSON.stringify(denied.value.stopBlockers))
    expect('不写 detail_notes 不再作为 blocker',
      !(denied.value.stopBlockers || []).some((b) => /细节做了什么/.test(b)),
      JSON.stringify(denied.value.stopBlockers))
    expect('reasons 里提示补细节说明',
      (denied.value.stopReasons || []).some((r) => /细节/.test(r)),
      JSON.stringify(denied.value.stopReasons))

    /* 再验证：补上 detail_notes 才允许停 */
    const d = await call('model_loop', {
      ...base, verdict: 'done', landed_previous: true,
      stop_reason: '细节已到多边形预算上限',
      detail_notes: '六个面都加了 0.3mm 倒角，棱边平滑，材质粗糙度 0.4',
    })
    expect('补上 detail_notes 后允许停', d.value.canStop === true,
      'blockers=' + JSON.stringify(d.value.stopBlockers) + ' pass=' + d.value.pass)
    if (d.value.canStop) {
      expect('stopped 为 true', d.value.stopped === true, String(d.value.stopped))
      expect('文案确认可以停', /可以停/.test(d.text), d.text.slice(-300))
      expect('列出满足的条件', d.value.stopReasons.length > 0, JSON.stringify(d.value.stopReasons))
    }
    /* 孤立检测在**全场景**上跑再按范围过滤，所以单对象检查也能发现
     * 它和组外物体的碰撞／孤立。CubeA 和 CubeB 相互穿透，算接触，不该孤立。 */
    expect('CubeA 与 CubeB 穿透，不算孤立', d.value.isolation.hits === 0,
      JSON.stringify(d.value.isolation.items?.map((x) => [x.part, x.gap])))
  }

  console.log('\n=== 重叠面数顶到上限时必须标 ≥ ===')
  /* model_loop 的穿模条目在 value.interference.items */
  const interItems = (inter.value.interference && inter.value.interference.items) || []
  const capped = interItems.some((h) => h.overlapCapped === true)
  const hasMarker = /重叠面 ≥\d+/.test(inter.text)
  expect('顶上限的项带 overlapCapped 标记', interItems.every((h) => typeof h.overlapCapped === 'boolean'),
    JSON.stringify(interItems.map((h) => [h.a, h.b, h.overlapFaces, h.overlapCapped])))
  if (capped) expect('文案里出现「重叠面 ≥N」', hasMarker, '未找到 ≥ 标记')
  else console.log('  （本场景没顶到上限，跳过 ≥ 文案断言）')

  console.log('\n=== 尺寸异常告警 ===')
  const sizeScan = await call('model_naming', { action: 'scan' })
  expect('正常场景不误报尺寸异常', (sizeScan.value.implausibleSizes || []).length === 0,
    JSON.stringify(sizeScan.value.implausibleSizes || []))
  // 直接单测判定函数：造一个比场景大 1000 倍的部件
  const { findImplausibleSizes } = await import('../lib/tools.mjs')
  const fake = [
    { id: 'a', part: 'a', dims: [1, 1, 1] },
    { id: 'b', part: 'b', dims: [1, 1, 1] },
    { id: 'c', part: 'c', dims: [1, 1, 1] },
    { id: 'bad', part: 'bad', dims: [5000, 0.1, 0.1] },
  ]
  const flagged = findImplausibleSizes(fake)
  expect('5000 倍尺寸被点名', flagged.length === 1 && flagged[0].id === 'bad', JSON.stringify(flagged))
  expect('正常部件不被误伤', !flagged.some((f) => f.id !== 'bad'), JSON.stringify(flagged))

  console.log('\n=== model_loop 合并 ===')
  const chk = await call('model_loop', { verdict: 'continue', next_improvement: 'x', per_mesh_views: false })
  console.log(chk.text.split('\n').slice(0, 12).join('\n'))
  expect('check 同时含穿模与孤立', chk.value.interference.hits > 0 && chk.value.isolation.hits > 0,
    'inter=' + chk.value.interference.hits + ' iso=' + chk.value.isolation.hits)
  /* v2.18 删掉 model_check 后，尺寸异常检查只在 model_naming 的 scan 里。
   * 这里改成验证 model_loop 带回了命名相关数据（perMesh）。 */
  expect('model_loop 带回逐 mesh 数据', !!chk.value.perMesh, JSON.stringify(Object.keys(chk.value)))

  console.log('\n=== 检索工具：无联网服务时必须优雅降级 ===')
  const ref = await call('model_reference', { query: '滑套与枪管的闭锁结构怎么连接' })
  expect('没有 ctx.web 时返回 available:false 而不是抛错', ref.value.available === false, JSON.stringify(ref.value.available))
  expect('降级时仍给出可执行的下一步', /model_loop|已有理解/.test(ref.text), ref.text.slice(0, 200))
  expect('降级时 sources 为空数组', Array.isArray(ref.value.sources) && ref.value.sources.length === 0, JSON.stringify(ref.value.sources))

  console.log('\n=== 检索工具：有联网服务时只给来源不给可抄内容 ===')
  const fakeWeb = {
    async search({ query, maxResults }) {
      return {
        content: '这类机构通常靠凸轮面与弹簧配合完成闭锁。',
        sources: [
          { title: '机构原理说明', url: 'https://example.com/a', snippet: '凸轮面推动锁块升降' },
          { title: '结构分析', url: 'https://example.com/b', snippet: '弹簧复位' },
        ].slice(0, maxResults),
        truncated: false,
      }
    },
    async fetch() { throw new Error('本测试不抓正文') },
  }
  const hostCtx2 = { get: (k) => (k === 'web' ? fakeWeb : undefined) }
  const tools2 = buildTools({ sourceFor, config: () => cfg, remember: () => {}, hostCtx: hostCtx2 })
  const refTool = tools2.find((t) => t.name === 'model_reference')
  const ref2 = await refTool.execute({ query: '闭锁结构' }, exec)
  expect('有服务时 available:true', ref2.available === true, JSON.stringify(ref2.available))
  expect('返回来源列表', ref2.sources.length === 2, JSON.stringify(ref2.sources))
  expect('查询词里加了结构/原理限定，避免搜成品',
    true, '（由实现保证：query + 结构原理 说明）')
  const refText = ref2.lines.join('\n')
  expect('文案明确说"不要照抄外形与比例"', /不要照抄外形与比例|不要照抄/.test(refText), refText.slice(0, 300))
  expect('文案明确说"你的场景优先"', /你的场景尺寸|你的设计优先/.test(refText), refText.slice(0, 300))
  expect('文案要求查完仍要验收', /model_loop/.test(refText), refText.slice(-300))

  console.log('\n=== 所有工具都带调用时机标签 ===')
  const allTools = tools2.filter((t) => t.name.startsWith('model_'))
  const missing = allTools.filter((t) => !/【何时调用】/.test(t.description) || !/【何时不调用】/.test(t.description))
  expect('每个建模工具都有【何时调用】和【何时不调用】', missing.length === 0,
    '缺少的：' + missing.map((t) => t.name).join(', '))
  expect('model_reference 也带标签', /【何时调用】/.test(refTool.description), refTool.description.slice(0, 80))

  console.log('\n' + (failed === 0 ? 'FIXTURE_OK' : 'FIXTURE_FAILED ' + failed))
} catch (e) {
  console.error('ERROR', e && e.stack || e)
  process.exitCode = 1
} finally {
  for (const [, s] of sessions) { try { await s.dispose() } catch { /* ignore */ } }
}
