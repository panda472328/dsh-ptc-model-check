/**
 * 环境安装引导的回归测试。
 *
 * 用户要求（原话）：
 *   「文档必须要让 ai 第一步就去看。先检测本机有没有 blender，如果有的话，
 *     检测 blender 有没有需要的 mcp，如果都有，就跳过这个文档的内容，
 *     如果其中有一项没有，这个文档需要引导 ai 去装。
 *     你可以不把这个文档直接灌入上下文，而是先让模型检测有没有 blender，
 *     如果没有的话再强制让他看这个下载 blender 和 mcp 的文档」
 *
 * 也就是三个必须守住的行为：
 *   ① 环境齐全 → 运行时状态里**不出现**文档路径（不许诱导模型去读）
 *   ② 环境缺失 → 必须出现文档路径 + 明确的强制阅读指令
 *   ③ 分类要分清「缺 Blender / 缺 MCP / 缺 addon / 配置错」
 *
 * 不连接 Blender：分类是纯函数，状态文本用假 state 直接组装。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { classifyEnv, isNativeToolMissing, findMcpServerScript } from '../lib/blender-boot.mjs'
import { buildDetailGuidance } from '../lib/core/detail.mjs'

const DOC = 'docs/install-blender-mcp.md'

/* ── 抽取真实的 buildStateText（与 verify_detail_flow 同一手法）──
 * 不能只匹配源码文本：那段逻辑有分支和守卫，
 * 只有真的执行才能证明「齐全时不提文档」。
 * classifyEnv 要一起传进去——源码里对它有 typeof 守卫，
 * 不传就只能测到降级分支（见 §9）。 */
const index = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const src = index.slice(index.indexOf('function buildStateText(state) {'))
const buildStateText = new Function('PLUGIN_VERSION', 'buildDetailGuidance', 'classifyEnv',
  src + '\nreturn buildStateText')('test', buildDetailGuidance, classifyEnv)

const stateWith = (blenderReady) => ({
  blenderReady,
  phase: { modelingComplete: false },
  loop: null,
  review: {},
  research: { required: 0, calls: 0, satisfied: true, missing: 0 },
  modeling: { editCount: 0, lookSinceEdit: 0 },
  todo: null,
  memoryText: '',
  designIntent: {},
})

console.log('=== 1. 分类：每类环境给出正确的「要不要读文档」 ===')
assert.equal(classifyEnv({ ok: true }).needsInstallDoc, false)
assert.equal(classifyEnv({ ok: true }).kind, 'ok')
assert.equal(classifyEnv({ ok: false, action: 'no-blender' }).kind, 'no-blender')
assert.equal(classifyEnv({ ok: false, action: 'no-blender' }).needsInstallDoc, true)
assert.equal(classifyEnv({ ok: false, action: 'mcp-launch-failed' }).kind, 'mcp-down')
assert.equal(classifyEnv({ ok: false, action: 'mcp-endpoint-unavailable' }).kind, 'mcp-down')
assert.equal(classifyEnv({ ok: false, action: 'addon-not-listening' }).kind, 'addon-down')
assert.equal(classifyEnv({ ok: false, action: 'need-manual-start' }).kind, 'addon-down')
/* .blend 路径写错是配置问题，读安装文档没用 */
assert.equal(classifyEnv({ ok: false, action: 'blend-not-found' }).needsInstallDoc, false)
assert.equal(classifyEnv({ ok: false, action: 'blend-not-found' }).kind, 'config-error')
/* 未知 action 保守处理：仍需按文档核对 */
assert.equal(classifyEnv({ ok: false }).needsInstallDoc, true)
assert.equal(classifyEnv(null).needsInstallDoc, true)
console.log('  ✓ ok / no-blender / mcp-down / addon-down / config-error 全部分类正确')

