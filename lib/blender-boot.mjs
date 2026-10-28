/**
 * Blender 环境自检与自启。
 *
 * 场景建模模式开始时的第一件事：确认「MCP 服务器」和「Blender addon」都活着。
 * 缺哪个补哪个，补不上就明确告诉模型该让用户做什么。
 *
 * 三层检查：
 *   1. MCP 服务器（本插件的兄弟进程）—— 由 DSH 的 mcp-client 负责连，这里只探端口
 *   2. Blender 进程是否在跑
 *   3. Blender 里的 addon socket 是否在监听
 *
 * 自动拉起策略：
 *   - MCP 服务器没起 → 用 node 拉起来（detached，不占住 DSH）
 *   - Blender 没起 → 用 blender.exe 打开（可带一个 .blend）
 *   - Blender 起了但 addon 没点 Start → **无法自动点**（那需要 GUI 操作），
 *     所以返回明确的用户指引
 */

import { spawn, execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import net from 'node:net'

const OWNED_BLENDER = new Map()

/**
 * 找 MCP 服务器启动脚本（server.mjs / start-server 入口）。
 *
 * 为什么必须自动发现：ensureBlenderStack 只在「给了 serverScript 且文件存在」时才
 * 拉起服务器，否则直接放弃并报「请手动启动 MCP 服务器」。实测两次建模测试里
 * mcpServerScript 都是空的，于是服务器永远等不到插件，只能靠模型自己
 * Start-Process 救场——而且它救的那次恰好让插件的探测结果变成了假就绪。
 *
 * 查找顺序（先具体后通用）：
 *   ① 配置里显式写的路径
 *   ② 环境变量 BLENDER_MCP_DIR / BLENDER_MCP_SERVER
 *   ③ 与本包同级安装的 blender-mcp（npm 平铺后的真实形态）
 *   ④ DSH profile 的 node_modules（link / junction 安装的形态）
 */
export function findMcpServerScript(explicit, opts = {}) {
  /* 显式配置优先，且不回退：用户写了路径却不存在时，
   * 悄悄换成自动发现的另一份脚本会更难查（可能拉起旧版本或别的机器上拷来的包）。
   * 这时必须返回 null，让上层报「配置的路径不存在」。 */
  if (explicit) {
    try {
      if (existsSync(explicit)) return { script: explicit, source: 'config' }
    } catch { /* 落到下面返回 null */ }
    return null
  }
  const cands = []
  if (process.env.BLENDER_MCP_SERVER) cands.push(process.env.BLENDER_MCP_SERVER)
  if (process.env.BLENDER_MCP_DIR) {
    cands.push(path.join(process.env.BLENDER_MCP_DIR, 'src', 'server.mjs'))
    cands.push(path.join(process.env.BLENDER_MCP_DIR, 'start-server.bat'))
  }
  const here = opts.packageDir || ''
  if (here) {
    /* 三种真实安装形态，按可能性排序：
     *   开发机同级目录      <ws>/ptc-model-check 与 <ws>/blender-mcp
     *   npm 平铺            node_modules/<pkg> 与 node_modules/blender-mcp
     *   scoped 安装         node_modules/@local/ptc-model-check → node_modules/@local/blender-mcp
     */
    cands.push(path.resolve(here, '..', 'blender-mcp', 'src', 'server.mjs'))
    cands.push(path.resolve(here, '..', '@local', 'blender-mcp', 'src', 'server.mjs'))
    cands.push(path.resolve(here, '..', '..', 'blender-mcp', 'src', 'server.mjs'))
  }
  const profileDir = process.env.DSH_PROFILE_DIR
  if (profileDir) {
    cands.push(path.join(profileDir, 'node_modules', '@local', 'blender-mcp', 'src', 'server.mjs'))
    /* 官方包名形态（发到 npm 之后） */
    cands.push(path.join(profileDir, 'node_modules', 'blender-mcp', 'src', 'server.mjs'))
  }
  /* 兜底：从本包位置逐级往上找 node_modules/@local/blender-mcp。
   * pnpm 的 nodeLinker=hoisted 时它就在上层的 node_modules 里；
   * DSH_PROFILE_DIR 没设（比如 headless / SDK 运行）也能命中。 */
  let up = here
  for (let i = 0; i < 5 && up; i++) {
    const nm = path.join(up, 'node_modules')
    if (existsSync(nm)) {
      cands.push(path.join(nm, '@local', 'blender-mcp', 'src', 'server.mjs'))
      cands.push(path.join(nm, 'blender-mcp', 'src', 'server.mjs'))
    }
    const parent = path.dirname(up)
    if (parent === up) break
    up = parent
  }
  for (const c of cands) {
    if (!c) continue
    try { if (existsSync(c)) return { script: c, source: c === explicit ? 'config' : 'auto' } } catch { /* ignore */ }
  }
  return null
}

/**
 * 判断一次失败的工具调用是不是「DSH 里没注册这个 MCP 工具」。
 *
 * 这是**唯一能确证第①层缺失的信号**：插件探不到 DSH 注册了什么工具，
 * 但只要模型真去调过 mcp__blender__* 并被拒，就说明服务器在线也没用——
 * 那台 MCP 服务根本没接进 DSH。
 *
 * 反过来不成立：没观察到调用 ≠ 没注册，所以这个标记只能由真实失败置位，
 * 绝不允许用「没看到」去推断。
 */
export function isNativeToolMissing(name, result) {
  if (!String(name || '').startsWith('mcp__blender__')) return false
  if (!result || result.isError !== true) return false
  const msg = String((result.error && result.error.message) || '')
    + ' ' + JSON.stringify(result.content || '').slice(0, 400)
  return /not found|unknown tool|no such tool|未找到|不存在/i.test(msg)
}

/**
 * 第①层的第二种失败：**客户端断连**（工具名注册了，但链路是死的）。
 *
 * 报文形如 `mcp-client(blender): server is disconnected`。
 *
 * 实测（建模测试 32）：DSH 启动时 MCP 服务器还没起，mcp-client 首次连接失败后
 * 不再重试；随后插件把服务器拉起来、状态报「就绪 ✓ 12 个工具」，但客户端仍是断的。
 * 模型探资源时发现断连，于是自己写 Python socket 桥直连 addon 的 9876 端口，
 * 全程 0 次 mcp__blender__*、0 次 model_loop——插件的所有检查被完全绕过。
 *
 * 与 tool not found 的区别：那种是「没有这个工具」，这种是「有工具但连不上」。
 * 处理方式完全不同：前者要装 bundle，后者只要**完全重启 DSH**（重装没用）。
 *
 * 这里不限定工具名：模型往往先用 list_mcp_resources 之类的旁路探到断连。
 */
export function isMcpClientDisconnected(name, result) {
  if (!result || result.isError !== true) return false
  const msg = String((result.error && result.error.message) || '')
    + ' ' + JSON.stringify(result.content || '').slice(0, 600)
  if (!/mcp-client\(/i.test(msg)) return false
  return /server is disconnected|is disconnected|not connected|连接已断开|已断开|连接断开/i.test(msg)
}

/** 从 MCP HTTP 地址取本机服务监听端口，避免探测自定义地址却启动默认端口。 */
export function mcpPortFromUrl(value, fallback = 8765) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback
  } catch {
    return fallback
  }
}

