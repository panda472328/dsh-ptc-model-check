/**
 * 场景级出图该框哪些对象。
 *
 * 问题（实测）：场景里常有远处环境物——星空球、地球、大气层。它们离主体几千单位、
 * 尺寸是主体的数倍。整场景取景以它们为准，主体就被压成亚像素，出图只剩背景色。
 *
 * 实测数据（建模测试27 的 AURORA-9 空间站）：
 *   主体 RING_DETAIL / CORE_MAST：71 ~ 79 单位，中心在原点
 *   ENV_ATMO / ENV_EARTH：425 ~ 462 单位，中心在 [3167, 4091, 4095]（约 6500 单位外）
 *   结果：look 整场景出图全灰；带 focus 指定主体才正常。
 *
 * 策略（两者结合，按顺序尝试）：
 *   ① **认集合名**：对象的 collection 或对象名里出现 env / sky / atmo / earth / ground
 *      / 环境 / 天空 之类的词元 → 判为环境，不参与取景。
 *   ② **统计离群**：认不出来时，按「离主体中心的距离」和「自身半对角线」取较大者打分，
 *      用「中位数 + k×MAD」剔除离群。能同时抓住「离得远」和「大得离谱」两种。
 *   ③ **两条兜底规则**（两种模式可信度不同，所以规则不同）：
 *      · 命名识别是**显式意图**——用户把东西放进叫 ENV_ROOT 的集合，就该信它。
 *        只要剔完还剩主体就照做，不设比例上限（否则「环境物占四成」的真实场景会被挡回）。
 *      · 统计离群是**推断**，可能误伤。除了「中位数 × 4」的量级地板，
 *        还靠中位数自身的鲁棒性兜底：离群对象接近或超过一半时中位数被污染，
 *        阈值随之失真，结果自然变成「一个都不剔」，回退到全部对象。
 *      任何情况下都不允许把主体剔空——宁可可能出空图，也不能框错东西。
 *
 * 被剔除的对象**仍然会被渲染**（hide_others 保持 false），只是不决定取景范围与缩放。
 */

/** 环境词的英文词元表（小写、按非字母数字切分后逐词比对） */
const ENV_TOKENS = new Set([
  'env', 'environment', 'background', 'bg', 'sky', 'skydome', 'atmosphere', 'atmo',
  'earth', 'ground', 'terrain', 'hdri', 'backdrop', 'starfield', 'stars',
])

/** 中文环境词（中文不切词，直接包含判断） */
const ENV_CJK = /环境|天空|地面|背景|大气|星空|宇宙/

/**
 * 这个集合名/对象名是不是「环境物」。
 *
 * 注意分词方式：`ENV_ROOT` → ['env','root']，`BG_SKY` → ['bg','sky']，
 * `ENVIRONMENT` → ['environment']，都命中；而 `STATION`、`RING_MAIN`、
 * `SOLAR_WINGS` 不命中。故意不收 'world'、'space'、'floor' 这类歧义词，
 * 因为「SPACE_STATION」会被切成 ['space','station'] 而误判。
 */
export function isEnvName(name) {
  const s = String(name || '')
  if (!s) return false
  if (ENV_CJK.test(s)) return true
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).some((t) => ENV_TOKENS.has(t))
}

/** 对象是否属于环境（集合名或对象名任一命中） */
function meshIsEnv(mesh) {
  const cols = (mesh.meta && mesh.meta.collections) || []
  if (cols.some(isEnvName)) return true
  return isEnvName(mesh.id) || isEnvName(mesh.part)
}

const centerOf = (mesh) => {
  const b = mesh.bbox || [0, 0, 0, 0, 0, 0]
  return [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2]
}

const halfDiagOf = (mesh) => (Number(mesh.diag) || 0) / 2