console.log('\n=== 2. 环境齐全：状态文本里不出现安装文档 ===')
const ready = buildStateText(stateWith({
  ok: true, launched: true, steps: ['MCP 服务器在线（12 个工具）', 'Blender addon 在线（端口 9876）'],
}))
assert.match(ready, /Blender 环境：\*\*已就绪\*\*/)
assert.doesNotMatch(ready, /install-blender-mcp/, '环境齐全时不许提文档，避免浪费 token')
assert.doesNotMatch(ready, /必须先读/, '环境齐全时不许出现强制阅读指令')
console.log('  ✓ 已就绪，且完全没有文档字样')
console.log('    ' + ready.split('\n').find((l) => l.includes('Blender 环境')))

console.log('\n=== 3. 缺 Blender：必须给出文档 + 强制阅读 ===')
const noBlender = buildStateText(stateWith({
  ok: false, launched: true, action: 'no-blender',
  steps: ['MCP 服务器在线（12 个工具）', '找不到 blender.exe'],
  hint: '没找到 Blender。请安装 Blender，或用 BLENDER_EXE 环境变量指定路径。',
}))
assert.match(noBlender, /缺少 Blender/)
assert.match(noBlender, /install-blender-mcp/, '缺环境时必须指路到文档')
assert.match(noBlender, /必须先读/, '必须是强制措辞，不是「可以看」')
assert.match(noBlender, /blender_ready/, '必须给出装完后的验证动作')
assert.match(noBlender, /不要用 execute_python 伪造场景/, '必须堵掉绕过路径')
/* 状态文本本身也要说清 addon 是单文件，否则模型读完文档前会先去找 zip */
assert.match(noBlender, /单文件 blender_mcp\.py/, '状态里要预警「单文件」，这是最容易装错的一步')
console.log('  ✓ 缺 Blender → 强制读文档')
console.log('    ' + noBlender.split('\n').find((l) => l.includes('必须先读')).slice(0, 120) + '…')

console.log('\n=== 4. addon 没监听：同样指向文档 ===')
const addonDown = buildStateText(stateWith({
  ok: false, launched: true, action: 'need-manual-start',
  steps: ['MCP 服务器在线', 'Blender 在运行，但 addon 没启动'],
  hint: '按 N → Blender MCP → Start MCP Server',
}))
assert.match(addonDown, /addon 没在监听端口/)
assert.match(addonDown, /install-blender-mcp/)
assert.match(addonDown, /必须先读/)
console.log('  ✓ addon 未启动 → 强制读文档')

console.log('\n=== 5. 配置错（.blend 路径不存在）：不误导去读安装文档 ===')
const cfgErr = buildStateText(stateWith({
  ok: false, launched: true, action: 'blend-not-found',
  steps: ['找不到指定的 .blend 文件'], hint: '修正 blend 路径后再启动',
}))
assert.doesNotMatch(cfgErr, /必须先读/)
assert.doesNotMatch(cfgErr, /install-blender-mcp/)
console.log('  ✓ 配置问题不指向安装文档')

console.log('\n=== 6. 只检查过还没拉起：只在真失败后才要求读文档 ===')
const checkedOnly = buildStateText(stateWith({
  ok: false, launched: false, action: 'no-blender',
  steps: ['MCP 服务器离线：ECONNREFUSED'], hint: '没找到 Blender',
}))
assert.match(checkedOnly, /未就绪/)
assert.match(checkedOnly, /如果拉起后仍然失败/, '还没尝试拉起时用条件句，不下命令')
console.log('  ✓ 首轮只检查 → 条件性提示')

