/** 离线覆盖两条真实工具路径、结果渲染和独立检索脚本，不访问网络或创建子代理。 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { buildTools } from '../lib/tools.mjs'
import { researchText } from '../lib/core/research-guidance.mjs'

const exec = promisify(execFile)
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ptc-research-'))
const query = '设备外壳 连接 支撑'
const evidence = 'M16 型号，2024年方案。面板宽320 mm，支撑间距180毫米，采用12枚螺钉连接三层外壳，体块比例3:2。'
  + '面板可拆卸，框架支撑壳体，连接结构为维护开口提供避让；不同实例可以采用不同分区和加工方式。'
const url = 'https://example.invalid/M16/2024/320'
const source = { title: 'M16 2024年连接结构 320 mm', url, snippet: evidence, hasStructWord: true }
const research = (deps) => buildTools(deps).find((t) => t.name === 'model_reference')
const assertExploratory = (value, tool) => {
  assert.equal(value.mode, 'explore')
  const rendered = JSON.stringify(tool.output.render({}, value))
  for (const precise of ['320 mm', '180毫米', '12枚', '三层', '3:2']) {
    assert.ok(!rendered.includes(precise), 'precise evidence cannot bypass policy via rendered JSON: ' + precise)
  }
  assert.ok(rendered.includes('M16') && rendered.includes('2024年'))
  assert.ok(rendered.includes(url), 'source URLs remain usable')
  assert.ok(rendered.includes('可拆卸') && rendered.includes('支撑壳体'), 'structural information survives')
  assert.ok(value.guidance.join('').includes('不是逐字引文'), 'adapted excerpts are clearly labelled')
  assert.ok(value.guidance.join('').includes('原创'))
}

try {
  // 子进程返回未处理证据，确保工具自身也执行策略，且参数不串入查询。
  const fixtureDir = path.join(root, 'fixture')
  await fs.mkdir(path.join(fixtureDir, 'scripts'), { recursive: true })
  await fs.writeFile(path.join(fixtureDir, 'scripts/research.mjs'),
    'console.log(JSON.stringify(' + JSON.stringify({ ok: true, effective: true, relevantCount: 1,
      sources: [source], bodies: [{ url, body: evidence }] }) + '))')
  const local = research({ packageDir: fixtureDir })
  const localExplore = await local.execute({ query, aspect: 'motion', depth: 'deep' })
  assertExploratory(localExplore, local)
  assert.equal(localExplore.via, 'script')
  assert.equal(localExplore.aspect, 'motion', 'local path preserves requested research angle')
  const localVerify = await local.execute({ query, mode: 'verify' })
  assert.equal(localVerify.sources[0].snippet, evidence)
  assert.equal(localVerify.excerpts[0].excerpt, evidence)

  const searches = []
  const fallback = research({ packageDir: path.join(root, 'no-script'), hostCtx: {
    get: (name) => name === 'web' ? {
      search: async ({ query: fullQuery }) => { searches.push(fullQuery); return { answer: evidence, sources: [source] } },
      fetch: async () => ({ body: { content: '<p>' + evidence.repeat(2) + '</p>' } }),
    } : undefined,
  } })
  const webExplore = await fallback.execute({ query, aspect: 'motion', depth: 'deep' })
  assertExploratory(webExplore, fallback)
  assert.ok(!searches[0].includes('行程多大') && searches[0].includes('运动方向'))
  const webVerify = await fallback.execute({ query, mode: 'verify', depth: 'deep' })
  assert.equal(webVerify.sources[0].snippet, evidence)
  assert.ok(webVerify.lines.join('').includes(evidence), 'verification retains exact answer evidence')
  assert.ok(webVerify.excerpts[0].excerpt.includes('180毫米'))
  assert.ok(webVerify.guidance.join('').includes('不能编造精度'))

  // 直接执行实际脚本；预载模块拦截 fetch，避免真实联网。
  const preload = path.join(root, 'mock-fetch.mjs')
  const html = '<li class="b_algo"><h2><a href="' + url + '">' + source.title
    + '</a></h2><div class="b_caption"><p>' + evidence + '</p></div></li>'
  await fs.writeFile(preload, 'globalThis.fetch = async (url) => {\n'
    + 'if (!String(url).startsWith("https://www.bing.com/search?")) throw new Error("unexpected network");\n'
    + 'const q = new URL(url).searchParams.get("q");\n'
    + 'if (!q.startsWith(' + JSON.stringify(query + ' ') + ') || q.includes("verify") || q.includes("explore") || q.includes("10")) throw new Error("CLI flags leaked into query: " + q);\n'
    + 'return { ok: true, text: async () => ' + JSON.stringify(html) + ' };\n}')
  const script = fileURLToPath(new URL('../scripts/research.mjs', import.meta.url))
  const cli = async (mode, json = true) => {
    const result = await exec(process.execPath, ['--import', pathToFileURL(preload).href,
      script, query, '--max', '10', '--aspect', 'motion', '--mode', mode, ...(json ? ['--json'] : [])],
    { windowsHide: true, timeout: 10000 })
    return json ? JSON.parse(result.stdout) : result.stdout
  }
  const cliExplore = await cli('explore')
  assert.equal(cliExplore.query, query)
  assert.equal(cliExplore.aspect, 'motion')
  assert.equal(cliExplore.mode, 'explore')
  assert.ok(!JSON.stringify(cliExplore).includes('320 mm'))
  const cliVerify = await cli('verify')
  assert.equal(cliVerify.sources[0].snippet, evidence)
  const cliText = await cli('explore', false)
  assert.ok(cliText.includes('定性节选') && !cliText.includes('320 mm'))

  // 不把未查到的数据换成伪精确值，也不改写纯粹的结构关系或产品型号。
  assert.equal(researchText('M16 / USB 3.0 / 2024年；两侧连接，内外壳留有间隙。'),
    'M16 / USB 3.0 / 2024年；两侧连接，内外壳留有间隙。')
  assert.equal(researchText(evidence, 'verify'), evidence)
  console.log('EXPLORATORY_RESEARCH_OK: local tool, web fallback, renderer and CLI verified offline')
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
