/** 调研默认拓展设计空间；精确核实只用于任务确实需要的数据。 */
export const researchMode = (mode) => mode === 'verify' ? 'verify' : 'explore'

export function researchGuidance(mode) {
  if (researchMode(mode) === 'verify') return [
    '精确核实：只为用户指定尺寸、严格复刻、制造或接口配合保留必要数据；没有可靠来源就说明未知，不能编造精度。',
    '分清用户硬要求、来源中的特定实例和原创设计建议；实例数据不自动成为整件模型的约束。',
  ]
  return [
    '探索调研：优先理解组成、连接、功能、形态层次和可选做法，为原创设计提供线索。',
    '下列文字为定性节选，常见的明确尺寸、数量和比例以省略标记呈现；不是逐字引文，原始数据可查来源链接。型号、年代和来源地址保留。',
    '不要在调研阶段预先锁死尺寸、坐标、零件数量或唯一方案；也不要把省略的数据补猜成事实。',
    '先考虑不同的结构与细节方向，再按用途和风格选取协调方案。来源事实与原创设想分开说明，用户明确要求优先。',
  ]
}

// 仅处理明确带单位/量词的数据，不把型号、年代或所有数字一概删掉。
const N = '(?:\\d+(?:[.,]\\d+)*|[零〇一二两三四五六七八九十百千万]+)'
const AMOUNT = N + '(?:\\s*(?:[×xX*~～—–-]|至|到)\\s*' + N + ')*'
const UNIT = '(?:毫米|厘米|分米|千米|微米|米|英寸|英尺|mm|cm|dm|km|μm|µm|m|inches|inch|feet|ft|度|degrees?|deg|°)(?:[²³]|\\^?[23])?'
const MEASUREMENT = new RegExp('(?<![A-Za-z0-9_.-])' + AMOUNT + '\\s*' + UNIT + '(?![A-Za-z])', 'gi')
const RATIO = new RegExp('(?<![A-Za-z0-9_.-])' + N + '\\s*[:：]\\s*' + N + '(?![A-Za-z0-9.])|(?<![A-Za-z0-9_.-])' + N + '\\s*(?:[%％]|倍)', 'g')
const COUNT = new RegExp('(?<![A-Za-z0-9_.-])' + AMOUNT + '\\s*(?:个|枚|颗|块|根|片|条|件|组|层|排|列|段|处|圈|道|扇|座|对|套|只|张|支|台|孔|\\b(?:panels?|screws?|bolts?|layers?|rows?|segments?|holes?|pieces?)\\b)', 'gi')

export function researchText(value, mode) {
  const text = String(value || '')
  if (researchMode(mode) === 'verify') return text
  return text.replace(MEASUREMENT, '〔尺寸略〕')
    .replace(RATIO, '〔比例略〕').replace(COUNT, '〔数量略〕')
}

export function researchQuery(query, aspect = 'structure', mode) {
  const hint = {
    structure: '构件组成、连接与支撑关系、可选结构做法',
    proportion: '体块主次、相对比例与形态变化',
    motion: '活动原理、运动方向、避让与连接方式',
    material: '材料搭配、加工装配方式与表面层次',
  }[aspect] || '构件组成与连接关系'
  return query + ' ' + hint + ' 原理 说明'
    + (researchMode(mode) === 'verify' ? ' 尺寸与规格依据' : '')
}