console.log('\n=== 7. 文档本身存在且可执行 ===')
const doc = readFileSync(new URL('../' + DOC, import.meta.url), 'utf8')
assert.ok(doc.length > 3000, '文档不能是空壳，实际 ' + doc.length)
/* 四层依赖各有章节——尤其 ③ bundle 注册，那是建模测试 27/28 真实缺失的一层 */
for (const sec of [
  '## 四个依赖，缺一个都不算通',
  '## 0. 先搞清楚缺的是哪一项',
  '## 1. 安装 Blender',
  '## 2. 安装 blender-mcp bundle',
  '## 3. 安装 Blender MCP addon',
  '## 4. 启动 MCP 服务器',
  '## 5. 验收清单',
  '## 6. 常见失败与处置',
]) {
  assert.ok(doc.includes(sec), '缺章节：' + sec)
}
assert.match(doc, /dsh-mcp-client/, '必须点出注册工具用的插件名')
assert.match(doc, /cordis\.patch\.yml/, '必须说明 bundle 靠 patch 注册')
assert.match(doc, /完全退出|完全重启/, 'bundle 只在启动时读取，必须写明完全重启')
/* 判据必须是能真跑的，不能只写「确认已安装」 */
assert.match(doc, /Test-NetConnection/, '必须有端口实测命令')
assert.match(doc, /tools\/list/, '必须有 MCP 端点实测')
assert.match(doc, /addon_utils\.enable/, '必须有启用 addon 的可执行方式')
assert.match(doc, /不要为了绕过环境检查/, '必须显式禁止绕过')
/* 第⑦项验收：工具真的存在——这才是第③层的判据，端口探测证明不了 */
assert.match(doc, /⑦/, '验收清单必须有第 ⑦ 项')
assert.match(doc, /mcp__blender__get_scene_info[^\n]{0,120}(才算|判据|确认)/, '必须给「调一次 get_scene_info」这个最终判据')
/* 反绕过：点名 28 的无头路线与 27 的自救路线都不对 */
assert.match(doc, /blender -b/, '必须点名无头实例这条错路')
assert.match(doc, /Start-Process/, '必须点名自己拉服务器手调 JSON-RPC 也不对')

/* 配套 addon 是**单文件** blender_mcp.py，不是 zip 扩展包。
 * 这几条守住「别把文档改回解压 zip 的错误流程」——
 * 上游公开那套（zip + addon.py + 不同工具名）与本插件不兼容。 */
assert.match(doc, /blender_mcp\.py/, '必须写明 addon 是单文件 blender_mcp.py')
assert.match(doc, /scripts\\addons/, '必须给出单文件的正确落地目录')
assert.match(doc, /不要从网上随便找/, '必须明确禁止用上游版本顶替')
assert.doesNotMatch(doc, /Expand-Archive[^\n]*blender_mcp\.zip/, '不许出现解压 zip 装 addon 的流程')
assert.doesNotMatch(doc, /<上游发布地址>/, '占位符必须填实，不能留给读者')
/* MCP 服务器是 Node 实现，不是 Python 包 */
assert.match(doc, /start-server\.bat/, '必须给出真实启动脚本')
assert.match(doc, /src\\server\.mjs|src\/server\.mjs/, '必须指明 Node 入口')
assert.doesNotMatch(doc, /python -m blender_mcp\.server/, '不许写不存在的 Python 入口')
/* GitHub 地址必须写死；profile 路径要能从环境变量取 */
for (const url of ['github.com/panda472328/dsh-blender-mcp', 'github.com/panda472328/dsh-ptc-model-check']) {
  assert.ok(doc.includes(url), '文档必须给出地址：' + url)
}
assert.match(doc, /DSH_PROFILE_DIR/, 'profile 路径必须用环境变量，不能写死某台机器')
assert.doesNotMatch(doc, /APPDATA\\DeepSeek Harness/, '不要写不存在的 APPDATA 路径')
console.log('  ✓ 文档 ' + doc.length + ' 字符，四层依赖 + 地址齐全')

console.log('\n=== 8. 文档已随包发布 ===')
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
assert.ok(pkg.files.includes(DOC), 'files 里必须包含 ' + DOC + '，否则发出去会漏')
console.log('  ✓ package.json files 包含该文档')