/** 探一个本地 TCP 端口是否在监听。 */
export function probePort(port, host = '127.0.0.1', timeoutMs = 1200) {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      try { sock.destroy() } catch { /* ignore */ }
      resolve(ok)
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
    try {
      sock.connect(port, host)
    } catch {
      finish(false)
    }
  })
}

/** 探 MCP 服务器的 /mcp 端点（比端口探测更准，能确认是 MCP 而不是别的服务）。 */
export async function probeMcp(url, timeoutMs = 2000) {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    if (!res.ok) return { ok: false, reason: 'HTTP ' + res.status }
    const j = await res.json()
    const count = j && j.result && Array.isArray(j.result.tools) ? j.result.tools.length : 0
    if (count === 0) return { ok: false, reason: '端点响应了但没有工具' }
    return { ok: true, toolCount: count }
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) }
  }
}

/** 找 blender.exe。 */
export function detectBlender(explicit) {
  const cands = []
  if (explicit) cands.push(explicit)
  if (process.env.PTC_BLENDER) cands.push(process.env.PTC_BLENDER)
  if (process.env.BLENDER_EXE) cands.push(process.env.BLENDER_EXE)

  // 常见安装位置（版本从高到低）
  const roots = [
    'C:/Program Files/Blender Foundation',
    'C:/Program Files (x86)/Blender Foundation',
    'D:/Program Files/Blender Foundation',
  ]
  for (const root of roots) {
    if (!existsSync(root)) continue
    try {
      const versions = require('node:fs').readdirSync(root)
        .filter((n) => /^Blender \d/.test(n))
        .sort()
        .reverse()
      for (const v of versions) cands.push(path.join(root, v, 'blender.exe'))
    } catch { /* ignore */ }
  }
  cands.push(
    'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe',
    '/Applications/Blender.app/Contents/MacOS/Blender',
    '/usr/bin/blender',
    '/snap/bin/blender',
  )
  for (const c of cands) {
    if (!c) continue
    try {
      if (existsSync(c)) return c
    } catch { /* ignore */ }
  }
  return null
}

