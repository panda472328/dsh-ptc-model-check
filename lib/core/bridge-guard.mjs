/**
 * 禁止自建 MCP / socket 桥的检测。
 *
 * 为什么要拦：建模测试 32 的模型在发现 `mcp-client(blender): server is disconnected`
 * 之后，自己写了 `bpy_send.py` 直连 addon 的 9876 socket，用 `bpy_run.py` 跑整个建模
 * 流程。它**确实能建出东西**，所以模型一旦成功就会一直走这条路——但插件的几何检查、
 * 看图检测、五视图和签收门禁全部看不见那个场景，等于所有质量保证失效。
 *
 * 判定原则：宁可漏，不可误杀。
 *   · 只有「连接类代码」和「目标端口/符号」同时出现才拦；
 *   · 单纯提到 9876（读文档、打印日志）不算；
 *   · 只认会执行或落盘的工具（pwsh / bash / write / edit）。
 */

/** 连接类代码：socket / TCP / asyncio 连接 / 原生 net 连接 */
const CONNECT_CODE = /socket\.|sendall|\.recv\(|create_connection|open_connection|new\s+net\.Socket|net\.connect|createConnection|io\.connect|Telnet|TcpClient/i

/** 目标：addon socket 端口，或 addon 内部的服务器类符号 */
const ADDON_TARGET = /9876|MCPCommandServer|blender_mcp\s*\(|addon\s*socket/i

/** 目标：MCP HTTP 端点 */
const HTTP_TARGET = /(?:127\.0\.0\.1|localhost|\[::1\]):8765/i

/** JSON-RPC 手写调用特征 */
const JSONRPC_CODE = /"jsonrpc"|'jsonrpc'|tools\/call|method\s*:\s*["']tools\/list/i

/** 会执行或落盘的工具（其余工具不拦） */
const GUARDED = new Set(['pwsh', 'bash', 'write', 'edit'])

const REASON = '禁止自建 MCP / socket 桥：不要用脚本直连 127.0.0.1:9876（addon）'
  + '或 127.0.0.1:8765（MCP HTTP）自己发命令。'
  + '建模请走 mcp__blender__*；它们调不动时，运行时状态会说明是哪一种：'
  + '「没接进 DSH」→ 装配套包 dsh-blender-mcp；「客户端断连」→ 完全退出 DSH 再启动。'
  + '自己搭桥会让插件的几何检查、看图检测、五视图和签收门禁全部失效'
  + '（建模测试 32 就是这样全程零检查）。'

/**
 * @param {string} name 工具名（可能是 mcp__server__tool 形式，取最后一段）
 * @param {object} args 工具参数
 * @returns {string|null} 命中时返回拒绝理由，否则 null
 */
export function detectHandwrittenBridge(name, args = {}) {
  const base = String(name || '').includes('__')
    ? String(name).split('__').pop()
    : String(name || '')
  if (!GUARDED.has(base)) return null

  let text = ''
  if (base === 'pwsh' || base === 'bash') {
    text = String((args && args.command) || '')
  } else if (base === 'write') {
    text = String((args && (args.content || args.text)) || '')
  } else if (base === 'edit') {
    text = String((args && (args.new_string || args.newString || args.replacement || '')) || '')
  }
  if (!text) return null

  /* addon socket 桥：连接代码 + 9876（或 addon 符号） */
  if (ADDON_TARGET.test(text) && CONNECT_CODE.test(text)) return REASON
  /* 手写 JSON-RPC 打 MCP HTTP */
  if (HTTP_TARGET.test(text) && JSONRPC_CODE.test(text)) return REASON
  return null
}
