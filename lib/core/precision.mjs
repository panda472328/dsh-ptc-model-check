/**
 * 精度一致性与单 mesh 隔离检查。
 *
 * 解决两个问题：
 *
 * 1. **隔离检查**：整场景检查会把「小零件藏在别的零件里」这类问题掩盖掉。
 *    单独隔离每个 mesh 看一遍，能发现：
 *      - 这个 mesh 自己是不是完整的（闭合、无孤立碎片、无退化面）
 *      - 它的精度够不够（分段数相对尺寸是否合理）
 *      - 它有没有自穿模（自己和自己交叉）
 *
 * 2. **精度一致性**：同一场景里不同零件如果面数密度差几个数量级，看起来就会
 *    「一个有细节、一个是纸片」。用户要的是「各个模型的精度一致」。
 *
 * 「精度」的定义很关键。不能用绝对面数——一个 10cm 的螺丝和一个 2m 的箱体
 * 面数当然不同。所以用**面密度**：
 *
 *   面密度 = 三角形数 / (表面积 / 特征尺寸²)
 *
 * 更实用的简化：**三角形数 / 表面积**（面积单位内的三角面数）。
 * 它反映「表面细分得多细」，与物体尺寸无关，这正是「精度」的含义。
 *
 * 同时用「每个三角形平均边长 / 零件对角线」作为辅助指标——
 * 它反映「相对细分的粗细」，能发现「小零件用了大粒度网格」这种问题。
 */

/**
 * 算一个 mesh 的表面积。
 */
export function surfaceArea(mesh) {
  const { positions, indices, triangles } = mesh
  let area = 0
  for (let t = 0; t < triangles; t++) {
    const i0 = indices[t * 3] * 3
    const i1 = indices[t * 3 + 1] * 3
    const i2 = indices[t * 3 + 2] * 3
    const ax = positions[i1] - positions[i0]
    const ay = positions[i1 + 1] - positions[i0 + 1]
    const az = positions[i1 + 2] - positions[i0 + 2]
    const bx = positions[i2] - positions[i0]
    const by = positions[i2 + 1] - positions[i0 + 1]
    const bz = positions[i2 + 2] - positions[i0 + 2]
    const cx = ay * bz - az * by
    const cy = az * bx - ax * bz
    const cz = ax * by - ay * bx
    area += Math.hypot(cx, cy, cz) * 0.5
  }
  return area
}

/**
 * 算一个 mesh 的所有边长统计（三角形三条边）。
 * 返回平均、中位、最大边长。
 */
export function edgeStats(mesh) {
  const { positions, indices, triangles } = mesh
  if (triangles === 0) return { mean: 0, median: 0, max: 0, count: 0 }

  /* 用采样法算中位数——三角形可能上百万，全量排序太慢。
   * 平均和最大可以全量算，中位数用直方图近似。 */
  let sum = 0
  let max = 0
  let count = 0
  const BINS = 256
  let binMax = 0
  const lengths = []

  const sampleStride = Math.max(1, Math.floor(triangles / 50000))
  for (let t = 0; t < triangles; t++) {
    const base = t * 3
    for (let e = 0; e < 3; e++) {
      const a = indices[base + e] * 3
      const b = indices[base + ((e + 1) % 3)] * 3
      const dx = positions[b] - positions[a]
      const dy = positions[b + 1] - positions[a + 1]
      const dz = positions[b + 2] - positions[a + 2]
      const len = Math.hypot(dx, dy, dz)
      sum += len
      count++
      if (len > max) max = len
      if (t % sampleStride === 0) lengths.push(len)
    }
  }

  lengths.sort((x, y) => x - y)
  const median = lengths.length
    ? lengths[Math.floor(lengths.length / 2)]
    : 0

  return {
    mean: count ? sum / count : 0,
    median,
    max,
    count,
  }
}

