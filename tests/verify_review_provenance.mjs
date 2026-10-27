import assert from 'node:assert/strict'
import { ReviewProvenance } from '../lib/core/review-provenance.mjs'

const provenance = new ReviewProvenance()
provenance.begin({
  taskId: 'review-1',
  mode: 'structure',
  scope: 'scene',
  coverageComplete: true,
  groups: ['桌', '椅'],
  tasks: [
    { token: 'review-1-1', groups: ['桌'] },
    { token: 'review-1-2', groups: ['椅'] },
  ],
})

assert.equal(provenance.register('task review-1-1', 'subagent-a'), 'review-1-1')
assert.equal(provenance.register('task review-1-2', 'subagent-b'), 'review-1-2')
assert.equal(provenance.register('unrelated prompt', 'subagent-c'), null)
assert.equal(provenance.complete('subagent-a', 'failed', 'failed response'), false)
assert.equal(provenance.complete('subagent-b', 'completed', '  full reviewer output  '), true)
assert.equal(provenance.complete('subagent-a', 'completed', 'late output'), false)

let snapshot = provenance.snapshot()
assert.deepEqual(snapshot.outputs, { 'review-1-2': ['full reviewer output'] })
assert.deepEqual(snapshot.dispatches, {
  'review-1-1': ['subagent-a'],
  'review-1-2': ['subagent-b'],
})
snapshot.outputs['review-1-2'].push('mutated copy')
assert.deepEqual(provenance.snapshot().outputs, { 'review-1-2': ['full reviewer output'] })

provenance.begin({
  taskId: 'review-2',
  tasks: [{ token: 'review-2-1', groups: ['lamp'] }],
})
assert.equal(provenance.complete('subagent-a', 'completed', 'stale output'), false)
assert.deepEqual(provenance.snapshot().outputs, {})
provenance.reset()
assert.equal(provenance.snapshot(), null)
assert.equal(provenance.complete('subagent-b', 'completed', 'after reset'), false)

console.log('REVIEW_PROVENANCE_OK')