console.log('\n=== 9. 第①层缺失：服务器在线但没注册进 DSH（建模测试 27/28 的真实故障） ===')
{
  /* 这是最危险的一类：ensureBlenderStack 全绿、br.ok 为 true，
   * 旧代码会显示「已就绪」，模型于是自己开无头 Blender 硬做，
   * 插件的检查与看图检测全程看不见那个场景 → 零检查交付。 */
  const online = {
    ok: true, launched: true, steps: ['MCP 服务器在线（12 个工具）', 'Blender addon 在线（端口 9876）'],
  }
  assert.equal(classifyEnv(online).kind, 'ok', '没有拒绝记录时仍算就绪')
  assert.equal(classifyEnv({ ...online, nativeMissing: true }).kind, 'mcp-not-registered')
  assert.equal(classifyEnv({ ...online, nativeMissing: true }).needsInstallDoc, true)

  const txt = buildStateText(stateWith({ ...online, nativeMissing: true, deniedCount: 3, lastNativeCall: 'mcp__blender__look' }))
  assert.match(txt, /MCP 服务器可达，但没接进 DSH/, '必须直说未注册')
  assert.match(txt, /被拒绝 3 次/, '要给事实，不给套话')
  assert.doesNotMatch(txt, /Blender 环境：\*\*已就绪\*\*/, '服务器在线绝不能报已就绪')
  assert.match(txt, /panda472328\/dsh-blender-mcp\/releases/, '要给出 bundle 下载地址')
  /* 反绕过：28 的失败方式就是 pwsh 起无头 Blender */
  assert.match(txt, /禁止绕过/, '必须禁止绕过注册')
  assert.match(txt, /blender -b|无头/, '要点名无头实例这条路')
  assert.match(txt, /零?没有做过任何几何检查|等于没有做过任何几何检查/, '必须说清后果')
  console.log('  ✓ 未注册压过 ok 分支，且禁止无头绕过')

  /* 只发一个包时，接收方的 AI 得能自己补齐第③层。
   * 它猜不出来的两件事必须直接给：安装文档绝对路径、当前 profile 绝对路径。 */
  const txt2 = buildStateText({
    ...stateWith({ ...online, nativeMissing: true, deniedCount: 1 }),
    installDocPath: 'D:\\profiles\\p1\\node_modules\\@local\\ptc-model-check\\docs\\install-blender-mcp.md',
    profileDir: 'D:\\profiles\\p1',
  })
  assert.match(txt2, /安装文档（绝对路径）：/, '必须给安装文档的绝对路径')
  assert.match(txt2, /当前 profile：D:\\profiles\\p1/, '必须给当前 profile 的绝对路径')
  assert.match(txt2, /没有 plugin_manager 工具/, '必须说明本模式拿不到 plugin_manager')
  assert.match(txt2, /plugin --profile p1 add file:/, '必须给出可执行的 CLI 安装命令（带真实 profile 名）')
  assert.match(txt2, /dsh\.profile\.bundles/, '要说明 CLI 会自动登记 bundle')
  assert.match(txt2, /releases\/latest\/download\/blender-mcp-1\.2\.3\.zip/, '要给可直接下载的直链')
  assert.doesNotMatch(txt2, /pnpm install/, '不能让自己装的人去跑 pnpm（陌生机器上没有）')
  assert.doesNotMatch(txt2, /[^\\]docs\/install-blender-mcp\.md/, '给了绝对路径就不该再出现相对路径')
  console.log('  ✓ 缺第③层时给出绝对路径与自装步骤（含 profile 与 bundles 登记）')
}

