/**
 * PBR 材质资源库：给 agent 的检索入口。
 *
 * 为什么需要：PBR 材质的质量决定渲染成败。手搓程序化材质能做，
 * 但有现成的**扫描级**材质库时，直接用比现场做更好——因为：
 *   - 真实材质的粗糙度分布、微小划痕、颜色渐变很难凭空编对
 *   - 扫描材质自带配套的 normal/roughness/metalness 贴图，一致性有保证
 *   - 省下大量迭代时间
 *
 * 所以策略是**检索优先于自制**：先查这几个站，找不到合适的再做程序化材质。
 *
 * 这些站点全部提供**免费可商用**的 PBR 材质，且不需要登录就能下载。
 */

/**
 * 材质资源库清单。
 *
 * 每个条目给出：
 *   - 检索入口：可以直接拼关键词的搜索 URL
 *   - 特点：分辨率、是否含全套贴图、授权
 *   - 适合什么
 */
export const PBR_LIBRARIES = [
  {
    id: 'ambientcg',
    name: 'ambientCG',
    searchUrl: 'https://ambientcg.com/find?q={q}',
    homeUrl: 'https://ambientcg.com/',
    license: 'CC0（完全免费，可商用，无需署名）',
    resolution: '1K / 2K / 4K / 8K',
    maps: ['Color', 'Normal', 'Roughness', 'Metalness', 'AO', 'Displacement', 'Emission'],
    formats: ['PNG', 'JPG', 'EXR', 'USD', 'MTL'],
    bestFor: '建筑、地面、墙面、金属、木材、混凝土。数量最大，CC0 授权最省心',
    note: '直接把 zip 解压后按贴图类型命名即可接入 Blender。',
  },
  {
    id: 'polyhaven',
    name: 'Poly Haven',
    searchUrl: 'https://polyhaven.com/textures?q={q}',
    homeUrl: 'https://polyhaven.com/textures',
    license: 'CC0（完全免费，可商用，无需署名）',
    resolution: '1K / 2K / 4K / 8K',
    maps: ['diffuse', 'nor_gl', 'rough', 'arm', 'displacement'],
    formats: ['JPG', 'PNG', 'EXR'],
    bestFor: '高质量扫描材质。地面、砖石、布料、金属。质量顶级，数量少于 ambientCG',
    note: '提供 ARM 打包贴图（AO+Roughness+Metallic 在一张图里），Blender 里用 Separate Color 可拆。',
  },
  {
    id: 'texturecan',
    name: 'TextureCan',
    searchUrl: 'https://www.texturecan.com/?s={q}',
    homeUrl: 'https://www.texturecan.com/',
    license: 'CC0',
    resolution: '1K / 2K / 4K',
    maps: ['Base Color', 'Normal', 'Roughness', 'Metallic', 'AO', 'Height'],
    formats: ['PNG', 'JPG'],
    bestFor: '织物、皮革、木材、石材。分类清晰，适合找特定工艺材质',
  },
  {
    id: 'cgbookcase',
    name: 'CG Bookcase',
    searchUrl: 'https://www.cgbookcase.com/textures?search={q}',
    homeUrl: 'https://www.cgbookcase.com/textures',
    license: 'CC0',
    resolution: '1K / 2K',
    maps: ['Color', 'Normal', 'Roughness', 'AO', 'Height'],
    formats: ['PNG', 'JPG'],
    bestFor: '建筑与室内表面。数量中等但质量稳定',
  },
  {
    id: 'sharetextures',
    name: 'Share Textures',
    searchUrl: 'https://www.sharetextures.com/search?q={q}',
    homeUrl: 'https://www.sharetextures.com/',
    license: 'CC0',
    resolution: '1K / 2K / 4K',
    maps: ['Base Color', 'Normal', 'Roughness', 'Metalness', 'AO', 'Displacement'],
    formats: ['PNG', 'JPG'],
    bestFor: '综合材质。地面、墙面、木纹、金属',
  },
  {
    id: 'freepbr',
    name: 'FreePBR',
    searchUrl: 'https://freepbr.com/?s={q}',
    homeUrl: 'https://freepbr.com/',
    license: '免费（部分需署名，商用前看具体条目）',
    resolution: '1K / 2K',
    maps: ['Base Color', 'Normal', 'Roughness', 'Metallic', 'Height'],
    formats: ['PNG'],
    bestFor: '金属、锈蚀、混凝土、布料',
    note: '授权逐条不同，商用前必须确认。',
  },
  {
    id: 'quixel',
    name: 'Quixel Megascans（Bridge）',
    searchUrl: 'https://quixel.com/megascans/home?search={q}',
    homeUrl: 'https://quixel.com/megascans',
    license: '免费用于 Unreal Engine；其它引擎需查条款',
    resolution: '最高 8K',
    maps: ['Albedo', 'Normal', 'Roughness', 'AO', 'Displacement', 'Specular'],
    formats: ['需 Bridge 导出'],
    bestFor: '影视级扫描材质。质量最高，但需要安装 Bridge 且授权受限',
    note: '授权复杂，非 UE 项目慎用。',
  },
]