/** 当前是否有 blender 进程在跑。 */
export function blenderRunning() {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32'
      ? ['-NoProfile', '-Command', "Get-Process -Name blender -ErrorAction SilentlyContinue | Measure-Object | Select-Object -ExpandProperty Count"]
      : ['-c', 'pgrep -c -f blender || true']
    const bin = process.platform === 'win32' ? 'powershell' : 'sh'
    execFile(bin, cmd, { timeout: 4000 }, (err, stdout) => {
      if (err) return resolve(false)
      const n = parseInt(String(stdout).trim(), 10)
      resolve(Number.isFinite(n) && n > 0)
    })
  })
}

/**
 * 拉起 Blender（GUI 模式，带 addon 自动启动）。
 *
 * 关键点：用 `--python-expr` 在 Blender 启动后立刻启动 addon 的 socket 服务器，
 * 这样用户不用手动点 Start MCP Server。
 */
export function launchBlender(blenderExe, opts = {}) {
  const port = opts.port || 9876
  const blend = opts.blend

  /* 这段 Python 在 Blender 启动后执行：
   * 1. 导入已启用的 addon 模块
   * 2. 起 MCPCommandServer
   * 3. 注册一个 timer 定期检查（保持引用，防止被回收） */
  const bootstrap = `
import bpy, sys
try:
    import blender_mcp as _mcp
except Exception as e:
    print('BLENDER_MCP_BOOT_FAIL', e)
else:
    try:
        _srv = _mcp.MCPCommandServer('127.0.0.1', ${port})
        _srv.start()
        print('BLENDER_MCP_BOOT_OK', ${port})
        # 挂到 bpy 上防止被 GC
        bpy.app.driver_namespace['__mcp_server__'] = _srv
    except Exception as e:
        print('BLENDER_MCP_BOOT_FAIL', e)
`.trim()

  const args = []
  if (blend && existsSync(blend)) args.push(blend)
  args.push('--python-expr', bootstrap)

  const child = spawn(blenderExe, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  })
  if (Number.isInteger(child.pid) && child.pid > 0) {
    OWNED_BLENDER.set(child.pid, path.resolve(blenderExe))
    child.once('exit', () => OWNED_BLENDER.delete(child.pid))
  }
  child.unref()
  return { pid: child.pid, args }
}

/** 拉起 MCP 服务器（node src/server.mjs）。 */
export function launchMcpServer(serverScript, opts = {}) {
  const port = opts.port || 8765
  const blenderPort = opts.blenderPort || 9876
  const child = spawn(process.execPath, [serverScript, '--port', String(port), '--blender-port', String(blenderPort)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  return { pid: child.pid }
}

/** 等一个端口起来（轮询）。 */
export async function waitForPort(port, timeoutMs = 20000, host = '127.0.0.1') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probePort(port, host)) return true
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}

function processExecutablePath(pid) {
  return new Promise((resolve) => {
    let bin, args
    if (process.platform === 'win32') {
      bin = 'powershell'
      args = ['-NoProfile', '-Command', '(Get-CimInstance Win32_Process -Filter "ProcessId = ' + pid + '").ExecutablePath']
    } else if (process.platform === 'darwin') {
      bin = 'ps'
      args = ['-p', String(pid), '-o', 'comm=']
    } else {
      bin = 'readlink'
      args = ['-f', '/proc/' + pid + '/exe']
    }
    execFile(bin, args, { timeout: 4000 }, (err, stdout) => {
      resolve(err ? null : String(stdout || '').trim() || null)
    })
  })
}

