/** 共享真实表面证据，分别构建组间图和每组内部图；不把组包围盒当实体。 */
function components(ids, edges) {
  const links = new Map(ids.map(id => [id, []]))
  for (const [a, b] of edges) {
    if (!links.has(a) || !links.has(b)) continue
    links.get(a).push(b); links.get(b).push(a)
  }
  const seen = new Set(), result = []
  for (const id of ids) {
    if (seen.has(id)) continue
    const queue = [id], chunk = []
    seen.add(id)
    while (queue.length) {
      const current = queue.pop()
      chunk.push(current)
      for (const next of links.get(current)) if (!seen.has(next)) { seen.add(next); queue.push(next) }
    }
    result.push(chunk)
  }
  return result
}

export function inspectHierarchy(meshes, groups, interference, isolation, opts = {}) {
  const groupOf = new Map(groups.flatMap(g => g.ids.map(id => [id, g.name])))
  const meshOf = new Map(meshes.map(m => [m.id, m]))
  const contacts = isolation.contacts || [], unknown = isolation.unknownPairs || []
  const missingRelations = opts.extractionSkipped || isolation.unknownOmitted > 0
  const pairKey = (a, b) => JSON.stringify([a, b].sort())
  const between = new Map()
  const bucket = (a, b) => {
    const key = pairKey(a, b)
    if (!between.has(key)) between.set(key, { groups: [a, b], contacts: [], collisions: [], groundContacts: [], unknown: [] })
    return between.get(key)
  }
  for (const [source, field] of [[contacts, 'contacts'], [interference.hits, 'collisions'],
    [interference.groundContacts || [], 'groundContacts'], [unknown, 'unknown']]) {
    for (const row of source) {
      const a = groupOf.get(row.aId), b = groupOf.get(row.bId)
      if (a && b && a !== b) bucket(a, b)[field].push(row)
    }
  }
  const brief = rows => ({ count: rows.length, items: rows.slice(0, 12), omitted: Math.max(0, rows.length-12) })
  const graphEdges = [...between.values()].filter(r => r.contacts.length).map(r => r.groups)
  const groupComponents = components(groups.map(g => g.name), graphEdges)
  const globalComponents = groupComponents.map(names => ({
    groups: names,
    status: groups.length <= 1 ? 'not-applicable'
      : missingRelations || unknown.some(p => names.includes(groupOf.get(p.aId)) !== names.includes(groupOf.get(p.bId))) ? 'unknown'
        : groupComponents.length > 1 ? 'disconnected' : 'connected',
  }))
  const internal = groups.map(g => {
    const own = new Set(g.ids)
    const edges = contacts.filter(p => own.has(p.aId) && own.has(p.bId))
    const uncertain = unknown.filter(p => own.has(p.aId) && own.has(p.bId))
    const comps = components(g.ids, edges.map(p => [p.aId, p.bId]))
    return {
      name: g.name, parts: g.ids.length,
      complete: interference.complete !== false && uncertain.length === 0 && !missingRelations,
      collisions: brief(interference.hits.filter(p => own.has(p.aId) && own.has(p.bId))),
      contactPairs: edges.length, contacts: brief(edges), unknownPairs: brief(uncertain),
      isolation: {
        applicable: g.ids.length > 1, componentCount: comps.length,
        components: comps.map(ids => ({
          ids, parts: ids.map(id => meshOf.get(id)?.part || id),
          status: g.ids.length <= 1 ? 'not-applicable'
            : missingRelations || uncertain.some(p => ids.includes(p.aId) !== ids.includes(p.bId)) ? 'unknown'
              : comps.length > 1 ? 'disconnected' : 'connected',
          externalContacts: [...new Set(contacts.filter(p =>
            (ids.includes(p.aId) && !own.has(p.bId)) || (ids.includes(p.bId) && !own.has(p.aId)))
            .map(p => groupOf.get(own.has(p.aId) ? p.bId : p.aId)))],
        })),
      },
    }
  })
  return {
    complete: interference.complete !== false && isolation.complete !== false && !opts.extractionSkipped,
    method: 'shared-triangle-evidence',
    unknownPairCount: isolation.unknownPairCount || unknown.length,
    unknownPairsOmitted: isolation.unknownOmitted || 0,
    global: {
      complete: interference.complete !== false && isolation.complete !== false && !opts.extractionSkipped,
      groupCount: groups.length,
      pairs: [...between.values()].map(r => ({ groups: r.groups, contacts: brief(r.contacts),
        collisions: brief(r.collisions), groundContacts: brief(r.groundContacts), unknown: brief(r.unknown) })),
      isolation: { applicable: groups.length > 1, componentCount: groupComponents.length, components: globalComponents },
    },
    internal,
    limits: '只检查不同对象之间的三角面；组为实际零件的集合。连通不证明支撑正确，未接触不证明摆放错误；单对象内部的自相交另需专项检查。',
  }
}

export function hierarchyLines(report) {
  const global = report.global, lines = ['两层检测：' + (report.complete ? '当前抽取范围已检查' : '覆盖不完整，未知项不能算通过')]
  const collisions = global.pairs.reduce((n, p) => n+p.collisions.count, 0)
  lines.push('① 全局按物品组：' + global.groupCount + ' 组，组间相交候选 ' + collisions + ' 对零件；连接簇 ' + global.isolation.componentCount + ' 个。')
  for (const p of global.pairs.filter(p => p.collisions.count || p.unknown.count).slice(0, 12)) {
    lines.push('  ' + p.groups.join(' ↔ ') + '：相交 ' + p.collisions.count + ' 对，接触 ' + p.contacts.count + ' 对，未知 ' + p.unknown.count + ' 对。')
  }
  for (const c of global.isolation.components.filter(c => c.status !== 'connected' && c.status !== 'not-applicable').slice(0, 12)) {
    lines.push('  ' + (c.status === 'unknown' ? '连接待确认' : '与其余组未检出接触') + '：' + c.groups.join('、'))
  }
  lines.push('② 逐组内部：外部接触不能替代本组连接。多个零件互相连接的悬空小团也按连接簇列出。')
  for (const g of report.internal.slice(0, 20)) {
    lines.push('  「' + g.name + '」：' + g.parts + ' 件，相交 ' + g.collisions.count + ' 对，'
      + (g.isolation.applicable ? '内部连接簇 ' + g.isolation.componentCount + ' 个' : '单件组，无组内对象对')
      + (g.unknownPairs.count ? '，未知 ' + g.unknownPairs.count + ' 对' : ''))
    if (g.isolation.componentCount > 1) for (const c of g.isolation.components.slice(0, 6)) {
      lines.push('    ' + (c.status === 'unknown' ? '连接待确认' : '组内独立簇') + '：' + c.parts.slice(0, 6).join('、')
        + (c.parts.length > 6 ? ' 等 ' + c.parts.length + ' 件' : '')
        + (c.externalContacts.length ? '；接触组外：' + c.externalContacts.join('、') : ''))
    }
  }
  if (report.internal.length > 20) lines.push('  另有 ' + (report.internal.length-20) + ' 组，详见结构化报告。')
  lines.push('按接合处视图逐项区分预期装配与错位；不能因某个连接合理就把全部命中统称合理。' + report.limits)
  return lines
}
