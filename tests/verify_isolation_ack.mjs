import assert from 'node:assert/strict'
import { normalizeIsolationAcknowledgements } from '../lib/core/iteration.mjs'

const acknowledgements = normalizeIsolationAcknowledgements([
  { part: '吊灯_灯泡', reason: '悬挂件' },
  { part: '远景飞机', reason: '  飞行物  ' },
  { part: '空理由', reason: '   ' },
  { part: '泛泛确认', reason: '合理' },
  { reason: '部件名缺失' },
  null,
])

assert.deepEqual([...acknowledgements], [
  ['吊灯_灯泡', '悬挂件'],
  ['远景飞机', '飞行物'],
])

console.log('ISOLATION_ACK_OK')