function samePath(a, b) {
  const left = path.resolve(String(a || ''))
  const right = path.resolve(String(b || ''))
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

/** Return a still-running Blender PID launched and owned by this plugin process. */
export async function findOwnedBlenderPid(blenderExe, ownedProcesses = OWNED_BLENDER, getExecutablePath = processExecutablePath) {
  if (!blenderExe || !ownedProcesses || typeof ownedProcesses[Symbol.iterator] !== 'function') return null
  for (const [pid, launchedExe] of ownedProcesses) {
    if (!Number.isInteger(pid) || pid <= 0 || !samePath(launchedExe, blenderExe)) continue
    const actualExe = await getExecutablePath(pid)
    if (!actualExe) {
      ownedProcesses.delete(pid)
      continue
    }
    if (samePath(actualExe, launchedExe)) return pid
    ownedProcesses.delete(pid)
  }
  return null
}

/** Stop one explicitly identified Blender PID. Never targets all Blender instances. */
export function killBlender(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return Promise.resolve({ ok: false, output: '需要有效的 Blender PID' })
  }
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 15000 }, (err, stdout) => {
        if (!err) OWNED_BLENDER.delete(pid)
        resolve({ ok: !err, output: String(stdout || '').slice(0, 500) })
      })
    } else {
      try {
        process.kill(pid, 'SIGTERM')
        OWNED_BLENDER.delete(pid)
        resolve({ ok: true, output: '' })
      } catch (err) {
        resolve({ ok: false, output: String(err && err.message || err) })
      }
    }
  })
}

/**
 * 完整的自检 + 自启流程。
 *
 * @returns {Promise<{ok:boolean, steps:string[], action:string, hint:string}>}
 */
