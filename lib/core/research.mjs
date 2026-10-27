/** Task classification for high-fidelity structural research requirements. */
const REAL_SUBJECTS = [
  '巴黎圣母院', '圣母院', '科隆大教堂', '米兰大教堂', '圣家堂', '沙特尔',
  '埃菲尔铁塔', '比萨斜塔', '金字塔', '斗兽场', '帕特农', '泰姬陵',
  '故宫', '天坛', '布达拉宫', '应县木塔', '佛光寺', '祈年殿',
  'AK-47', 'AK47', 'M16', 'M4A1', '格洛克', '沙漠之鹰', '98K', '巴雷特',
  'T-34', '虎式坦克', '谢尔曼', 'F-22', 'B-2', '米格',
  'iPhone', '保时捷', '法拉利', '哈雷',
]

const ARCHITECTURAL_SUBJECTS = new Set([
  '巴黎圣母院', '圣母院', '科隆大教堂', '米兰大教堂', '圣家堂', '沙特尔',
  '埃菲尔铁塔', '比萨斜塔', '金字塔', '斗兽场', '帕特农', '泰姬陵',
  '故宫', '天坛', '布达拉宫', '应县木塔', '佛光寺', '祈年殿',
])

const SCENE_WORDS = /场景|街区|城市|村落|城堡|教堂|大殿|宫殿|要塞|园林|室内|房间|酒馆|书房|工地|营地|建筑|景观|寺庙|神庙|庄园|园区/
const HIGH_FIDELITY_WORDS = /高保真|忠实(?:地)?复刻|精确(?:地)?还原|精准(?:地)?还原|严格还原|1\s*[:：]\s*1|一模一样|按原样(?:复刻|还原)|完全复刻|复刻|重建/
const REPLICATION_NEGATED = /(?:不要求|不需要|不必|无需|不用|不要|别|不能|并非|不是)\s*(?:(?:高保真|严格|精确|精准|忠实|完全)(?:地)?\s*)?(?:复刻|还原|重建|复制)/
const EXPLICIT_STRICT_REPLICATION = /(?:高保真|严格|精确|精准|忠实|完全)(?:地)?\s*(?:复刻|还原|重建)|1\s*[:：]\s*1\s*(?:复刻|还原|重建)|一模一样(?:地)?\s*(?:复刻|还原|重建)/

/** Return the minimum number of effective structural queries for this task. */
export function researchRequired(text) {
  const source = String(text || '')
  const hitSubject = REAL_SUBJECTS
    .slice()
    .sort((a, b) => b.length - a.length)
    .find((subject) => source.includes(subject)) || null
  const isReplicate = HIGH_FIDELITY_WORDS.test(source)
    && !REPLICATION_NEGATED.test(source)

  if (isReplicate && (SCENE_WORDS.test(source)
    || (hitSubject && ARCHITECTURAL_SUBJECTS.has(hitSubject)))) {
    return { required: 1, subject: hitSubject, why: '明确要求高保真复刻场景或建筑，需核实主要构件和连接关系' }
  }
  if (isReplicate && hitSubject) {
    return { required: 1, subject: hitSubject, why: '明确要求高保真复刻真实对象，先核实其关键结构' }
  }
  if (isReplicate && EXPLICIT_STRICT_REPLICATION.test(source)) {
    return { required: 1, subject: null, why: '明确要求严格复刻，需核实目标的关键结构；对象不受预设名称列表限制' }
  }
  return {
    required: 0,
    subject: null,
    why: '未明确要求高保真复刻；结构调研按实际不确定性选择，不作签收门槛',
  }
}

/** Clear research progress while applying the latest user's task classification. */
export function resetResearchProgress(state) {
  const requirement = state.resetRequirement || state
  state.calls = 0
  state.effectiveCount = 0
  state.emptyCount = 0
  state.offTopicCount = 0
  state.queries = []
  state.required = Number(requirement.required) || 0
  state.subject = requirement.subject || null
  state.why = requirement.why || ''
  state.lastAt = 0
  state.lastGoodAt = 0
  state.lastRelevance = 0
  state.log = []
  state.resetRequirement = null
  return state
}
