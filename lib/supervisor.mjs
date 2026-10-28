/**
 * 启动期就把 Blender MCP 服务器拉起来。
 *
 * 为什么需要这个插件（不是可选项）：
 *   ptc-model-check 挂在**预设**里，只有「创建建模会话」时才 apply；
 *   而 blender-mcp 的 mcp-client 挂在 **profile**，DSH 一启动就去连 8765。
 *   服务器晚到 → 客户端首次连接失败 → 之后服务器就算起来了，客户端也一直
 *   `server is disconnected`（建模测试 32 的真实故障）。
 *
 * 这个插件挂在 profile 层，DSH 启动时立即执行：
 *   ① 端口已在监听 → 什么都不做；
 *   ② 没监听 → 找 server.mjs 并拉起，然后**等它真正监听**再返回，
 *      保证排在后面的 mcp-client 初次连接就能成功。
 *
 * 全程不抛异常：这个插件挂在启动路径上，崩了会连累整个 DSH 启动。
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findMcpServerScript, launchMcpServer, probePort, waitForPort } from './blender-boot.mjs'

export const name = 'ptc-blender-supervisor'

/** 不需要别的服务，纯粹在启动时做一件事。 */
export const inject = []

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = path.resolve(LIB_DIR, '..')

export function apply(ctx, rawConfig) {
  const config = rawConfig || {}
  const mcpPort = Number(config.mcpPort) || 8765
  const blenderPort = Number(config.blenderPort) || 9876
  const bootWaitMs = Number(config.bootWaitMs) || 15000

  const log = (msg) => {
    try {
      if (typeof ctx.logger === 'function') ctx.logger('info')('[ptc-supervisor] ' + msg)
      else console.error('[ptc-supervisor] ' + msg)
    } catch { /* 日志失败不影响启动 */ }
  }

  ctx.effect(() => {
    let stopped = false

    void (async () => {
      try {
        /* ① 已经在跑就不插手：可能用户自己起过，或本机是共享的。 */
        if (await probePort(mcpPort)) {
          log('MCP 服务器已在 ' + mcpPort + ' 监听，跳过启动')
          return
        }

        const found = findMcpServerScript(String(config.mcpServerScript || ''), { packageDir: PACKAGE_DIR })
        if (!found || !found.script) {
          /* 没装配套包时会走到这里。不是错误——环境自检会告诉用户去装。 */
          log('没找到 server.mjs（未安装 blender-mcp 配套包？），跳过启动')
          return
        }
        if (stopped) return

        log('拉起 MCP 服务器：' + found.script)
        try {
          launchMcpServer(found.script, { port: mcpPort, blenderPort })
        } catch (e) {
          log('启动失败：' + String((e && e.message) || e))
          return
        }

        /* ② 等端口起来再返回。这一步是关键：mcp-client 在启动序列里
         * 随后就会连接，服务器没监听它就会失败并长期停在 disconnected。 */
        const ok = await waitForPort(mcpPort, bootWaitMs)
        log(ok
          ? 'MCP 服务器已就绪（' + mcpPort + '）'
          : '等了 ' + bootWaitMs + 'ms 仍未监听（' + mcpPort + '），交给环境自检处理')
      } catch (e) {
        log('异常：' + String((e && e.message) || e))
      }
    })()

    return () => { stopped = true }
  }, 'ptc-model-check:supervisor')
}