/**
 * 精度指标：面密度 + 相对边长。
 *
 * @returns {{
 *   area:number, triangles:number, vertices:number,
 *   faceDensity:number,      // 三角形数 / 表面积（每平方单位的三角面数）
 *   faceDensityRel:number,   // 相对密度：与「对角线²」归一化后的密度
 *   edgeRatio:number,        // 平均边长 / 对角线（越小越细）
 *   diag:number
 * }}
 */
export function precisionOf(mesh) {
  const area = surfaceArea(mesh)
  const edges = edgeStats(mesh)
  const diag = Math.max(1e-9, mesh.diag)

  /* faceDensity：每平方单位有多少三角面。
   * 面积接近 0 的退化 mesh 返回 0，避免除零。 */
  const faceDensity = area > 1e-12 ? mesh.triangles / area : 0

  /* 相对精度的正确度量：**平均三角形边长 / 特征长度**。
   *
   * 为什么不用「密度 × 对角线²」：那个公式假设物体是单一块状，
   * 对角线能代表它的尺度。但对「由很多小段拼成」的 mesh（人行道、
   * 栏杆、围栏），对角线是整个拼装体的尺寸，而三角面只在小段上密集，
   * 算出来会虚高几十倍——那是公式的错，不是模型的错。
   *
   * 更稳的做法：看「一个三角面有多小」相对「这个物体有多大」。
   *   特征长度 = sqrt(表面积)  （对任何形状都成立：球、平面、碎块集）
   *   relativeEdge = 平均边长 / 特征长度
   * 这个值直接反映「表面被切成多细」，与块数、拼装方式无关。
   *
   * 举例：
   *   2×2×2 立方体，12 面 → 面积 24，边长 2 → 特征长度 4.9，比 0.41
   *   同尺寸 768 面       → 边长 0.25      → 比 0.05（细了 8 倍）
   *   人行道（碎块多）    → 按面积算，不会被块数放大
   */
  const charLength = area > 1e-12 ? Math.sqrt(area) : diag
  const relativeEdge = charLength > 1e-9 ? edges.mean / charLength : 0

  /* 相对密度：每平方特征长度上的三角面数，等价于 (1/relativeEdge)² 的量级。
   * 保留这个数值便于人读，但离群判定用 relativeEdge。 */
  const faceDensityRel = charLength > 1e-9
    ? (mesh.triangles / area) * charLength * charLength
    : 0

  /* edgeRatio：平均边长相对对角线。越小说明相对细分越细。 */
  const edgeRatio = diag > 1e-9 ? edges.mean / diag : 0

  return {
    area: Number(area.toFixed(6)),
    triangles: mesh.triangles,
    vertices: mesh.vertices,
    faceDensity: Number(faceDensity.toFixed(2)),
    faceDensityRel: Number(faceDensityRel.toFixed(3)),
    /* 主判据 */
    relativeEdge: Number(relativeEdge.toFixed(5)),
    charLength: Number(charLength.toFixed(5)),
    edgeRatio: Number(edgeRatio.toFixed(5)),
    edgeMean: Number(edges.mean.toFixed(5)),
    edgeMedian: Number(edges.median.toFixed(5)),
    edgeMax: Number(edges.max.toFixed(5)),
    diag: Number(diag.toFixed(5)),
  }
}

/**
 * 找出精度明显偏离主流的 mesh。
 *
 * **关键认识：不同功能的零件，精度本来就该不同。**
 *
 * 一个真实街景里：
 *   - 地面：12 个面铺满 5 万平方单位，完全正确（它就是个平面）
 *   - 建筑立面：上千面做出窗框细节，也正确
 *   - 易拉罐大小的垃圾桶：几百面做出圆角，正确
 *
 * 所以「所有零件精度一致」这个说法要精确化。真正该一致的是：
 * **同类零件之间**的精度应该一致。
 *
 * 于是判定分两步：
 *
 * 1. **按尺寸分组**：把 mesh 按「特征长度」分成几个量级
 *    （大件/中件/小件）。同组内比较才有意义——一个 200 单位的
 *    地面和一个 2 单位的垃圾桶，不该用同一个标准。
 *
 * 2. **组内找离群**：在每一组内部，用相对粒度找明显偏离的。
 *
 * 这样「地面很粗」不会被报（组内都是大件，它不突出），
 * 而「小垃圾桶用了 5 个面」会被报（同组的小件都比它细）。
 */
