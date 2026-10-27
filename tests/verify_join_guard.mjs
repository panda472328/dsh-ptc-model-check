/** 合理合并可用；报告编辑结构风险，不误报 Python 字符串或注释。 */
import assert from 'node:assert/strict'
import { makeMesh } from '../lib/core/geometry.mjs'
import { createHostFixture } from './host_fixture.mjs'

const mesh = makeMesh('A', 'A', new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), new Uint32Array([0, 1, 2]))
for (const code of [
  "print(','.join(['a', 'b']))",
  "# bpy.ops.object.join()\nprint('no edit')",
  "print('bpy.ops.object.join()')",
]) {
  const host = await createHostFixture([mesh])
  try {
    assert.equal(host.native('execute_python', { code }).kind, 'next')
    assert.doesNotMatch(host.runtime(), /合并提醒/)
  } finally { host.dispose() }
}
for (const [name, args] of [
  ['join_objects', { names: ['a', 'b'] }],
  ['execute_python', { code: 'import bpy\nbpy.ops.object.join()' }],
]) {
  const host = await createHostFixture([mesh])
  try {
    assert.equal(host.native(name, args).kind, 'next')
    assert.match(host.runtime(), /合并提醒/)
    assert.match(host.runtime(), /不在对象间检测覆盖范围/)
  } finally { host.dispose() }
}
console.log('JOIN_GUARD_OK')
