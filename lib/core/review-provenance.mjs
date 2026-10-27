function cloneTask(task) {
  if (!task) return null
  return {
    ...task,
    groups: [...task.groups],
    tasks: task.tasks.map((item) => ({ ...item, groups: [...item.groups] })),
    outputs: Object.fromEntries(Object.entries(task.outputs)
      .map(([token, outputs]) => [token, [...outputs]])),
    dispatches: Object.fromEntries(Object.entries(task.dispatches)
      .map(([token, ids]) => [token, [...ids]])),
  }
}

/** Tracks which completed subagent outputs belong to the current review request. */
export class ReviewProvenance {
  current = null
  activeById = new Map()

  begin(info = {}) {
    this.activeById.clear()
    this.current = {
      taskId: String(info.taskId || ''),
      reviewer: info.reviewer === 'self' ? 'self' : 'independent',
      mode: info.mode === 'material' ? 'material' : 'structure',
      target: info.target || 'scene',
      scope: info.scope === 'group' ? 'group' : 'scene',
      coverageComplete: info.coverageComplete === true,
      groups: Array.isArray(info.groups) ? info.groups.map(String) : [],
      tasks: Array.isArray(info.tasks)
        ? info.tasks.map((task) => ({ token: String(task.token), groups: (task.groups || []).map(String) }))
        : [],
      outputs: {},
      dispatches: {},
    }
    return this.snapshot()
  }

  register(prompt, subagentId) {
    if (!this.current || !subagentId) return null
    const text = typeof prompt === 'string' ? prompt : JSON.stringify(prompt || '')
    const task = this.current.tasks.find((item) => text.includes(item.token))
    if (!task) return null
    const id = String(subagentId)
    this.activeById.set(id, { taskId: this.current.taskId, token: task.token })
    if (!this.current.dispatches[task.token]) this.current.dispatches[task.token] = []
    this.current.dispatches[task.token].push(id)
    return task.token
  }

  complete(subagentId, stopReason, text) {
    const id = String(subagentId || '')
    const dispatch = this.activeById.get(id)
    if (!dispatch) return false
    this.activeById.delete(id)
    const output = String(text || '').trim()
    if (!this.current || this.current.taskId !== dispatch.taskId
      || stopReason !== 'completed' || !output) return false
    if (!this.current.outputs[dispatch.token]) this.current.outputs[dispatch.token] = []
    this.current.outputs[dispatch.token].push(output)
    return true
  }

  snapshot() {
    return cloneTask(this.current)
  }

  reset() {
    this.current = null
    this.activeById.clear()
  }
}
