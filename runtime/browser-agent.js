/*
 * 页面侧的最小建模桥。它故意不依赖 Three.js / Babylon 的模块导入，
 * 这样可以直接由 CDP 注入已经打开的页面。页面若有自己的桥，适配器会保留它。
 */
(function installPTCBridge(root) {
  if (!root) return

  function listObjects() {
    var out = []
    var scene = root.__PTC_SCENE__
    if (scene && typeof scene.traverse === 'function') {
      scene.traverse(function (object) { if (object) out.push(object) })
      return out
    }
    var meshes = root.__PTC_MESHES__
    if (Array.isArray(meshes)) return meshes.slice()
    var babylon = root.__PTC_BABYLON_SCENE__ || root.scene
    if (babylon && typeof babylon.getMeshes === 'function') {
      try { return babylon.getMeshes() || [] } catch (_) { return [] }
    }
    return out
  }

  function nameOf(object) {
    return String(object && (object.name || object.id || object.uuid) || '')
  }

  function idOf(object) {
    return String(object && (object.uuid || object.id || object.name) || '')
  }

  function partOf(object) {
    var data = object && object.userData
    return String((data && (data.ptcPart || data.part)) || nameOf(object) || idOf(object))
  }

  function findObject(key) {
    var wanted = String(key || '')
    var objects = listObjects()
    for (var i = 0; i < objects.length; i++) {
      var object = objects[i]
      var data = object && object.userData
      if (String(object && object.uuid || '') === wanted
        || String(object && object.id || '') === wanted
        || String(object && object.name || '') === wanted
        || String(data && data.ptcPart || '') === wanted) return object
    }
    return null
  }

  function bytesOf(value, Type) {
    if (value == null) return new Uint8Array(0)
    if (typeof value === 'string') {
      try {
        var binary = atob(value)
        var decoded = new Uint8Array(binary.length)
        for (var i = 0; i < binary.length; i++) decoded[i] = binary.charCodeAt(i)
        return decoded
      } catch (_) { return new Uint8Array(0) }
    }
    if (value instanceof Uint8Array) return value
    var typed = value && value.array ? value.array : value
    if (ArrayBuffer.isView(typed)) {
      return new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength)
    }
    if (Array.isArray(typed)) return new Type(typed).buffer instanceof ArrayBuffer
      ? new Uint8Array(new Type(typed).buffer) : new Uint8Array(0)
    return new Uint8Array(0)
  }

  function base64(bytes) {
    var binary = ''
    for (var i = 0; i < bytes.length; i += 0x8000) {
      var end = Math.min(bytes.length, i + 0x8000)
      for (var j = i; j < end; j++) binary += String.fromCharCode(bytes[j])
    }
    return typeof btoa === 'function' ? btoa(binary) : ''
  }

  function transformPositions(values, object) {
    var source = values && values.array ? values.array : values
    if (!source) return []
    var out = Array.prototype.slice.call(source)
    var matrix = object && object.matrixWorld && object.matrixWorld.elements
    if (!matrix || matrix.length < 16) return out
    for (var i = 0; i + 2 < out.length; i += 3) {
      var x = Number(out[i]) || 0
      var y = Number(out[i + 1]) || 0
      var z = Number(out[i + 2]) || 0
      var w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15]
      if (!w) w = 1
      out[i] = (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / w
      out[i + 1] = (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / w
      out[i + 2] = (matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]) / w
    }
    return out
  }

  function meshRecord(object) {
    var geometry = object && object.geometry
    var positions
    var indices
    if (geometry && geometry.attributes && geometry.attributes.position) {
      positions = transformPositions(geometry.attributes.position, object)
      var index = geometry.index && (geometry.index.array || geometry.index)
      indices = index ? Array.prototype.slice.call(index) : []
      if (!indices.length) for (var i = 0; i + 2 < positions.length / 3; i++) indices.push(i * 3, i * 3 + 1, i * 3 + 2)
    } else if (object && object.positions) {
      positions = transformPositions(object.positions, object)
      indices = object.indices ? Array.prototype.slice.call(object.indices) : []
    } else if (object && typeof object.getVerticesData === 'function') {
      try {
        positions = object.getVerticesData('position') || []
        indices = typeof object.getIndices === 'function' ? (object.getIndices() || []) : []
      } catch (_) { return null }
    } else return null

    var p = new Float32Array(positions)
    var ix = new Uint32Array(indices)
    var materials = []
    var mats = object && (object.material ? (Array.isArray(object.material) ? object.material : [object.material]) : [])
    for (var m = 0; m < mats.length; m++) if (mats[m] && mats[m].name) materials.push(String(mats[m].name))
    return {
      id: idOf(object), part: partOf(object),
      positions: base64(new Uint8Array(p.buffer)),
      indices: base64(new Uint8Array(ix.buffer)),
      materials: materials,
      hidden: !!(object && (object.visible === false || object.isVisible === false)),
    }
  }

  function extract() {
    var objects = listObjects()
    var result = { meshes: [], skipped: [], ms: 0 }
    var started = Date.now()
    for (var i = 0; i < objects.length; i++) {
      var record = meshRecord(objects[i])
      if (record && record.positions && record.indices) result.meshes.push(record)
      else if (objects[i] && (objects[i].isMesh || objects[i].geometry)) result.skipped.push(idOf(objects[i]))
    }
    result.ms = Date.now() - started
    return result
  }

  root.__PTC_BRIDGE__ = {
    info: function () {
      var objects = listObjects()
      return { engine: root.THREE ? 'three' : (root.BABYLON ? 'babylon' : 'custom'), objects: objects.length, meshes: extract().meshes.length }
    },
    extract: extract,
    rename: function (assignments) {
      var applied = [], missing = []
      for (var i = 0; i < (Array.isArray(assignments) ? assignments.length : 0); i++) {
        var item = assignments[i] || {}
        var object = findObject(item.id || item.uuid || item.name || item.from)
        var part = String(item.part || item.name || '')
        if (!object || !part) { missing.push(item.id || item.uuid || item.name || '?'); continue }
        var from = nameOf(object)
        object.name = part
        object.userData = object.userData || {}
        object.userData.ptcPart = part
        applied.push({ id: idOf(object), from: from, part: part })
      }
      return { applied: applied, missing: missing }
    },
  }
})(typeof window !== 'undefined' ? window : null)