export async function ensureBlenderStack(opts = {}) {
  const {
    mcpUrl = 'http://127.0.0.1:8765/mcp',
    mcpPort = 8765,
    blenderPort = 9876,
    serverScript,
    blenderExe,
    blend,
    autoLaunch = true,
    /* Blender 开着但 addon 没监听时，是否杀掉重启。
     * 默认 false——杀进程会丢未保存内容，必须由调用方明确要求。 */
    restartIfStuck = false,
    log = () => {},
  } = opts

  const steps = []

  /* ① MCP 服务器 */
  let mcp = await probeMcp(mcpUrl)
  if (mcp.ok) {
    steps.push('MCP 服务器在线（' + mcp.toolCount + ' 个工具）')
  } else if (!autoLaunch) {
    steps.push('MCP 服务器离线：' + mcp.reason)
    return { ok: false, steps, action: 'mcp-offline', hint: 'MCP 服务器没起，且自动启动被关闭（autoBootBlender=false）。' }
  } else if (serverScript && existsSync(serverScript)) {
    steps.push('MCP 服务器离线，正在启动…')
    launchMcpServer(serverScript, { port: mcpPort, blenderPort })
    const up = await waitForPort(mcpPort, 15000)
    if (up) {
      mcp = await probeMcp(mcpUrl)
      if (!mcp.ok) {
        steps.push('MCP 服务器端口起来了，但指定端点不可用：' + mcp.reason)
        return {
          ok: false,
          steps,
          action: 'mcp-endpoint-unavailable',
          hint: '服务已监听 ' + mcpPort + '，但 ' + mcpUrl + ' 没有返回有效 MCP 工具。请核对 mcp_url 与服务端口/路径。',
        }
      }
      steps.push('MCP 服务器已启动（' + mcp.toolCount + ' 个工具）')
    } else {
      steps.push('MCP 服务器启动失败（15 秒内没监听）')
      return { ok: false, steps, action: 'mcp-launch-failed', hint: '请手动运行 start-server.bat 看报错。' }
    }
  } else {
    /* 这个分支是两次建模测试踩到的真坑：服务器离线 + 不知道脚本在哪 = 永远起不来。
     * 报「请手动启动」等于把问题丢回给用户，而正确处置是装 blender-mcp bundle。 */
    steps.push('MCP 服务器离线，且找不到启动脚本')
    return {
      ok: false,
      steps,
      action: 'mcp-script-missing',
      hint: '本机没有 Blender MCP 服务器：请安装配套包 @local/blender-mcp（github.com/'
        + 'panda472328/dsh-blender-mcp 的 Release zip，解压到 DSH profile 的 node_modules/@local/blender-mcp），'
        + '或在插件配置 mcpServerScript 指向已有的 src/server.mjs。',
    }
  }

  /* ② Blender addon socket */
  let addonUp = await probePort(blenderPort)
  if (addonUp) {
    steps.push('Blender addon 在线（端口 ' + blenderPort + '）')
    return { ok: true, steps, action: 'none', hint: '' }
  }

  /* ③ Blender 进程 */
  const running = await blenderRunning()
  if (running) {
    steps.push('Blender 在运行，但 addon 没启动')

    /* 可选：杀掉重启。典型场景是 Blender 崩过一次，用户重开时没带 addon
     * 启动参数，或者 addon 被禁用，光靠点面板也未必能恢复。 */
    if (restartIfStuck && autoLaunch) {
      const exe2 = detectBlender(blenderExe)
      if (!exe2) {
        return {
          ok: false, steps, action: 'no-blender',
          hint: 'Blender 在跑但 addon 没监听，且找不到 blender.exe 无法重启。',
        }
      }
      const pid = await findOwnedBlenderPid(exe2)
      if (!pid) {
        return {
          ok: false, steps, action: 'manual-restart-required',
          hint: '当前 Blender 不是本插件启动且可验证归属的进程。为保护其他场景和未保存改动，不会自动结束它。'
            + '请先保存场景，再手动重启 Blender 并启动 MCP Server。',
        }
      }
      if (blend && !existsSync(blend)) {
        return {
          ok: false, steps, action: 'blend-not-found',
          hint: '找不到指定的 .blend 文件：' + blend + '。修正路径后再重启，避免误开空白场景。',
        }
      }
      steps.push('按请求重启本插件启动的 Blender（PID ' + pid + '；未保存的改动会丢失）')
      const stopped = await killBlender(pid)
      if (!stopped.ok) {
        return {
          ok: false, steps, action: 'restart-failed',
          hint: '无法结束本插件启动的 Blender：' + stopped.output + '。请手动重启并启动 addon。',
        }
      }
      await new Promise((r) => setTimeout(r, 2500))
      launchBlender(exe2, { port: blenderPort, blend })
      const rebooted = await waitForPort(blenderPort, 45000)
      if (rebooted) {
        steps.push('Blender 已重启，addon 自动就绪')
        return { ok: true, steps, action: 'restarted-blender', hint: '' }
      }
      steps.push('重启后 addon 仍没监听')
      return {
        ok: false, steps, action: 'addon-not-listening',
        hint: '重启后 addon 还是没起来。请在 Blender 里 Edit → Preferences → Add-ons '
          + '确认「Blender MCP」已勾选，再按 N → Blender MCP → Start MCP Server。',
      }
    }

    return {
      ok: false,
      steps,
      action: 'need-manual-start',
      hint: 'Blender 已打开，但 addon 没在监听端口。有两个办法：'
        + '① 在 3D 视口按 N → 「Blender MCP」标签 → 点 Start MCP Server；'
        + '② 若想让我自动重启 Blender（会丢失未保存改动），调 blender_ready 时传 restart_blender: true。',
    }
  }

  /* ④ 拉 Blender */
  const exe = detectBlender(blenderExe)
  if (!exe) {
    steps.push('找不到 blender.exe')
    return {
      ok: false,
      steps,
      action: 'no-blender',
      hint: '没找到 Blender。请安装 Blender，或用 BLENDER_EXE 环境变量指定路径。',
    }
  }
  if (!autoLaunch) {
    steps.push('Blender 没运行，自动启动被关闭')
    return { ok: false, steps, action: 'none', hint: '请手动打开 Blender。' }
  }

  if (blend && !existsSync(blend)) {
    steps.push('找不到指定的 .blend 文件：' + blend)
    return {
      ok: false, steps, action: 'blend-not-found',
      hint: '修正 blend 路径后再启动，避免误开空白场景。',
    }
  }

  steps.push('Blender 没运行，正在启动：' + path.basename(path.dirname(exe)))
  launchBlender(exe, { port: blenderPort, blend })
  const booted = await waitForPort(blenderPort, 45000)
  if (booted) {
    steps.push('Blender 已启动，addon 自动就绪')
    return { ok: true, steps, action: 'launched-blender', hint: '' }
  }
  steps.push('Blender 启动了但 addon 端口没起来')
  return {
    ok: false,
    steps,
    action: 'addon-not-listening',
    hint: 'Blender 已打开但 addon 没监听。请在 N 面板 → Blender MCP → 点 Start MCP Server。'
      + '若面板不存在，说明 addon 没启用（Edit → Preferences → Add-ons 里勾选 Blender MCP）。',
  }
}