console.log('\n=== 10. isNativeToolMissing：只由真实失败置位 ===')
assert.equal(isNativeToolMissing('mcp__blender__look', { isError: true, error: { message: 'Tool "mcp__blender__look" not found' } }), true)
assert.equal(isNativeToolMissing('mcp__blender__look', { isError: true, content: [{ type: 'text', text: 'unknown tool' }] }), true)
assert.equal(isNativeToolMissing('mcp__blender__look', { isError: false }), false, '成功不能算缺失')
assert.equal(isNativeToolMissing('model_loop', { isError: true, error: { message: 'no such tool' } }), false, '只管原生前缀')
assert.equal(isNativeToolMissing('mcp__blender__look', { isError: true, error: { message: 'timeout' } }), false, '超时不等于没注册')
assert.equal(isNativeToolMissing('', null), false)
console.log('  ✓ 失败类型区分正确（超时/业务错误不误判）')

console.log('\n=== 11. server 脚本自动发现（mcpServerScript 为空时的兜底） ===')
const found = findMcpServerScript('', { packageDir: process.cwd() + '/ptc-model-check' })
if (found) {
  assert.match(found.script, /server\.mjs$/, '发现的必须是 server.mjs')
  assert.ok(['config', 'auto'].includes(found.source))
  console.log('  ✓ 本机发现: ' + found.script + ' (' + found.source + ')')
} else {
  console.log('  ✓ 本机没有配套包时返回 null（不抛错，走 mcp-script-missing）')
}
/* 显式路径写错时**不允许**静默回退到自动发现。
 * 这条是真实回归：bundle 装上以后，旧实现会在配置路径不存在时
 * 悄悄改用 profile 里那份脚本——可能拉起旧版本或别的机器拷来的包，比报错更难查。 */
const bogusDir = process.cwd() + '/ptc-model-check'
assert.equal(findMcpServerScript('Z:\\不存在\\server.mjs', { packageDir: bogusDir }), null,
  '显式路径不存在时必须返回 null，即使自动发现能找到别的脚本')
/* 关键回归：ensureBlenderStack 在找不到脚本时不能再报含糊的 action:'none' */
const boot = readFileSync(new URL('../lib/blender-boot.mjs', import.meta.url), 'utf8')
assert.match(boot, /action: 'mcp-script-missing'/, '缺脚本要报明确 action，不能再写 none')
assert.match(boot, /action: 'mcp-offline'/, '关了自动启动也要明确 action')
assert.match(boot, /nativeMissing/, 'classifyEnv 必须先看第①层信号')
console.log('  ✓ 两个含糊的 action:none 已拆分')

console.log('\n=== 12. 降级守卫：拿不到 classifyEnv 也不许崩 ===')
/* 生产里 classifyEnv 一定在；但状态组装位于每个请求的路径上，
 * 一旦这里抛错，整个请求会降级成「运行时状态生成失败」。
 * 所以源码里对它有 typeof 守卫，这里验证守卫真的生效。 */
const bare = new Function('PLUGIN_VERSION', 'buildDetailGuidance',
  src + '\nreturn buildStateText')('test', buildDetailGuidance)
const degraded = bare(stateWith({
  ok: false, launched: true, action: 'no-blender', steps: ['找不到 blender.exe'], hint: '装 Blender',
}))
assert.ok(typeof degraded === 'string' && degraded.length > 0, '不能抛异常')
assert.match(degraded, /Blender 环境/, '仍要给出环境结论')
assert.match(degraded, /install-blender-mcp/, '降级时也要指路到文档（缺环境就是缺环境）')
/* 降级时也必须能识别第①层缺失——那是最危险的一类故障 */
const degraded2 = bare(stateWith({
  ok: true, launched: true, nativeMissing: true, steps: ['MCP 服务器在线（12 个工具）'],
}))
assert.match(degraded2, /没接进 DSH/, '没有 classifyEnv 时也不能报已就绪')
assert.doesNotMatch(degraded2, /Blender 环境：\*\*已就绪\*\*/)
console.log('  ✓ 无 classifyEnv 时降级为粗判，仍能指路、仍能识别未注册')

console.log('\nENV_INSTALL_GUIDE_OK')