export function precisionOutliers(items, opts = {}) {
  const pct = opts.pct ?? 0.1
  const hardRatio = opts.hardRatio ?? 3
  /* 尺寸分组：特征长度相差多少倍算不同量级（默认 8 倍，约 3 个档位） */
  const sizeGroups = opts.sizeGroups ?? 3

  const valid = items.filter((x) => x.precision.relativeEdge > 0
    && x.precision.charLength > 0
    && x.precision.triangles > 0)
  if (valid.length < 4) return { outliers: [], median: null, tooFew: true }

  /* 按特征长度分组：**相邻尺寸差不超过 sizeTol 倍的算同一组**。
   *
   * 为什么不用等距切分：等距切分在尺寸几乎相同时会把相邻的东西切开
   *（4.9 和 5.3 差 8%，却被分到不同组），那毫无道理。
   *
   * 改成「相邻聚类」：排好序后逐个看，如果和前一个差得不超过 sizeTol 倍，
   * 就归入同组。这样尺寸相近的必然同组，只有真正差一个量级的才分开。 */
  const sizeTol = opts.sizeTol ?? 3
  const bySize = [...valid].sort((a, b) => a.precision.charLength - b.precision.charLength)
  const groups = new Map()
  let gi = 0
  let groupStart = bySize[0].precision.charLength
  for (const x of bySize) {
    /* 如果当前尺寸超过组起点的 sizeTol 倍，就开新组 */
    if (x.precision.charLength > groupStart * sizeTol) {
      gi++
      groupStart = x.precision.charLength
    }
    if (!groups.has(gi)) groups.set(gi, [])
    groups.get(gi).push(x)
  }

  const outliers = []
  const groupInfo = []

  for (const [gi, members] of groups) {
    /* 组内太少就没有比较意义——单独一两个零件无所谓「不一致」 */
    const minGroup = opts.minGroup ?? 4
    if (members.length < minGroup) {
      groupInfo.push({
        group: gi,
        size: members.length,
        medianEdge: null,
        note: '只有 ' + members.length + ' 个，少于 ' + minGroup + ' 个阈值，跳过组内比较',
      })
      continue
    }

    const sortedG = [...members].sort(
      (a, b) => a.precision.relativeEdge - b.precision.relativeEdge,
    )
    const medEdge = median(sortedG.map((x) => x.precision.relativeEdge))
    const tailCount = Math.max(1, Math.floor(sortedG.length * pct))
    const lowBound = sortedG[tailCount - 1].precision.relativeEdge
    const highBound = sortedG[sortedG.length - tailCount].precision.relativeEdge

    /* 组内精度跨度本来就很小时的保护：
     * 如果最粗和最细差不到 2 倍，说明这一组精度很整齐，
     * 硬挑「相对最粗的那个」没有意义——它只是稍微糙一点，不是问题。 */
    const groupSpan = sortedG[sortedG.length - 1].precision.relativeEdge
      / Math.max(1e-9, sortedG[0].precision.relativeEdge)
    const minSpan = opts.minGroupSpan ?? 2
    if (groupSpan < minSpan) {
      groupInfo.push({
        group: gi,
        size: sortedG.length,
        charLengthRange: [
          Number(sortedG[0].precision.charLength.toFixed(2)),
          Number(sortedG[sortedG.length - 1].precision.charLength.toFixed(2)),
        ],
        medianEdge: Number(medEdge.toFixed(5)),
        note: '组内精度跨度只有 ' + groupSpan.toFixed(2) + ' 倍（< ' + minSpan + '），说明这组很整齐，跳过',
      })
      continue
    }

    groupInfo.push({
      group: gi,
      size: sortedG.length,
      charLengthRange: [
        Number(sortedG[0].precision.charLength.toFixed(2)),
        Number(sortedG[sortedG.length - 1].precision.charLength.toFixed(2)),
      ],
      medianEdge: Number(medEdge.toFixed(5)),
      span: Number(groupSpan.toFixed(2)),
    })

    for (const x of sortedG) {
      const rel = x.precision.relativeEdge
      const issues = []

      /* 大件豁免：如果这个零件「面数极少但面积很大」，
       * 它很可能就是一个平面（地面、墙面、地砖），本来就不需要细分。
       * 报它「比同组糙」是错的——平面做成平面是对的。
       *
       * 判据：面数相对面积少得离谱（每 1000 平方单位不到 1 个面），
       * 且三角形数量绝对值很小（<100）。两者同时满足才算平面。 */
      const isLikelyPlanar = x.precision.triangles < 100
        && x.precision.area > 0
        && x.precision.triangles / x.precision.area < 0.001

      /* 组内尾部的「明显更糙」——这个才值得报：
       * 同量级的东西，为什么这个特别糙？ */
      if (rel >= highBound && medEdge > 0 && rel / medEdge >= hardRatio) {
        if (isLikelyPlanar) {
          /* 平面不报，但记一笔说明为什么豁免 */
          groupInfo.push({
            group: gi,
            size: sortedG.length,
            planarDetected: x.mesh.part,
            note: '「' + x.mesh.part + '」只有 ' + x.precision.triangles + ' 个面覆盖 '
              + x.precision.area.toFixed(0) + ' 平方单位，看起来是纯平面，'
              + '不参与精度比较（平面做成平面是对的）',
          })
        } else {
          issues.push({
            kind: 'coarser-than-peers',
            detail: '同尺寸档内，它的网格粒度是中位数的 ' + (rel / medEdge).toFixed(1) + ' 倍'
              + '（三角形平均边长占特征长度 ' + (rel * 100).toFixed(2) + '%，同档中位数 '
              + (medEdge * 100).toFixed(2) + '%）。'
              + '和它体量相近的零件都比它细——如果它有曲面或圆角，会显得有棱角。',
          })
        }
      }
      /* 组内尾部的「明显更细」——通常是过度细分。
       *
       * 但**曲面零件本来就需要更多细分**：圆柱、球、圆角容器
       * 如果用低面数就是多边形棱角，那才是错的。
       *
       * 判断依据：算「这个物体有多少比例是曲面」——用
       * 「顶点数 / 三角形数」看拓扑密度，再结合精度。
       * 更实用的做法：看它是否显著比同组更细**且**不是圆润形状。
       *
       * 简化判据：如果它非常细（relativeEdge 很小）且三角形数远超同组中位，
       * 那就是细分过度；如果只是中等更细，放过。 */
      if (rel <= lowBound && medEdge > 0 && rel / medEdge <= 1 / hardRatio) {
        const triMedian = median(sortedG.map((y) => y.precision.triangles))
        const triRatio = triMedian > 0 ? x.precision.triangles / triMedian : 1
        /* 只有三角形数也远超同组中位（3 倍以上）才报——
         * 单纯粒度更细但面数正常，说明它是小尺寸高细节零件，合理。 */
        if (triRatio >= 3) {
          issues.push({
            kind: 'denser-than-peers',
            detail: '同尺寸档内，它的网格粒度只有中位数的 1/'
              + (medEdge / rel).toFixed(1) + '，且三角面数是同档中位数的 '
              + triRatio.toFixed(1) + ' 倍（' + x.precision.triangles + ' 面 vs 中位 '
              + Math.round(triMedian) + ' 面）。'
              + '同量级的零件都比它省——如果它不是圆润曲面/需要精细倒角的零件，'
              + '检查是否有多余的细分段数',
          })
        }
      }

      if (issues.length) {
        outliers.push({
          part: x.mesh.part,
          id: x.mesh.id,
          precision: x.precision,
          sizeGroup: gi,
          issues,
        })
      }
    }
  }

  const allEdges = valid.map((x) => x.precision.relativeEdge)
  return {
    outliers,
    median: {
      relativeEdge: Number(median(allEdges).toFixed(5)),
      faceDensityRel: Number(median(valid.map((x) => x.precision.faceDensityRel)).toFixed(3)),
    },
    checked: valid.length,
    groups: groupInfo,
    distribution: {
      min: Number(Math.min(...allEdges).toFixed(5)),
      max: Number(Math.max(...allEdges).toFixed(5)),
      span: Number((Math.max(...allEdges) / Math.max(1e-9, Math.min(...allEdges))).toFixed(1)),
    },
  }
}

