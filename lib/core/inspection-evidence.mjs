import { createHash } from 'node:crypto'

/** Evaluated world-space geometry, identity and grouping, independent of material nodes. */
export function geometryRevision(meshes) {
  const hash = createHash('sha256')
  for (const m of [...meshes].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    hash.update(JSON.stringify([m.id, m.part, m.meta?.collections || [], m.meta?.hidden || false]))
    for (const values of [m.positions, m.indices]) {
      const buffer = new Float64Array(values)
      hash.update(Buffer.from(buffer.buffer))
    }
  }
  return hash.digest('hex').slice(0, 24)
}
const idFor = (type, parts) => type + '-' + createHash('sha256').update(JSON.stringify([...parts].sort())).digest('hex').slice(0, 12)

export function inspectionIssues(inter, iso, problems, groups) {
  const group = new Map(groups.flatMap(g => g.ids.map(id => [id, g.name])))
  const severe = new Set(['poke-through', 'mutual', 'coincident'])
  return [
    ...inter.filter(h => severe.has(h.state) || group.get(h.aId) !== group.get(h.bId)).map(h => ({
      id: idFor('intersection', [h.aId, h.bId]), type: 'intersection', parts: [h.a, h.b],
      priority: severe.has(h.state) ? 'high' : 'normal',
      observation: (h.stateLabel || h.state) + '，估计深度 ' + h.depth,
      next: '观察两件的接合处和场景中的相对位置，判断是否符合预期连接；命中不自动等于缺陷',
    })),
    ...iso.map(h => ({ id: idFor('isolation', [h.id]), type: 'isolation', parts: [h.part], priority: 'high',
      observation: '未检测到表面接触，' + (h.gapKind === 'bbox-lower-bound' ? '包围盒距离下界 ' : '最近间距 ') + h.gap,
      next: '核对预期支撑对象、悬挂连接与局部侧视；与任意物体接触不证明放对位置',
    })),
    ...problems.map(p => ({ id: idFor('mesh', [p.mesh.id]), type: 'mesh', parts: [p.mesh.part], priority: 'normal',
      observation: p.iso.issues.map(x => x.detail).join('；'), next: '结合用途和局部图确认网格诊断，保留有意分离的组件',
    })),
  ]
}

/** Revision-bound dispositions; a model declaration is never labelled measured truth. */
export class InspectionEvidence {
  revision = null
  decisions = new Map()
  lastSignature = ''
  repeats = 0
  assess(revision, issues, submissions = []) {
    if (this.revision !== revision) { this.revision = revision; this.decisions.clear() }
    const known = new Map(issues.map(x => [x.id, x]))
    const rejected = []
    for (const d of submissions) {
      const reason = String(d.reason || '').trim()
      const evidence = String(d.evidence || '').trim()
      if (d.revision !== revision || !known.has(d.id) || !reason || !evidence
        || /^(合理|正常|没问题|已检查|通过|ok|pass)$/i.test(reason)) {
        rejected.push(String(d.id || '?') + '：需要当前 revision、准确问题 id、具体用途理由和观察依据')
        continue
      }
      this.decisions.set(d.id, { id: d.id, revision, reason, evidence, source: 'model-declaration' })
    }
    const remaining = issues.filter(x => !this.decisions.has(x.id))
    const signature = revision + ':' + remaining.map(x => x.id).sort().join(',')
    this.repeats = signature === this.lastSignature ? this.repeats + 1 : 0
    this.lastSignature = signature
    return { revision, total: issues.length, unresolved: remaining.length,
      items: remaining.slice(0, 40), omitted: Math.max(0, remaining.length - 40),
      accepted: [...this.decisions.values()].filter(x => known.has(x.id)), rejected, repeatedUnchanged: this.repeats,
      next: this.repeats > 0 && remaining.length ? '相同几何与疑点重复出现；先补局部证据或改做法，再重查，勿用调阈值或删细节换通过'
        : remaining.length ? remaining[0].next : '当前检测候选已处理；仍需核对任务细节、材质与实际导出文件',
    }
  }
}
