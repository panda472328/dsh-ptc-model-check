# 更新记录

## 2.29.1

- **只发建模包时，接收方的 AI 能自己补齐第③层**：运行时上下文现在给出安装文档的**绝对路径**、当前 profile 的绝对路径，以及可直接执行的安装命令 `dsh plugin --profile <名> add file:<解压目录>`；并明确说明建模模式没有 `plugin_manager` 工具，别去用。
- **安装文档改为 CLI 优先**：实测干净机器上 `Get-Command pnpm` 直接缺失，原「方式 B」里的 `pnpm install` 会失败。DSH 自带 CLI 内含 pnpm，且 `dsh plugin ... add` 会自动登记 `dsh.profile.bundles`（手工方式最容易漏的一步）。
- 回归补断言：绝对文档路径、CLI 命令带真实 profile 名、Release 直链、全文不许出现 `pnpm install`。
## 2.29.0

修复「环境探测全绿、建模通道却不存在」，并新增看图即检测。

### 修复：第③层缺失会导致零检查建模

- 环境自检原来只探测 MCP 服务器进程与 addon socket，探测不到「DSH 侧有没有把服务器注册成 `mcp__blender__*` 工具」。两次真实建模测试（27/28）都是服务器在线、状态显示「已就绪」，但模型工具列表里没有任何 MCP 工具，于是模型自己另开无头 Blender 跑脚本，插件的几何检查与看图检测全程看不见那个场景——28 全程零检查。
- 新增第③层判据：本会话内调用 `mcp__blender__*` 被 DSH 拒绝时置位 `nativeMissing`，状态文本改为「MCP 服务器可达，但没接进 DSH」，给出 bundle 下载入口，并**显式禁止**用无头 Blender 或手写 JSON-RPC 绕过。
- `classifyEnv()` 新分类：`mcp-not-registered`（优先于 `ok`）、`mcp-missing`、`mcp-down`。

### 新增：MCP 服务器脚本自动发现

- `findMcpServerScript()`：`mcpServerScript` 留空时按 `BLENDER_MCP_SERVER` → `BLENDER_MCP_DIR` → 同级包 → `DSH_PROFILE_DIR/node_modules` → 逐级上溯 `node_modules` 查找 `src/server.mjs`。
- **显式配置的路径不存在时不回退**，直接返回 null 并报错——旧行为会静默改用另一份脚本，可能拉起旧版本，比报错更难查。
- `ensureBlenderStack()` 的两个含糊 `action: 'none'` 拆成 `mcp-script-missing` 与 `mcp-offline`。

### 新增：看图即检测

- `look` / `render_preview` 的结果后追加穿模与孤立摘要（`buildViewCheckReport()`，与 `model_isolation` 同源同阈值）。
- 由 `tools/post-execute` 完成，只替换 `content`；全程 try/catch 加超时，检测失败只附一行说明，绝不影响看图。
- 新配置：`viewCheck`（默认 true）、`viewCheckItems`（6）、`viewCheckTimeoutMs`（120000）。

### 新增：安装文档与分发

- `docs/install-blender-mcp.md` 按四层依赖（Blender / addon / bundle 注册 / 服务器进程）重写，含 GitHub 下载地址、bundle 注册步骤、addon 单文件落位、七项验收与失败对照。
- 环境齐全时上下文不出现该文档；缺任意一层才给路径并强制阅读。
- 补齐 `LICENSE`、`.gitignore`、`icon.svg`、`repository`；从 `package.json` 移除不存在的 `locale/*.json` 与两个已删除的 audit 文档引用。

### 修复：整场景出图被远处环境物毁掉取景

- 真机实测：AURORA-9 空间站主体 71~79 单位、中心在原点，而 `ENV_ATMO`/`ENV_EARTH` 是 425~462 单位、中心在 `[3167, 4091, 4095]`（约 6500 单位外）。整场景取景以环境球为准 → 空间站被压成亚像素 → `look` 返回一整张背景灰。`model_loop` 的场景五视图与 `model_review` 的整场景俯视/斜视都受影响，而"整体布局"只能靠这两张图判断。
- 新增 `lib/core/framing.mjs`：场景级取景前先算「该框哪些对象」。两条规则按可信度分开：
  - **命名识别**（`ENV_ROOT`/`BG_SKY`/`SKY`/`地球`/`天空`…）是显式意图，只要剔完还剩主体就照做，不设比例上限；
  - **统计离群**（中心距离 / 自身尺寸，中位数 + k×MAD，并加「中位数 × 4」的量级地板）是推断，靠中位数自身鲁棒性兜底——离群过半时阈值失真，自然变成「一个都不剔」。
  - 任何情况下不把主体剔空；被剔除的对象**仍在画面里**，只是不决定缩放。
- 两个场景级调用点都接上了：`model_loop` 的场景五视图、`model_review` 的整场景 top/iso；`renderShots` 负责把 `focus` 转发给 `renderLive`。报告会写明「取景只框主体，已排除 X、Y；它们仍在画面里」，避免模型误以为环境没做。
- **真机验证**（Blender 5.2 + AURORA-9，经插件自己的 `extractLive`/`pickFramingFocus`/`renderLive`）：37 个 mesh，识别出 `ENV_EARTH`/`ENV_ATMO`/`ENV_STARS` 三个环境物；取景对角线 6916 → 211（缩小 32.8×）。同一 iso 视角：按全部对象取景 → Blender 侧报「100.0% 的像素相同」全灰空图；按新取景 → 完整空间站、无警告。
- 回归 `verify_framing_focus`（7 段）：环境名识别不误伤 `SPACE_STATION`、真实尺寸下的 collection/outlier 两模式、离群过半时不猜、全环境不剔空、正常场景不误剔，以及两处调用点与 `focus` 转发确实接上。

### 移除：磁盘 `.blend` 读取模式

- `source: 'blender'` 依赖 `runtime/blender_bridge.py` 通过 `blender -b --python <脚本>` 通信，但**该桥接脚本从未随包发布**（当前包与全部历史备份里都没有）。实际后果是 spawn 一个参数指向不存在文件的 Blender 进程并卡到 180s 超时——对分发出去的包是最糟的失败形态。
- 现在该模式**立即失败**并返回 `BLEND_MODE_REMOVED`，说明原因与替代路径（`source: 'file'` 读 `.obj`，或让 Blender 开着走 live）。
- `auto` 不再把 `.blend` 当读取源，优先级变为 **live > 网页 > 文件**；`blend` 配置项保留，但只用于「启动 Blender 时打开哪个文件」。
- 删除死代码 `lib/adapters/blender.mjs`（只服务该模式）；`source` 参数枚举去掉 `blender`；README 同步。
- 回归断言加在 `verify_source_selection.mjs`：立刻失败、`auto + 仅 blend` 报 `NO_SOURCE`、死文件已删、schema 与 README 不再宣传该模式。

### 测试

- 43 项离线回归全绿。新增 `verify_view_checks`、`verify_env_install_guide`（后者用 `new Function` 抽取真实 `buildStateText` 执行，验证「就绪时不提文档、缺环境时必提」，并覆盖降级守卫）。

## 2.28.0

整体场景构想提前到开工，修复材质复核出图。详见 README「怎么用」。
