/** 宿主 value schema DSL 的关键字兼容约束，防止离线 fixture 接受宿主必定拒绝的定义。 */
import assert from 'node:assert/strict'

const annotation = ['type', 'description', 'title', 'default', 'examples']
function checkValue(node, where, property = false) {
  assert.ok(node && typeof node === 'object' && !Array.isArray(node), where + ' must be a schema object')
  const kindKeys = Object.hasOwn(node, 'oneOf') ? ['oneOf']
    : node.type === 'object' ? ['properties', 'additionalProperties']
      : node.type === 'array' ? ['items'] : ['enum', 'const']
  const allowed = new Set([...annotation, ...kindKeys, ...(property ? ['required'] : [])])
  for (const key of Object.keys(node)) {
    assert.ok(allowed.has(key), where + '.' + key + ' is not supported by the value schema DSL')
  }
  if (Object.hasOwn(node, 'required')) assert.equal(node.required, true, where + '.required must be true')
  if (node.type === 'object') {
    assert.equal(typeof node.additionalProperties, 'boolean', where + '.additionalProperties must be explicit')
    for (const [key, child] of Object.entries(node.properties || {})) checkValue(child, where + '.' + key, true)
  }
  if (node.items) checkValue(node.items, where + '.items')
  if (node.oneOf) node.oneOf.forEach((child, i) => checkValue(child, where + '.oneOf[' + i + ']'))
}

export function assertNativeToolSchema(spec) {
  for (const [name, parameter] of Object.entries(spec.parameters || {})) {
    checkValue(parameter, 'parameters.' + name, true)
  }
  checkValue(spec.output.schema, 'output.schema')
  return spec
}
