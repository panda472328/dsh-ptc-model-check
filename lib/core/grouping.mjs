/**
 * 分组：把场景里的 mesh 按「一个完整物品 + 它的配件」聚成组。
 *
 * 为什么需要分组：
 *   一个完整物品往往由多个 mesh 组成——
 *   桌子 = 桌面 + 4 条腿 + 靠背 + 抽屉；
 *   武器 = 刀身 + 护手 + 握把 + 缠绳；
 *   自行车 = 车架 + 前后轮 + 车把 + 座垫。
 *   检查「视角做完了没」时，看单块板子没有意义，
 *   要看的是**这个物品整体的各个方向**。
 *
 * 分组依据（按可靠性排序）：
 *   1. **命名前缀**：`桌_桌面` / `桌_腿1` 共享前缀「桌」。最可靠——
 *      建模时按 `<物品名>_<部件名>` 命名是通用习惯。
 *   2. **父级关系**：Blender 里 parent 到同一个空物体的，显然是一组。
 *   3. **空间邻近**：包围盒重叠或距离小于两者尺度的 30%，归为一组。
 *
 * 三种信号叠加使用：命名优先，没有命名信息时退到父级，再退到空间。
 */

/**
 * 从名字里提取「物品前缀」。
 *
 * 支持的命名习惯：
 *   桌_桌面      → 桌
 *   桌-腿1       → 桌
 *   桌.桌面      → 桌
 *   桌子|腿      → 桌子
 *   Table_Top    → Table
 *   TableLeg1    → TableLeg1（没有分隔符，无法提取，返回原名）
 */
export function extractGroupPrefix(name) {
  const s = String(name || '')
  if (!s) return s
  /* 按常见分隔符切第一个词 */
  const m = s.match(/^(.+?)[_\-.|:/\\ ]/)
  if (m && m[1] && m[1].length >= 1) return m[1]
  /* 驼峰：TableTop → Table（只取第一个大写词根） */
  const camel = s.match(/^([A-Z][a-z]+)/)
  if (camel) return camel[1]
  return s
}

/**
 * 把 mesh 列表聚成组。
 *
 * @param {Array} meshes
 * @param {object} [opts]
 * @param {number} [opts.proximityRatio] 空间邻近阈值（相对尺度，默认 0.3）
 * @returns {Array<{
 *   name:string, parts:string[], ids:string[], meshes:Array,
 *   dims:number[], bbox:number[], triangles:number, by:string
 * }>}
 */
export function groupMeshesIntoItems(meshes, opts = {}) {
  const proximityRatio = opts.proximityRatio ?? 0.3
  const list = (meshes || []).filter((m) => m && m.triangles > 0)
  if (list.length === 0) return []

  /* ⓪ **优先用 Blender 的真实 Collection 分组**。
   *
   * 这是最可靠的分组来源——它是用户在 Blender 里显式建的结构，
   * 不是靠命名推断。mesh 上的 meta.collections 是适配器读出来的
   * Collection 归属（见 blender.mjs / live.mjs）。
   *
   * 为什么优先 Collection：
   *   命名前缀只是**推断**，`桌面`、`桌腿` 这种不带分隔符的命名就失效了。
   *   Collection 是显式结构，不会猜错。
   *
   * 只有当「有 Collection 归属的 mesh 数量占多数」时才用 Collection 分组，
   * 否则说明用户没建组，退回推断模式。 */
  const withColl = list.filter((m) => m.meta && Array.isArray(m.meta.collections)
    && m.meta.collections.length > 0)
  const useCollections = withColl.length >= Math.max(2, Math.ceil(list.length * 0.5))

  let groups = []

  if (useCollections) {
    /* 一个 mesh 可能属于多个 Collection（嵌套）。
     * 取它所在的**最深**那个作为物品组——
     * 越深越具体，顶层通常是「Scene Collection」这种泛容器。 */
    const byColl = new Map()
    for (const m of list) {
      const cols = (m.meta && Array.isArray(m.meta.collections)) ? m.meta.collections : []
      /* 过滤掉明显的容器名 */
      const meaningful = cols.filter((c) => c && !/^(Scene Collection|Collection)$/.test(c))
      const key = meaningful.length ? meaningful[meaningful.length - 1] : null
      if (!key) continue
      if (!byColl.has(key)) byColl.set(key, [])
      byColl.get(key).push(m)
    }
    if (byColl.size > 0) {
      for (const [name, members] of byColl) {
        groups.push({ name, members, by: 'collection' })
      }
      /* 顺手把没归组的 mesh 也收进一个「未分组」组，
       * 这样模型能看到「有东西漏分组了」 */
      const groupedIds = new Set()
      for (const g of groups) for (const m of g.members) groupedIds.add(m.id)
      const leftovers = list.filter((m) => !groupedIds.has(m.id))
      if (leftovers.length) {
        groups.push({ name: '未分组', members: leftovers, by: 'ungrouped' })
      }
      return finalizeGroups(groups)
    }
  }

  /* ① 没有 Collection 信息时，按命名前缀分组 */
  const byPrefix = new Map()
  for (const m of list) {
    const key = extractGroupPrefix(m.part || m.id)
    if (!byPrefix.has(key)) byPrefix.set(key, [])
    byPrefix.get(key).push(m)
  }

  /* 前缀分组只在「组里有多个成员」时才可信。
   * 如果每个 mesh 的前缀都不一样（命名没规律），就退到空间聚类。 */
  const multiMember = [...byPrefix.values()].filter((g) => g.length > 1)
  const usePrefix = multiMember.length > 0 && multiMember.length <= list.length

  if (usePrefix) {
    for (const [name, members] of byPrefix) {
      groups.push({ name, members, by: 'prefix' })
    }
  } else {
    /* ② 退到空间聚类：相邻的归一组 */
    groups = clusterByProximity(list, proximityRatio)
  }

  return finalizeGroups(groups)
}

