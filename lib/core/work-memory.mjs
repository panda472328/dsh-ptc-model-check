import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import path from 'node:path'

const states = new Set(['planned', 'active', 'implemented', 'verified', 'deferred'])
const open = (x) => !['verified', 'deferred'].includes(x.status)
const clean = (x, max = 1600) => String(x || '').trim().slice(0, max)

/** A bounded working set backed by an explicit task-local notebook; never infer a shared cwd. */
export class WorkMemory {
  constructor() { this.reset() }
  reset() {
    this.file = null; this.brief = ''; this.items = new Map(); this.sequence = 0
    this.scope = ''; this.layout = ''; this.materialIntent = ''
  }
  update(args = {}) {
    if (args.memory_file) {
      const file = path.resolve(String(args.memory_file))
      if (!path.isAbsolute(String(args.memory_file))) throw new Error('memory_file 必须是当前任务目录中的绝对路径')
      if (this.file && this.file !== file) throw new Error('已有任务账本；新任务先 reset_memory，再选择另一文件')
      if (!this.file) {
        try {
          const data = JSON.parse(readFileSync(file, 'utf8'))
          if (data.schema !== 'ptc-work-memory-v1' || !Array.isArray(data.items)) throw new Error('不兼容的任务账本')
          this.brief = clean(data.brief)
          this.scope = ['scene', 'single', 'local'].includes(data.scope) ? data.scope : ''
          this.layout = clean(data.layout)
          this.materialIntent = clean(data.materialIntent, 1000)
          for (const item of data.items) this.put(item)
        } catch (e) { if (e.code !== 'ENOENT') throw e }
        this.file = file
      }
    }
    if (args.brief !== undefined) this.brief = clean(args.brief)
    if (args.scope !== undefined) {
      if (!['scene', 'single', 'local'].includes(args.scope)) throw new Error('scope 需要是 scene、single 或 local')
      this.scope = args.scope
    }
    if (args.layout !== undefined) this.layout = clean(args.layout)
    if (args.material_intent !== undefined) this.materialIntent = clean(args.material_intent, 1000)
    for (const item of args.tasks || []) this.put(item)
    this.save()
    return this.snapshot(args.offset)
  }
  put(item) {
    const id = clean(item.id, 180)
    if (!id) throw new Error('每项任务需要稳定 id；更新时使用原 id')
    const prev = this.items.get(id) || {}
    const title = clean(item.title ?? prev.title)
    const status = item.status || prev.status || 'planned'
    const evidence = clean(item.evidence ?? prev.evidence)
    if (!title || !states.has(status)) throw new Error('任务需要具体 title 和有效 status')
    if (['verified', 'deferred'].includes(status) && !evidence) throw new Error('已核对或暂缓的任务需要写明观察依据或取舍理由')
    if (!prev.id && this.items.size >= 1000) throw new Error('账本达到 1000 项上限，请按物品和批次归并任务；原有条目保留')
    this.items.set(id, { ...prev, id, title, status, evidence, order: prev.order ?? this.sequence++ })
  }
  captureTodo(todos) {
    if (!Array.isArray(todos)) return
    // A shorter replacement list must not silently erase unfinished commitments.
    for (const item of todos) {
      const title = clean(item?.content)
      if (!title) continue
      const id = 'todo:' + title.slice(0, 175)
      const previous = this.items.get(id)
      if (previous?.status === 'verified' && item.status === 'completed') continue
      this.put({ id, title, status: item.status === 'completed' ? 'implemented'
        : item.status === 'in_progress' ? 'active' : 'planned' })
    }
    this.save()
  }
  save() {
    if (!this.file) return
    const tmp = this.file + '.' + process.pid + '.tmp'
    writeFileSync(tmp, JSON.stringify({ schema: 'ptc-work-memory-v1', brief: this.brief,
      ...this.design(), items: [...this.items.values()] }, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }
  snapshot(offset = 0) {
    const all = [...this.items.values()]
    const start = Math.max(0, Math.floor(Number(offset) || 0))
    return { file: this.file, brief: this.brief, ...this.design(), total: all.length, open: all.filter(open).length,
      items: all.slice(start, start + 40), nextOffset: start + 40 < all.length ? start + 40 : null }
  }
  design() { return { scope: this.scope, layout: this.layout, materialIntent: this.materialIntent } }
  context() {
    if (!this.brief && !this.items.size && !this.scope && !this.layout && !this.materialIntent) return ''
    const pending = [...this.items.values()].filter(open)
    const priority = { active: 0, implemented: 1, planned: 2 }
    pending.sort((a, b) => priority[a.status] - priority[b.status] || a.order - b.order)
    const labels = { active: '当前', implemented: '已做待核对', planned: '待做' }
    return ['任务记忆（计划与自述，不自动证明完成）：' + this.brief.slice(0, 300),
      this.scope ? '交付范围：' + ({ scene: '整体场景；当前细化某个主体不代表场景完成', single: '单件资产', local: '局部修改；保留范围外设计' })[this.scope] : '',
      this.layout ? '整体布局意图：' + this.layout.slice(0, 450) : '',
      this.materialIntent ? '材质意图：' + this.materialIntent.slice(0, 250) : '',
      ...pending.slice(0, 4).map(x => labels[x.status] + '：' + x.title.slice(0, 180)),
      '账本共 ' + this.items.size + ' 项，未闭环 ' + pending.length + ' 项；完成当前批次后更新原条目。',
      this.file ? '恢复账本：' + this.file : '当前仅会话内保存；用 model_source(action=memory, memory_file=任务目录绝对路径) 持久保存。',
      '完整条目用 model_source(action=memory, offset=0) 分页读取；不必每轮重读全部。'].filter(Boolean).join('\n')
  }
}