/**
 * 把 ensureBlenderStack 的细粒度 action 归成「缺什么」几类。
 *
 * 为什么要归并：状态文本要据此决定「让不让模型读安装文档」。
 * 直接暴露 action 会给模型十几个分支去记，而它只需要知道
 * 「不缺 / 缺 Blender / 缺 MCP / 缺 addon 启动 / 配置错」这几种。
 *
 * **纯函数**：不探测、不联网，只做归类，方便单测。
 *
 * @param {{ok?: boolean, action?: string, hint?: string, nativeMissing?: boolean}} res
 *   ensureBlenderStack 的返回值 + runBoot 补的字段
 * @returns {{kind: string, needsInstallDoc: boolean, label: string}}
 */
export function classifyEnv(res) {
  const action = String((res && res.action) || '')

  /* ⓿ 客户端断连：服务器活着、工具名也在，但 DSH 到它的链路断了。
   * 比「没注册」更阴——探测全绿、状态报「就绪」，工具却调不动（建模测试 32）。
   * needsInstallDoc 为 false：装包救不了这个，只有完全重启 DSH 才能重建连接。 */
  if (res && res.mcpDisconnected) {
    return {
      kind: 'mcp-client-disconnected', needsInstallDoc: false,
      label: 'MCP 服务器在线，但 DSH 的 MCP 客户端已断开：工具调不动',
    }
  }

  /* ① 服务器可达 ≠ 工具存在。
   * 建模测试 27/28 都栽在这里——探测全绿，模型的工具列表里却一个
   * mcp__blender__* 都没有，于是它另开无头 Blender 硬做，插件的几何检查
   * 完全看不见那个场景（28 全程零检查）。报「已就绪」是错的，必须挡住。 */
  if (res && res.nativeMissing) {
    return {
      kind: 'mcp-not-registered', needsInstallDoc: true,
      label: 'MCP 服务器可达，但没接进 DSH：mcp__blender__* 工具不存在',
    }
  }
  if (res && res.ok) return { kind: 'ok', needsInstallDoc: false, label: 'Blender 与 MCP 均可用' }

  /* 缺 Blender 本体：机器上就没有可用的 blender.exe */
  if (action === 'no-blender') {
    return { kind: 'no-blender', needsInstallDoc: true, label: '缺少 Blender（本机没找到可用的 blender.exe）' }
  }
  /* 缺 MCP 服务器进程/端点 */
  if (action === 'mcp-launch-failed' || action === 'mcp-endpoint-unavailable') {
    return { kind: 'mcp-down', needsInstallDoc: true, label: 'Blender 已装，但 MCP 服务器没起来' }
  }
  /* 连启动脚本都找不到：必须装 blender-mcp bundle（它同时负责注册第①层） */
  if (action === 'mcp-script-missing') {
    return { kind: 'mcp-missing', needsInstallDoc: true, label: '本机没有 Blender MCP 服务器（缺 server.mjs 与 bundle 注册）' }
  }
  if (action === 'mcp-offline') {
    return { kind: 'mcp-down', needsInstallDoc: true, label: 'MCP 服务器离线，且自动启动已关闭' }
  }
  /* Blender 在跑但 addon 没监听：环境装了，差「启用 / 启动」这一步 */
  if (action === 'addon-not-listening' || action === 'need-manual-start'
    || action === 'manual-restart-required' || action === 'restart-failed') {
    return { kind: 'addon-down', needsInstallDoc: true, label: 'Blender 已装，但 addon 没在监听端口' }
  }
  /* 配置问题：Blender 本身没问题，是 .blend 路径写错。读安装文档没用，要改配置。 */
  if (action === 'blend-not-found') {
    return { kind: 'config-error', needsInstallDoc: false, label: '插件配置的 .blend 路径不存在' }
  }
  /* 'none' 以及未知 action：环境不完整，但没有更精确的原因。
   * 仍按「要装」处理——模型至少该按文档把五项验收跑一遍。 */
  return { kind: 'incomplete', needsInstallDoc: true, label: 'Blender 环境未就绪（原因未细分）' }
}