function median(arr) {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

/**
 * 单 mesh 隔离检查：把这个 mesh 当成唯一对象看一遍。
 *
 * 检查项（都与其它 mesh 无关，只看它自己）：
 *   1. 退化面：面积为 0 或极小的三角形
 *   2. 孤立碎片：这个 mesh 内部是否有多个不连通的块
 *   3. 重复顶点：同一位置有多个顶点（说明焊接有问题）
 *   4. 尺寸异常：某个维度远大于或远小于其它维度
 *   5. 空 mesh
 *
 * @returns {{
 *   part:string, id:string,
 *   ok:boolean,
 *   degenerate:number,
 *   islands:number,
 *   duplicateVerts:number,
 *   issues:Array<{kind:string, detail:string}>
 * }}
 */
export function isolatedMeshCheck(mesh, opts = {}) {
  const degenerateTol = opts.degenerateTol ?? 1e-12
  const weldTol = opts.weldTol ?? 1e-6

  const issues = []
  const { positions, indices, triangles, vertices } = mesh

  if (triangles === 0) {
    return {
      part: mesh.part, id: mesh.id, ok: false,
      degenerate: 0, islands: 0, biggestIsland: 0, avgIsland: 0,
      fragmented: false, duplicateVerts: 0, duplicateRatio: 0,
      issues: [{ kind: 'empty', detail: '这个 mesh 没有任何三角面' }],
    }
  }

  /* ① 退化面：面积接近 0。
   *
   * **少量退化面是常态，不是错误**。真实模型里它们大量合法存在：
   *   - 圆锥/球体的极点：所有经线收于一点，必然产生退化三角
   *   - 针叶、草叶这类细长几何
   *   - 导入的模型里常见的零面积面
   *   - 布尔运算的残留（这类才需要清）
   *
   * 所以用**比例**判定，而不是「有一个就报」。
   * 超过 25% 才是异常——那时法线计算会明显出错、渲染出现黑面。 */
  let degenerate = 0
  for (let t = 0; t < triangles; t++) {
    const i0 = indices[t * 3] * 3
    const i1 = indices[t * 3 + 1] * 3
    const i2 = indices[t * 3 + 2] * 3
    const ax = positions[i1] - positions[i0]
    const ay = positions[i1 + 1] - positions[i0 + 1]
    const az = positions[i1 + 2] - positions[i0 + 2]
    const bx = positions[i2] - positions[i0]
    const by = positions[i2 + 1] - positions[i0 + 1]
    const bz = positions[i2 + 2] - positions[i0 + 2]
    const cx = ay * bz - az * by
    const cy = az * bx - ax * bz
    const cz = ax * by - ay * bx
    const area = Math.hypot(cx, cy, cz) * 0.5
    if (area <= degenerateTol) degenerate++
  }
  const degenerateRatio = triangles > 0 ? degenerate / triangles : 0
  const degenerateThreshold = opts.degenerateRatio ?? 0.25
  if (degenerateRatio > degenerateThreshold) {
    const pct = (degenerateRatio * 100).toFixed(1)
    issues.push({
      kind: 'degenerate',
      detail: degenerate + ' 个退化面（面积≈0，占 ' + pct + '%）——超过 '
        + (degenerateThreshold * 100).toFixed(0) + '% 的阈值。'
        + '通常是缩放为 0、布尔运算残留或导入错误。会让法线计算异常、渲染出黑面。'
        + '（圆锥极点、针叶这类少量退化面是正常的，不必处理）',
    })
  }

  /* ② 内部块（islands）：按**空间位置**统计连通分量。
   *
   * 关键：不能按顶点索引判断连通。硬表面建模里每个面常有独立顶点，
   * 一个完好的立方体就会因此被算成 6~12 个"岛"——那是误判。
   *
   * 正确做法：先把**同位置的顶点**合并成同一个空间点，
   * 再看这些空间点通过三角面连成几个连通块。
   *
   * **多个块本身不是错误**。真实模型里大量 mesh 合法地由多块组成：
   *   - 街道、人行道：一段段铺装拼起来的
   *   - 建筑：楼体 + 阳台 + 窗框合并成一个对象
   *   - 栏杆、围栏：立柱 + 横杆
   *   - 植被：一簇叶子各自独立
   *
   * 所以这里**只在块数极多、且块都很小的时候**提示——
   * 那通常意味着「本该焊接的东西碎成了渣」（比如布尔运算失败、
   * 或者导入时按三角面拆开了）。判断标准用「平均块大小」，
   * 而不是块数本身。 */
  const spatialId = new Int32Array(vertices)
  const posToSpatial = new Map()
  const invW = 1 / Math.max(weldTol, 1e-9)
  let spatialCount = 0
  for (let i = 0; i < vertices; i++) {
    const x = Math.round(positions[i * 3] * invW)
    const y = Math.round(positions[i * 3 + 1] * invW)
    const z = Math.round(positions[i * 3 + 2] * invW)
    const key = x + ',' + y + ',' + z
    let sid = posToSpatial.get(key)
    if (sid === undefined) {
      sid = spatialCount++
      posToSpatial.set(key, sid)
    }
    spatialId[i] = sid
  }

  const parent = new Int32Array(Math.max(1, spatialCount))
  for (let i = 0; i < spatialCount; i++) parent[i] = i
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
  for (let t = 0; t < triangles; t++) {
    const a = spatialId[indices[t * 3]]
    const b = spatialId[indices[t * 3 + 1]]
    const c = spatialId[indices[t * 3 + 2]]
    union(a, b)
    union(b, c)
  }
  /* 统计每个块有多少三角面 */
  const facesPerIsland = new Map()
  for (let t = 0; t < triangles; t++) {
    const root = find(spatialId[indices[t * 3]])
    facesPerIsland.set(root, (facesPerIsland.get(root) || 0) + 1)
  }
  const islands = facesPerIsland.size
  const islandSizes = [...facesPerIsland.values()].sort((a, b) => b - a)
  const biggestIsland = islandSizes[0] || 0
  const avgIsland = triangles / Math.max(1, islands)
  /* 碎渣特征：块数很多，且平均每块的面数很少。
   * 阈值用「平均块 < 8 个三角面」——那基本就是碎成三角面了。 */
  const fragmented = islands > 20 && avgIsland < 8
  if (fragmented) {
    issues.push({
      kind: 'fragmented',
      detail: '碎成 ' + islands + ' 个块，平均每块只有 ' + avgIsland.toFixed(1) + ' 个三角面——'
        + '这通常是布尔运算失败、或导入时按三角面拆开导致的「碎渣」。'
        + '需要焊接/合并相邻顶点。'
        + '（注意：如果这是道路、栏杆这类本该由多段拼成的模型，可以忽略）',
    })
  }

  /* ③ 重复顶点：同一位置有多个顶点。
   *
   * 注意：**重复顶点本身不是错误**。硬表面建模里「每个面独立顶点」很常见
   * （为了做硬边着色），这种情况重复顶点是刻意的。
   *
   * 真正的问题分两种：
   *   a) 该焊接的地方没焊 → 细分曲面会开裂、平滑着色出现硬缝
   *   b) 单纯重复 → 无害，只是文件大一点
   *
   * 我们无法自动判断「该不该焊」，所以只在**重复比例极高且伴随多岛**时提示，
   * 并且措辞是「检查一下」而不是「这是错的」。 */
  const buckets = new Map()
  let duplicateVerts = 0
  const inv = 1 / Math.max(weldTol, 1e-9)
  for (let i = 0; i < vertices; i++) {
    const x = positions[i * 3]
    const y = positions[i * 3 + 1]
    const z = positions[i * 3 + 2]
    const key = Math.round(x * inv) + ',' + Math.round(y * inv) + ',' + Math.round(z * inv)
    const list = buckets.get(key)
    if (list === undefined) {
      buckets.set(key, i)
    } else {
      duplicateVerts++
    }
  }
  const dupRatio = vertices > 0 ? duplicateVerts / vertices : 0
  /* 只有在「重复比例高」**且**「碎成很多小块」时才提示——
   * 这组合才是「按面拆开了但没合并」的可靠特征。
   * 单纯的重复顶点（硬边着色）和多段拼接（道路、栏杆）都不该报。 */
  if (dupRatio > 0.3 && fragmented) {
    const pct = (dupRatio * 100).toFixed(1)
    issues.push({
      kind: 'duplicate-verts',
      detail: duplicateVerts + ' 个重复顶点（占 ' + pct + '%）且碎成 ' + islands + ' 块——'
        + '这组合通常意味着「按面拆开了但没合并起来」。'
        + '如果是有意做的硬边着色，忽略这条；如果本应是一个整体曲面，需要焊接顶点',
    })
  }

  /* ④ 尺寸极端：一个维度比其它小两个数量级，可能是薄片/压扁 */
  const dims = mesh.dims.map((d) => Math.abs(d)).sort((a, b) => a - b)
  const [d0, d1, d2] = dims
  if (d2 > 1e-6 && d0 / d2 < 0.001) {
    issues.push({
      kind: 'flat',
      detail: '最薄维度只有最长维度的 ' + ((d0 / d2) * 100).toFixed(2) + '%——'
        + '可能是被压扁的薄片。如果这是有意做的板件没问题，'
        + '如果是误操作（缩放为 0）需要修',
    })
  }

  return {
    part: mesh.part,
    id: mesh.id,
    ok: issues.filter((i) => i.kind !== 'flat').length === 0,
    degenerate,
    islands,
    biggestIsland,
    avgIsland: Number(avgIsland.toFixed(1)),
    fragmented,
    duplicateVerts,
    duplicateRatio: Number(dupRatio.toFixed(3)),
    issues,
  }
}

/**
 * 对一批 mesh 做完整的隔离 + 精度检查。
 *
 * @param {Array} meshes
 * @param {object} opts
 */
export function inspectEachMesh(meshes, opts = {}) {
  const perMesh = []
  const precisionItems = []

  for (const m of meshes) {
    if (!m || m.triangles === 0) continue
    const precision = precisionOf(m)
    const iso = isolatedMeshCheck(m, opts)
    perMesh.push({ mesh: m, precision, iso })
    precisionItems.push({ mesh: m, precision })
  }

  const outlierResult = precisionOutliers(precisionItems, opts)

  return {
    meshes: perMesh,
    count: perMesh.length,
    median: outlierResult.median,
    distribution: outlierResult.distribution,
    groups: outlierResult.groups || [],
    outliers: outlierResult.outliers,
    tooFewForConsistency: !!outlierResult.tooFew,
    problems: perMesh.filter((x) => !x.iso.ok),
  }
}