/**
 * 把内部 groups 结构整理成对外格式（算包围盒、尺寸、面数）。
 */
function finalizeGroups(groups) {

  /* ③ 组装输出 */
  const out = groups.map((g) => {
    const ms = g.members
    const bbox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
    let tris = 0
    for (const m of ms) {
      tris += m.triangles
      for (let i = 0; i < 3; i++) {
        bbox[i] = Math.min(bbox[i], m.bbox[i])
        bbox[i + 3] = Math.max(bbox[i + 3], m.bbox[i + 3])
      }
    }
    return {
      name: g.name,
      parts: ms.map((m) => m.part || m.id),
      ids: ms.map((m) => m.id),
      meshes: ms,
      dims: [bbox[3] - bbox[0], bbox[4] - bbox[1], bbox[5] - bbox[2]],
      bbox,
      triangles: tris,
      by: g.by,
    }
  })

  /* 按体量排序：大的组更可能是场景主体，优先检查 */
  out.sort((a, b) => b.triangles - a.triangles)
  return out
}

/**
 * 按空间邻近聚类（并查集）。
 *
 * 两个 mesh 归为一组的条件：包围盒间距 < 两者较大尺度的 proximityRatio 倍。
 */
function clusterByProximity(meshes, ratio) {
  const n = meshes.length
  const parent = new Int32Array(n)
  for (let i = 0; i < n; i++) parent[i] = i
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }
  const union = (a, b) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }

  const boxGap = (a, b) => {
    const dx = Math.max(0, Math.max(a.bbox[0] - b.bbox[3], b.bbox[0] - a.bbox[3]))
    const dy = Math.max(0, Math.max(a.bbox[1] - b.bbox[4], b.bbox[1] - a.bbox[4]))
    const dz = Math.max(0, Math.max(a.bbox[2] - b.bbox[5], b.bbox[2] - a.bbox[5]))
    return Math.hypot(dx, dy, dz)
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const scale = Math.max(meshes[i].diag || 0, meshes[j].diag || 0)
      const limit = Math.max(1e-6, scale * ratio)
      if (boxGap(meshes[i], meshes[j]) <= limit) union(i, j)
    }
  }

  const groups = new Map()
  for (let i = 0; i < n; i++) {
    const r = find(i)
    if (!groups.has(r)) groups.set(r, [])
    groups.get(r).push(meshes[i])
  }
  return [...groups.values()].map((members, idx) => ({
    name: members.length === 1
      ? (members[0].part || members[0].id)
      : '组' + (idx + 1) + '（' + members.length + ' 件）',
    members,
    by: 'proximity',
  }))
}

/**
 * 挑出本次要渲染五视图的组。
 *
 * **默认就是全部组都渲染**——因为「每个组都要看图判断结构对不对」
 * 是硬性要求，不是可选项。只有显式传 limit 时才截断。
 *
 * 排序只影响**渲染顺序**（有问题的排在前面，先看），不影响「渲不渲」。
 * 之前的实现按 limit 截断，导致大场景里只有前几组能出图，
 * 剩下的组「没看过」——而没看过就无法判断结构对不对。
 */