const median = (arr) => {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * 选场景取景对象。
 *
 * @param {Array} meshes 场景全部 mesh（makeMesh 结构，需含 bbox/dims/diag/meta.collections）
 * @param {object} [opts]
 * @param {number} [opts.k=6] 统计离群的 MAD 倍数
 * @returns {{names:string[], ids:string[], mode:'all'|'collection'|'outlier',
 *            excluded:string[], reason:string, dropped:number}}
 *
 * 关于 mode='all'：它既是「本来就是干净场景」，也是「统计法判断不了」的结果。
 * 后者发生在离群对象接近或超过一半时——中位数本身被污染，方法不猜，
 * 于是回退到全部对象。这是刻意的：宁可可能出空图，也不要框错东西。
 */
export function pickFramingFocus(meshes, opts = {}) {
  const list = (meshes || []).filter((m) => m && (m.id || m.part))
  const all = list.map((m) => String(m.id || m.part))

  if (list.length <= 1) {
    return { names: all, ids: all, mode: 'all', excluded: [], reason: '对象太少，无需筛选', dropped: 0 }
  }

  const k = Number(opts.k) || 6

  /* ① 认集合名 / 对象名。
   * 这是**显式意图**：用户把东西放进叫 ENV_ROOT 的集合，就该信它，
   * 所以不设比例上限，只要剔完还剩主体（model.length 已保证非空）。 */
  const envLike = list.filter(meshIsEnv)
  const model = list.filter((m) => !meshIsEnv(m))
  if (envLike.length && model.length) {
    return {
      names: model.map((m) => String(m.id || m.part)),
      ids: model.map((m) => String(m.id || m.part)),
      mode: 'collection',
      excluded: envLike.map((m) => String(m.id || m.part)),
      reason: '按集合/对象名识别出环境物',
      dropped: envLike.length,
    }
  }

  /* ② 统计离群 */
  const centers = list.map(centerOf)
  const cx = median(centers.map((c) => c[0]))
  const cy = median(centers.map((c) => c[1]))
  const cz = median(centers.map((c) => c[2]))
  const scores = list.map((m, i) => {
    const c = centers[i]
    const dist = Math.hypot(c[0] - cx, c[1] - cy, c[2] - cz)
    /* 取「离主体多远」和「自身多大」的较大者：
     * 远处的星空球靠前者命中，原点处铺开的巨地面靠后者命中。 */
    return Math.max(dist, halfDiagOf(m))
  })
  const med = median(scores)
  const mad = median(scores.map((s) => Math.abs(s - med)))
  /* 阈值 = max(中位数 + k×MAD, 中位数 × 4)。
   *
   * 为什么要有「中位数 × 4」这个地板：对象尺寸/位置都差不多时 MAD 会接近 0，
   * 纯 MAD 阈值会把「略大于中位数」的正常对象也剔掉。要求离群对象至少是中位数的
   * 4 倍，等于要求**量级上的确定差距**：实测两颗环境球分数 6500、中位数约 68，
   * 差 95 倍，稳定命中；而均匀铺开的场景没有对象达到 4 倍，一个都不剔。
   *
   * 注意中位数法最多抗 50% 污染：半个场景都在远处时中位数会被拉过去，
   * 此时方法选择「不猜」（回退 all），这是预期行为。 */
  const threshold = Math.max(med + k * mad, med * 4)

  const outliers = list.filter((m, i) => scores[i] > threshold)
  const kept = list.filter((m, i) => scores[i] <= threshold)
  /* 没有离群、或离群到把主体也吃掉了 → 不猜，回退全部对象。
   * 后一种情况就是「污染过半」：中位数被拉走，阈值跟着失真，此时任何剔除都不可信。 */
  if (!outliers.length || !kept.length) {
    return {
      names: all, ids: all, mode: 'all', excluded: [],
      reason: outliers.length ? '离群对象过多，放弃剔除以免误伤主体' : '未发现明显离群对象',
      dropped: 0,
    }
  }
  return {
    names: kept.map((m) => String(m.id || m.part)),
    ids: kept.map((m) => String(m.id || m.part)),
    mode: 'outlier',
    excluded: outliers.map((m) => String(m.id || m.part)),
    reason: '按中心距离/尺寸的统计离群剔除',
    dropped: outliers.length,
  }
}