/**
 * 生成检索建议：给定材质描述，返回按推荐度排序的检索链接。
 *
 * @param {string} query 材质描述（中英都可以，会自动翻译常见词）
 * @param {object} [opts]
 * @returns {{query:string, englishQuery:string, links:Array, tip:string}}
 */
export function buildMaterialSearch(query, opts = {}) {
  const q = String(query || '').trim()
  const english = toEnglishQuery(q)
  const encoded = encodeURIComponent(english || q)

  const links = PBR_LIBRARIES.map((lib) => ({
    id: lib.id,
    name: lib.name,
    url: lib.searchUrl.replace('{q}', encoded),
    home: lib.homeUrl,
    license: lib.license,
    resolution: lib.resolution,
    maps: lib.maps,
    formats: lib.formats,
    bestFor: lib.bestFor,
    note: lib.note || null,
  }))

  return {
    query: q,
    englishQuery: english,
    links,
    /* 优先级建议：CC0 的放前面，授权复杂的放后面 */
    recommendedOrder: ['ambientcg', 'polyhaven', 'texturecan', 'cgbookcase', 'sharetextures', 'freepbr', 'quixel'],
    tip: '可先查 ambientCG 和 Poly Haven；以具体资源条目的当前授权和下载内容为准。'
      + '按材料与目标格式选择通道，粗糙度、金属度可用常量，不强制完整贴图包；'
      + '程序化材质和简单纯色可直接自行编写。',
  }
}

/**
 * 常见中文材质词 → 英文检索词。
 *
 * 为什么不直接翻译整句：材质站的关键词是名词（wood, metal），
 * 整句翻译反而不匹配。所以做词表映射。
 */
const MATERIAL_TERMS = [
  [/橡木/, 'oak'],
  [/胡桃木/, 'walnut'],
  [/松木/, 'pine'],
  [/木地板/, 'wood floor'],
  [/木|木材|木头/, 'wood'],
  [/不锈钢/, 'stainless steel'],
  [/镀锌/, 'galvanized'],
  [/铝/, 'aluminum'],
  [/铜/, 'copper'],
  [/黄铜/, 'brass'],
  [/锈迹/, 'rust'],
  [/锈|生锈/, 'rusty metal'],
  [/金属|钢铁|铁/, 'metal'],
  [/水泥砖|砌块/, 'cinder block'],
  [/混凝土|水泥/, 'concrete'],
  [/大理石砖/, 'marble tile'],
  [/大理石/, 'marble'],
  [/花岗岩/, 'granite'],
  [/石灰石/, 'limestone'],
  [/瓷砖/, 'tile'],
  [/砖|砖墙/, 'brick'],
  [/石|石头|岩石/, 'rock'],
  [/地毯/, 'carpet'],
  [/帆布/, 'canvas'],
  [/布|织物|布料/, 'fabric'],
  [/皮革/, 'leather'],
  [/橡胶/, 'rubber'],
  [/塑料/, 'plastic'],
  [/玻璃/, 'glass'],
  [/陶瓷/, 'ceramic'],
  [/纸/, 'paper'],
  [/沙子|沙地/, 'sand'],
  [/泥土|土壤/, 'dirt'],
  [/草|草地/, 'grass'],
  [/沥青/, 'asphalt'],
  [/路面|道路/, 'road'],
  [/雪/, 'snow'],
  [/冰/, 'ice'],
  [/水/, 'water'],
  [/划痕/, 'scratched'],
  [/脏|污渍/, 'dirty'],
  [/旧|破旧|做旧/, 'worn'],
]

/** 把中文材质描述转成英文检索词。 */
export function toEnglishQuery(input) {
  const s = String(input || '').trim()
  if (!s) return ''
  /* 已经是英文就直接用 */
  if (/^[\x20-\x7e]+$/.test(s)) return s

  const hits = []
  for (const [re, en] of MATERIAL_TERMS) {
    if (re.test(s)) hits.push(en)
  }
  if (hits.length) {
    /* 去重后拼接，最多 3 个词——材质站的关键词越精简匹配越好 */
    return [...new Set(hits)].slice(0, 3).join(' ')
  }
  /* 没匹配到就原样返回，让模型自己想办法 */
  return s
}
