/**
 * 文件适配器：直接读 .obj（引擎无关，不需要 Blender 或浏览器）。
 * 每个 `o`/`g` 段当成一个 mesh；多边形的扇形三角化。
 */

import { readFile } from 'node:fs/promises'
import { makeMesh } from '../core/geometry.mjs'

export function parseObj(text, opts = {}) {
  const groups = new Map()
  let current = null
  const ensure = (name) => {
    if (!groups.has(name)) groups.set(name, { positions: [], faces: [] })
    return groups.get(name)
  }
  const verts = []
  let name = opts.defaultName || 'mesh'
  current = ensure(name)
  const lines = text.split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const sp = line.indexOf(' ')
    const tag = sp < 0 ? line : line.slice(0, sp)
    const rest = sp < 0 ? '' : line.slice(sp + 1).trim()
    if (tag === 'v') {
      const p = rest.split(/\s+/)
      verts.push([Number(p[0]), Number(p[1]), Number(p[2])])
    } else if (tag === 'o' || tag === 'g') {
      name = rest || name
      current = ensure(name)
    } else if (tag === 'f') {
      const parts = rest.split(/\s+/)
      const idx = parts.map((p) => {
        const v = Number(p.split('/')[0])
        return v > 0 ? v - 1 : verts.length + v
      })
      if (idx.length >= 3) current.faces.push(idx)
    }
  }
  const meshes = []
  for (const [gname, g] of groups) {
    if (g.faces.length === 0) continue
    const local = new Map()
    const positions = []
    const indices = []
    for (const f of g.faces) {
      for (let k = 1; k + 1 < f.length; k++) {
        for (const vi of [f[0], f[k], f[k + 1]]) {
          let li = local.get(vi)
          if (li === undefined) {
            li = positions.length / 3
            local.set(vi, li)
            const v = verts[vi] || [0, 0, 0]
            positions.push(v[0], v[1], v[2])
          }
          indices.push(li)
        }
      }
    }
    meshes.push(makeMesh(gname, gname, new Float32Array(positions), new Uint32Array(indices)))
  }
  return meshes
}

export async function loadObjFile(filePath, opts = {}) {
  const text = await readFile(filePath, 'utf8')
  return parseObj(text, opts)
}

export function sceneInfoFromMeshes(meshes) {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const m of meshes) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], m.bbox[i])
      max[i] = Math.max(max[i], m.bbox[i + 3])
    }
  }
  return {
    meshes: meshes.length,
    triangles: meshes.reduce((a, m) => a + m.triangles, 0),
    bbox: { min: min.map((v) => (Number.isFinite(v) ? v : 0)), max: max.map((v) => (Number.isFinite(v) ? v : 0)) },
  }
}