export function pickGroupsForViews(groups, each, limitOrNull) {
  const problemIds = new Set((each?.problems || []).map((p) => p.mesh?.id).filter(Boolean))
  const outlierIds = new Set((each?.outliers || []).map((o) => o.id).filter(Boolean))

  const scored = groups.map((g) => {
    let score = 0
    let reason = ''
    const hasProblem = g.ids.some((id) => problemIds.has(id))
    const hasOutlier = g.ids.some((id) => outlierIds.has(id))
    if (hasProblem) { score += 1e9; reason = '组内有自身不完整的 mesh' }
    else if (hasOutlier) { score += 1e6; reason = '组内有精度离群的 mesh' }
    score += g.triangles / 1000
    return { ...g, score, reason }
  })

  /* 有问题的排前面（先看），其余按体量 */
  scored.sort((a, b) => b.score - a.score)
  /* limit 为 null / undefined / <=0 → 全部返回 */
  if (!limitOrNull || limitOrNull <= 0) return scored
  return scored.slice(0, limitOrNull)
}

/**
 * 按组分析穿模。
 *
 * **区分两种穿模，性质完全不同：**
 *
 * | 类型 | 含义 | 该不该管 |
 * |---|---|---|
 * | **组内**（同一物品的部件之间） | 桌子腿插进桌面、椅子靠背插进座面 | 通常是**有意设计**——插接比对接更牢固。只有穿得太深才是问题 |
 * | **组间**（不同物品之间） | 椅子穿进桌子、道具穿进墙 | 几乎**一定是错误**——两个物体不能占同一块空间 |
 *
 * 混在一起报会导致：模型的正常插接结构被误判成错误，
 * 而真正的组间碰撞淹没在一堆正常项里看不见。
 *
 * @param {Array} groups groupMeshesIntoItems 的结果
 * @param {Array} pairs  interferencePairs 返回的 hits
 * @returns {{perGroup:Array, crossGroup:Array, internalCount:number, crossCount:number}}
 */
export function analyzeGroupInterference(groups, pairs) {
  /* 建 id → 组 的索引 */
  const idToGroup = new Map()
  for (const g of groups) {
    for (const id of g.ids) idToGroup.set(id, g)
  }

  const perGroupMap = new Map()
  for (const g of groups) {
    perGroupMap.set(g.name, {
      name: g.name,
      parts: g.parts,
      internal: [],
      cross: [],
    })
  }

  const crossGroup = []

  for (const p of (pairs || [])) {
    const ga = idToGroup.get(p.aId)
    const gb = idToGroup.get(p.bId)
    /* 穿出状态：这类即使发生在组内也必须修 */
    const severe = p.state === 'poke-through' || p.state === 'mutual' || p.state === 'coincident'

    if (ga && gb && ga.name === gb.name) {
      /* 组内穿模 */
      const rec = perGroupMap.get(ga.name)
      if (rec) rec.internal.push(p)
    } else {
      /* 组间穿模（含「有一方不属于任何组」的情况） */
      const rec = {
        a: p.a, b: p.b,
        aGroup: ga ? ga.name : null,
        bGroup: gb ? gb.name : null,
        depth: p.depth, depthMean: p.depthMean,
        ratio: p.ratio, overlapFaces: p.overlapFaces,
        overlapCapped: p.overlapCapped,
        state: p.state,
        stateLabel: p.stateLabel,
        axisName: p.axisName,
        stateDetail: p.stateDetail,
        severe,
      }
      crossGroup.push(rec)
      if (ga) {
        const r = perGroupMap.get(ga.name)
        if (r) r.cross.push(rec)
      }
      if (gb && gb.name !== (ga ? ga.name : null)) {
        const r = perGroupMap.get(gb.name)
        if (r) r.cross.push(rec)
      }
    }
  }

  const perGroup = [...perGroupMap.values()]
  const internalCount = perGroup.reduce((s, g) => s + g.internal.length, 0)
  /* 组内穿出的数量：这个即使组内也必须修 */
  const internalPokeCount = perGroup.reduce(
    (s, g) => s + g.internal.filter((p) => p.state === 'poke-through'
      || p.state === 'mutual' || p.state === 'coincident').length, 0)

  /* 组内穿模按严重度排序：穿出优先，然后按深度 */
  for (const g of perGroup) {
    g.internal.sort((x, y) => {
      const sx = (x.state === 'poke-through' || x.state === 'mutual' || x.state === 'coincident') ? 1 : 0
      const sy = (y.state === 'poke-through' || y.state === 'mutual' || y.state === 'coincident') ? 1 : 0
      return sy - sx || y.depth - x.depth
    })
    g.internalPokeCount = g.internal.filter(
      (p) => p.state === 'poke-through' || p.state === 'mutual' || p.state === 'coincident').length
  }
  crossGroup.sort((x, y) => (y.severe ? 1 : 0) - (x.severe ? 1 : 0) || y.depth - x.depth)

  return {
    perGroup,
    crossGroup,
    internalCount,
    internalPokeCount,
    crossCount: crossGroup.length,
    crossPokeCount: crossGroup.filter((c) => c.severe).length,
  }
}
