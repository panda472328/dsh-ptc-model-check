/**
 * 孤立件的「现实合理性」追问。
 *
 * 为什么需要：孤立检测只能告诉你「这个 mesh 和谁都不挨着」，
 * 但**挨不着不等于错**。现实里大量部件本来就是独立的——
 * 悬挂的灯、飞在空中的子弹、脱手的刀、远处的地标。
 *
 * 直接判错会让模型去「修」一个本来正确的东西，越改越糟。
 * 所以检测到孤立后必须先过一道现实判断：这个部件在现实里该不该
 * 和别的东西挨着？
 *
 * 这个模块不替模型做判断，只负责：
 *   1. 按几何特征给出**可能的合理类型**（悬挂/飞行/背景/独立件）
 *   2. 生成一句必须回答的追问
 *   3. 让模型明确表态：合理 → 保留；不合理 → 修
 */

/**
 * 根据尺寸、位置、命名给出「可能合理」的猜测。
 *
 * 全部基于弱信号，只用来提示模型「有这么几种可能」，
 * 不构成结论。命名匹配是最强的信号，所以优先用。
 */
const REASONABLE_PATTERNS = [
  { re: /light|lamp|bulb|灯|光|吊/i, kind: '悬挂物', why: '灯具通常是吊装或壁装的，本来就不接触地面或主体' },
  { re: /bullet|projectile|shot|弹|抛射|飞行/i, kind: '飞行物', why: '抛射物在飞行瞬间不和任何东西接触' },
  { re: /cloud|sky|背景|远景|天空|distant/i, kind: '背景元素', why: '天空、远山这类元素本来就独立于主体' },
  { re: /particle|debris|dust|粒子|碎屑|尘埃/i, kind: '粒子/碎屑', why: '粒子系统产生的独立元素' },
  { re: /cable|wire|rope|线缆|绳索|链/i, kind: '线缆/绳索', why: '悬垂的线缆两端固定、中段悬空是正常的' },
  { re: /shadow|reflection|gizmo|helper|辅助|参考/i, kind: '辅助对象', why: '阴影、反射、gizmo 这类不是实际几何' },
  { re: /wheel|gear|轴承|齿轮|轮/i, kind: '可动件', why: '有些可动件只通过轴连接，外形上可能不接触其它零件' },
]

/**
 * 给一个孤立件生成现实合理性追问。
 *
 * @param {object} hit isolatedMeshes 返回的条目
 * @param {object} [ctx] 上下文（场景尺度等）
 * @returns {{hint:string, candidates:Array<{kind:string,why:string}>, question:string}}
 */
export function realityCheck(hit, ctx = {}) {
  const part = String(hit.part || hit.id || '')
  const dims = hit.dims || [0, 0, 0]
  const maxDim = Math.max(...dims.map((d) => Math.abs(Number(d) || 0)))
  const sceneDiag = Number(ctx.sceneDiag) || 0

  /* 命名匹配：最强的信号 */
  const candidates = []
  for (const p of REASONABLE_PATTERNS) {
    if (p.re.test(part)) candidates.push({ kind: p.kind, why: p.why })
  }

  /* 尺寸信号：远小于场景尺度的孤立件，更可能是细节/粒子而不是漏摆的主体 */
  if (sceneDiag > 0 && maxDim > 0) {
    const rel = maxDim / sceneDiag
    if (rel < 0.02) {
      candidates.push({
        kind: '小尺寸细节',
        why: '它的尺寸只有场景对角线的 ' + (rel * 100).toFixed(1) + '%，'
          + '如果是装饰钉、铆钉、按钮这类，独立存在可能正常',
      })
    }
  }

  /* 距离信号：极远的孤立件，可能是背景/远景 */
  if (Number.isFinite(hit.gap) && sceneDiag > 0 && hit.gap > sceneDiag) {
    candidates.push({
      kind: '远处背景',
      why: '它离最近的部件比整个场景的尺度还远，可能是有意放远的背景元素',
    })
  }

  let hint
  if (candidates.length) {
    hint = '可能合理的类型：' + candidates.map((c) => c.kind).join(' / ')
  } else {
    hint = '没有明显的合理迹象——名字里没有悬挂/飞行/背景这类词，尺寸也不像细节件'
  }

  const question = '「' + part + '」在现实里应该和别的东西挨着吗？'
    + '如果你能说清它为什么独立（比如吊在空中、正在飞行、是远景元素），就保留它，'
    + '不要为了「通过检查」硬把它贴上去。如果说不清，说明它确实漏摆或错位了，必须修。'

  return { hint, candidates, question }
}

/**
 * 把一批孤立件转成「必须先做现实判断」的文本块。
 *
 * @param {Array} hits
 * @param {object} ctx
 * @returns {string[]} 文本行
 */
export function realityCheckLines(hits, ctx = {}) {
  if (!hits || hits.length === 0) return []
  const lines = []
  lines.push('')
  lines.push('⚠ 这些部件和谁都不接触。**先别急着判定成错误**——')
  lines.push('   现实里大量部件本来就是独立的（吊灯、飞行的子弹、远景、粒子、悬垂的线缆）。')
  lines.push('   逐个回答下面的问题：')
  for (const h of hits) {
    const rc = realityCheck(h, ctx)
    lines.push('')
    lines.push('   · ' + rc.question)
    lines.push('     ' + rc.hint)
  }
  lines.push('')
  lines.push('   **判断规则**：')
  lines.push('   - 能说清「为什么它该独立」→ 保留，这个孤立件是合理的，不算问题')
  lines.push('   - 说不清 → 它确实漏摆/错位/该连没连，必须修')
  return lines
}
