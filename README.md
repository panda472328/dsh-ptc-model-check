# ptc-model-check · 场景建模模式

场景建模特调。为 DeepSeek v4.1 (1017) 深度调优的独立 DSH 模式，把最高的推理与上下文预算花在造型、材质和构图上。

选它开一个会话，你要的不是一个「能跑通」的模型，而是一件作品：结构站得住，多视角经得起看，整体达到可交付的美术完成度。

配套 [blender-mcp](https://github.com/panda472328/dsh-blender-mcp) 让它真正看见并改动 Blender 场景。两个包成对使用——只装本包时，模式会退化成看不见场景的文本助手。

## 安装（新用户先看这一节）

需要四个东西，缺一个都跑不起来（或更糟：能跑但检查失效）：

| # | 依赖 | 从哪来 |
|---|---|---|
| ① | **Blender 4.2+** | <https://www.blender.org/download/> |
| ② | **addon** `blender_mcp.py`（在 Blender 里开 9876 socket） | 随 ③ 的包分发 |
| ③ | **blender-mcp bundle**（把服务器注册成 DSH 的 `mcp__blender__*` 工具） | <https://github.com/panda472328/dsh-blender-mcp/releases> |
| ④ | **MCP 服务器进程**（8765，`node src/server.mjs`） | 同 ③，插件可自动拉起 |

本包安装：<https://github.com/panda472328/dsh-ptc-model-check/releases> 下载 zip，解压后用 DSH 的插件管理安装，或把目录交给 AI 让它用 `plugin_manager` 安装。

⚠️ **③ 最容易漏，也最阴**：没有它，服务器照样能起、探测全绿、环境显示「已就绪」，但建模工具列表里一个 `mcp__blender__*` 都没有。真实后果见安装文档开头的案例（一次建模全程零几何检查）。

**先让 AI 自己检测，别急着读安装文档。** 插件每个会话都会自动探测这四项，并在运行时状态里给出结论：

- 全都有 → 状态显示「Blender 环境：**已就绪**」，直接开始建模，安装文档不必读，也不会被塞进上下文。
- 缺任意一项 → 状态会标出缺什么（`缺少 Blender` / `MCP 服务器离线` / `addon 没在监听` / `MCP 服务器可达，但没接进 DSH`），并**强制要求先读完 [docs/install-blender-mcp.md](docs/install-blender-mcp.md)** 再动手。那份文档按四层依赖给了下载、安装、启用、注册、端口核对和七项验收命令，全部可执行。

这样设计的原因：安装文档近万字符，环境正常时读它是纯浪费；环境缺失时它又必须完整，不能靠猜。所以**检测放代码里，文档按需强制**。

首次使用建议直接说一句「开始建模」，让插件先跑检测；需要手动确认时调 `blender_ready({})`。返回 `ok: true` 后**再调一次 `mcp__blender__get_scene_info`**，两条都通才算真的就绪。

工具以 DSH 的 **native** 方式呈现。2.26.1 在建模质量流程上增加场景级自主细化：AI 优先用 `execute_python` 自主编写单件、批量、参数化与材质节点脚本，插件负责参考、检查、复核和交付依据；多物品场景会按轮次提示构图层级、空间落点、主题环境、重复变化、密度留白和全局统一。连续建模达到批次阈值后会自动触发快速检查；脚本执行前后会比对真实几何版本，避免无变化脚本无谓地使旧检查失效。配套 Blender MCP 1.2.2 默认暴露 12 个基础工具，专用几何/材质工具保留在 `all` 兼容模式，不再成为流程依赖。插件注入两段上下文：

1. **常驻流程说明**：由 `lib/core/workflow.mjs` 与 `lib/core/detail.mjs` 组合，保留任务范围、场景构想、材质策略、硬表面质量与工具边界，约 6 千字符；工具参数由 schema 提供。
2. **运行时状态**：反馈整体范围与布局意图、材质意图、任务记忆、当前检查、复核待办和调研状态。该段第一行是一句审美测试声明（`lib/index.js` 的 `buildStateText()`）：声明本任务为极致审美测试、数据用于学术研究、预算充足，要求把美术与造型做到好看且完整，写实不必极致但完成度与风格必须极致，工具和资源为该任务让步；句子末尾的限定从句把它收在「不许因预算、轮数或耗时提前收工或放松标准」的范围内，不覆盖用户目标优先和真实限制如实说明。同一句也写在 preset 的 persona 前缀里（`cordis.patch.yml` 的 `persona` 行），两处措辞一致、可各自单独删除。图片、网页、附件文字作为参考材料，不替代用户要求。

2.25.1 默认采用探索式调研：提供构件关系、功能和可选做法，定性节选略去常见的明确尺寸、数量与比例，保留型号、年代和来源链接，并明确标注节选经过处理。需要用户指定尺寸、严格复刻、制造或接口配合时，`model_reference` 可传 `mode: 'verify'` 保留原始精确证据。资料中的特定实例、用户硬要求和 AI 原创设想要分开，避免过早锁死设计。检索脚本和宿主备用检索、文本和 JSON 返回遵循同一策略。

2.25.2 修复检查预算参数导致的模式加载失败：宿主参数 DSL 不支持 `minimum` / `maximum`，范围限制保留在实际执行处。新增注册兼容回归，宿主入口测试不再用不校验参数的恒等函数替代工具注册；另用本机真实宿主 SDK 验证全部 11 个工具及插件入口注册。

2.25.3 根据实际建模会话修复检查状态回显：`model_loop` 结果同步进入自检摘要，局部检查、覆盖不完整和后续改动分别说明，实际调用后的计数重置与整场景验收分开处理，不再边报上次结果边说从未自检。快速检查不再宣称附带全部分组视图。相交命中先结合用途和可见证据核实，避免把雾效、火焰、接地和有意装配一概要求删除或移开；检测数据与验收门槛保持不变。流程明确不以前置完整工具库开工，主体连接成型后开始分批自检。
对象对数量达到默认 5000 对上限时，现在可通过 `mesh_pair_budget` 调整（最高 200000），报告分别解释候选对象对、三角形计算和源抽取限制，避免提高错预算，或把减面与合并当成恢复检测覆盖的办法。
逐组优先项摘要不再称为「全部干净」，导出被拒时也会区分尚未调用检查与已检查但未签收，并回显最近阻断原因，避免重复检查、调高阈值和删件的无效循环。

2.26.1 增加场景级细化状态和全局场景复核清单。2.26.0 增加任务记忆账本、几何版本和疑点账本。检查结果会区分原始检测命中、模型的处置声明和未验证范围；检查能力受限时可以带明确限制交付阶段成果，但不会冒充验收通过。`execute_python` 中可识别的直接导出会转到统一的 `export_file` 流程。

## 怎么用

2.29.0 修复「探测全绿但建模通道不存在」，并新增看图即检测：

- **环境自检分四层判定**：Blender、addon、blender-mcp bundle（DSH 侧注册）、MCP 服务器进程。此前只探后两层，导致 `mcp__blender__*` 根本不存在时状态仍显示「已就绪」。现在本会话若调用原生工具被 DSH 拒绝，状态会明确报「MCP 服务器可达，但没接进 DSH」并给出安装入口，不再让模型误以为可以自己开无头 Blender 绕过去（真实后果：建模测试 28 全程零几何检查）。
- **服务器脚本自动发现**：`mcpServerScript` 留空时按环境变量、同级包、profile `node_modules` 逐级找 `src/server.mjs`；显式配置的路径不存在时直接报错，不会静默改用另一份脚本。原先后备的含糊 `action:'none'` 拆成 `mcp-script-missing` 与 `mcp-offline`。
- **看图即检测**：`look` / `render_preview` 的结果后自动追加穿模与孤立摘要（与 `model_isolation` 同源同阈值），由 `tools/post-execute` 完成，只替换 `content`，全程 try/catch 加超时，检测失败绝不影响看图。配置项 `viewCheck`、`viewCheckItems`、`viewCheckTimeoutMs`。
- **安装文档按需强制**：环境齐全时上下文不出现文档；缺任意一层时才给出 `docs/install-blender-mcp.md` 路径与强制阅读指令。文档按四层依赖重写，含 GitHub 下载地址、bundle 注册步骤、addon 单文件落位、七项验收。
- 离线回归 43 项，新增 `verify_view_checks`、`verify_env_install_guide` 与 `verify_framing_focus`（后者用 `new Function` 抽取真实的 `buildStateText` 执行，验证「就绪时不提文档、缺环境时必提」）。

2.28.0 将整体场景构想提前到开工，并修复材质复核出图：

- 按用户目标选择整体场景、单件或局部范围，适用于建筑群、街区、室内、工厂与其它组合场景。先规划功能分区、主次、动线、边界和配套，铺全局体块后逐区细化，不用建筑数量或精确尺寸限制发散。
- `model_source(action: 'memory')` 增加 `scope`、`layout`、`material_intent`。选定设计随任务账本保存并在每轮上下文回显，修复旧版账本未进入运行时上下文的问题。旧账本兼容；新会话恢复仍需指定同一个 `memory_file`。声明是计划，不自动证明完成。
- 整体场景即使只有一个物品组也会获得整体提示；明确单件/局部任务不会被扩成场景。整场景复核额外附俯视和斜视，单件隔离图不能证明整体布局完整。
- 材质先验证干净底材，再分别控制纹理尺度、颜色/粗糙度/凹凸变化和有依据的旧化。保留天然纹理与废墟等设定，不将噪波节点或污损一律禁用。
- 材质复核改用 `rendered` 真引擎，而非默认灰模图或仅材质色；缺图或空图警告不计为已验证。真实渲染比灰模图耗时，按材质批次聚焦代表件，必要时提高分辨率。出图顺序执行，不会自动创建子代理。
- 配套 Blender MCP 1.2.3 修复预览补光后的世界环境及临时数据恢复；更新后需重新加载 Blender 插件，运行中的旧代码不会自动替换。

2.27.0 将几何报告分成两层，`model_loop` 和 `model_isolation` 都返回 `hierarchy`：

- `global` 按物品组报告组间相交、接触和独立连接簇。组的包围盒只筛候选，真正证据仍来自组内零件表面。
- `internal` 逐组报告相交、内部连接簇和组外接触；彼此接触的一小团也可能与本组其余零件断开。
- 接触检测使用三角面和边边距离，移除包围盒包含及环抱自动豁免。容差为双方较小的相对容差，保留绝对上限；报告区分真实交线、容差内接近与未完成检测。
- 三角面横穿不会因薄片零厚度或整件对角线很长而被深度比例过滤；封闭实体包含采用与法线绕序无关的射线判断。深度仍是估计，包围盒形态分类不证明装配合理。
- 承托面也做真实表面检测，可能浅埋单列证据，严重下沉保留在相交报告。两层报告共享接触证据；未接触不直接证明摆放错误，连通也不能证明支撑正确。

`contact_work_budget` 和 `contact_pair_work_budget` 分别调整接触检测总预算和单对预算；超限标为未知，不误报孤立或通过。报告中的包围盒距离下界不是精确最近距离。组间/组内连接簇是需结合用途与视图核对的诊断，不新增固定数量或连接数量门禁。单个对象内部的自相交仍需专项检查。离线测试覆盖两层报告、薄片横穿、长构件、带面接触、空腔、反法线、旋转贴合、预算耗尽与抽取遗漏。

新建会话时，在模式选择里选 **「场景建模模式」**。该会话就拥有下面这些工具，系统提示里也会自动带上场景建模模式说明。

## 11 个工具

| 工具 | 做什么 |
|---|---|---|
| `blender_ready` | 检查 Blender MCP、Blender 进程和 addon；端点不一致时提示同步 DSH 原生 MCP 地址。 |
| `model_source` | 查看当前建模源、场景规模和流程状态；后续调用可临时切换到其他源。 |
| `model_naming` | `scan` 检查对象名、建议部件名、尺寸、材质和重名；`apply` 写回部件名。 |
| `model_isolation` | 检查没有与其他 mesh 表面接触的部件，并给出最近邻与距离。 |
| `model_loop` | 检查穿模、未接触、逐 mesh 诊断与分组；中间可快速检查，done 自动尝试完整五视图，缺图明确标注。 |
| `model_review` | 准备五视图复核任务；支持独立复核或 `reviewer: 'self'` 自查，缺图和无效回传不能作为视觉验收。 |
| `model_groups` | 检查物品分组、零件清单和未分组对象；优先识别 Blender Collection。 |
| `model_reference_image` | 分析参考 PNG 的主体、颜色、候选区域和网格位置；不能凭色块确定真实分件或基础色。 |
| `model_reference` | 调研物体结构、比例、运动或材质做法，并返回摘要和来源链接。 |
| `model_pbr_search` | 搜索免费 PBR 材质库并整理检索链接、授权和贴图通道信息。 |
| `model_deleted` | 查看删除记录，并为每个对象记录保留或恢复的结论。 |

## 建模流程

1. 会话开始查看自动注入的 Blender 环境状态；未就绪或连接报错时再调 `blender_ready`。用 `model_source` 查看场景来源和状态。
2. 明确用途、风格、单位、用户指定的尺寸约束、观看距离、文件格式和预算。需要精确定位颜色或区域时用 `model_reference_image`；拿不准结构或需要拓展细节做法时用 `model_reference`，默认探索可选结构而非生成精确蓝图。明确要求严格复刻时至少核实一条有效结构资料，不受预设产品名称列表限制，不为次数重复搜索。
3. 脚本内直接设置命名和 Collection；有命名问题时再用 `model_naming` 按需批量处理。首次建好多物品组或批量调整 Collection 后用 `model_groups` 核对。日常增删后 `model_loop` 会回显分组状态，发现异常时再单独检查。
4. 先从轮廓、功能分区、装配、工艺、维护、材料和使用状态发散设计，再选协调方案落实，随草模逐步确定参数。主体成型后默认自主细化：轮廓与比例 → 厚度、开口、连接和功能结构 → 倒角、高光、法线 → 按用途分配大中小细节与留白。原创细节可由功能与风格推导，不要求每项创意都有网页出处。先确认一件代表件，再扩展阵列/实例；不凑面数、零件数或装饰。草模、低模、简约和预算限制优先。
5. 一批几何修改后用 `model_loop({ quick_check: true, verdict: 'continue' })` 快速检查数据；结果中的 `detailGuidance` 按当前复核、图片和签收状态给出下一步。快速检查通过只说明技术状态，不代表细节已到位。
6. 可用多个子代理从功能结构、造型层次、材料工艺等互补角度提供候选思路，主 AI 汇总取舍并负责场景写入，避免同时修改同一场景。主要结构或细化批次完成后用 `model_review` 看图复核，`scene_note` 传用途、视距和约束，`style` 传画风。禁用子代理或并发受限时传 `reviewer: 'self'`，当前 AI 看图并保留任务标识回传；允许独立复核时按可用并发并行或分批执行。自查不冒充独立结果，不能覆盖技术命中。局部复查保留其他组的待办。
7. 材质与几何可以交替制作，PBR 资源检索可选，脚本可直接创建节点。标签、图案可用贴图；轮廓、厚度和开口需真实几何。纯常量材质不强制 UV，新制品不强制旧化。合理合并允许，保留可编辑源结构；不为绕过检查合并物品。
8. 达到任务目标且没有有依据的高价值缺口时，用 `model_loop({ target: 'scene', verdict: 'done', stop_reason: '完成情况与剩余限制' })` 收尾。局部 done 不签收全场景，几何再修改使旧签收失效。保存和过程预览随时可用；已改几何的最终导出要求最新有效全场景检查，失败检查不能仅凭“调用过”就放行。

`model_loop` 默认提供正视、背面、侧视、顶视和正视剪影；中间迭代可跳过渲图，`verdict: 'done'` 会自动执行完整视图。逐组视图默认关闭，可用 `per_mesh_views: true` 开启；`model_review` 用于关键节点的结构或材质复核。参考图剪影门槛默认 92%，可在调用时调整。

五视图不足以证明倒角高光、底面或内部结构，按需补斜视与近景。面密度离群仅作建议，不要求给平板加面或给曲面减面。`done` 缺图时只表示技术范围的检查完成，不能宣称视觉或导出文件已验收。没有工具能保证模型完美；一般网格诊断不能证明制造可用、强度、动画拓扑或全部自相交正确。

有捕获到的删除记录时用 `model_deleted` 核对去留。任意 Python 内部删除目前不会自动产生完整快照，脚本仍需保留恢复点和清理清单；空账本不能证明没有删除。原生 `execute_python` 先保守记为几何改动，下一轮模型步进会用真实几何版本复核；纯查询或材质脚本若没有改变几何，会恢复旧的几何检查状态。可识别的 Python 直接导出会被要求改用 `export_file`；间接导出仍需按交付流程验证。

碰撞检测先筛选三角形包围盒，再检查实际三角形相交；仅包围盒重叠不作为表面相交依据。每对最多保存 4000 个三角对样本，但样本存满后仍继续遍历。单对默认工作预算 1000000，场景总预算 5000000；可通过 `triangle_pair_work_budget`（最高 5000000）和 `triangle_work_budget`（最高 20000000）增加检测计算量。真正超出预算时报告具体对象对并保留“覆盖不完整”，不会要求靠减面、删细节或合并零件过关；同一限制持续存在时说明工具边界，停止无效重试。

可编辑 `.blend` 与可移植 GLB 分别验收。glTF 支持的基础色、金属度和粗糙度常量不依赖 UV；任意程序化节点要兼容重建或在适用时烘焙。Backfacing 等视角相关效果不能假定通过普通烘焙保留。要求可用 GLB 时，导出后重开实际文件并检查材质及正反面效果，报告实际验证范围。

## 支持的建模源

几何检查在 Host 侧的 Node 中处理。可读取的三角网格来源包括：

| 源 | 怎么接 | 说明 |
|---|---|---|
| **Blender（live）** | 让 Blender 开着，走 MCP | 唯一功能完整的源：建模 + 检查 + 出图。需要配套的 blender-mcp bundle |
| **网页建模（WS）** | `url: 'ws://127.0.0.1:port'` | 页面里跑一个 WebSocket 服务，实现 `ping` / `extract` 两个 op |
| **网页建模（CDP）** | `cdp_port: 9222` | 页面不用改；用 `--remote-debugging-port` 打开 Chrome/Edge，插件注入 `runtime/browser-agent.js` 后遍历 THREE / Babylon 场景 |
| **.obj** | `obj: '路径.obj'` | 只读源，不需要 Blender 或浏览器 |

> 磁盘 `.blend` 读取模式（`source: 'blender'`）**已下线**：它依赖的 `runtime/blender_bridge.py` 从未随包发布，留着只会 spawn 一个参数指向不存在文件的 Blender 进程并卡到超时。`blend` 配置项仍保留，但只用于「启动 Blender 时打开哪个文件」，不再作为读取源。要检查磁盘模型请导出 `.obj`（只读），或让 Blender 开着走 live。

网页源支持 WebSocket 桥接和 Chrome/Edge CDP。`runtime/browser-agent.js` 是参考实现，可集成到 Three.js 页面，也支持 Babylon 和自定义 `window.__PTC_MESHES__`。

几何来源通用不代表所有来源都有相同的截图与编辑能力。OBJ/网页推断组不要求创建 Blender Collection，也不冒充真实 Collection；`model_review` 当前主要通过 live Blender 获取完整组视图，其他来源缺图时如实报告。

## 安装

```bash
# 在 DSH 里
plugin_manager({ action: 'install_bundle', target: '<本目录的绝对路径>' })
```

安装后「场景建模模式」会出现在新建会话的模式列表里（`preset-modeling` 行）。已存在的会话保持它启动时的模式，需要新建会话才能选到。

## 结构

```
package.json          bundle 清单（dsh.bundle.patch 指向下面的 patch）
cordis.patch.yml      声明 preset-modeling 这一行，以及它挂载的插件清单
lib/index.js          Host 插件入口：注册工具 + 注入提示段与运行时状态
lib/tools.mjs         11 个工具的定义与结果渲染
lib/core/geometry.mjs 引擎无关几何核心：BVH、穿透深度、接触距离和视图数据
lib/core/workflow.mjs 常驻决策流程与硬表面质量要求
lib/core/detail.mjs   按当前状态给出自主细化的下一步
lib/adapters/         live.mjs / web.mjs / obj.mjs / index.mjs（门面）
runtime/              browser-agent.js（网页侧注入脚本）
scripts/research.mjs  结构参考联网检索脚本（运行时使用）
```

## 配置

插件配置位于 `cordis.patch.yml` 的 `ptc-model-check` 条目。常用设置包括建模源、文件或网页地址、Blender 可执行文件、几何预算，以及是否注入建模流程上下文。可在该条目中设置：

```yaml
- id: ptc-model-check
  name: '@local/ptc-model-check'
  config:
    source: auto          # auto / live / web / file（blender 读取模式已下线）
    blend: ''             # 启动 Blender 时打开哪个 .blend（不是读取源）
    obj: ''               # .obj 路径（只读源）
    url: ''               # 网页桥 ws://host:port
    cdpPort: 0            # Chrome 调试端口
    targetMatch: ''       # CDP 页面 URL 匹配片段
    blenderPath: ''       # 留空自动探测
    minDepth: 0.0005
    minRatio: 0.005
    maxObjects: 3000
    maxTriangles: 2000000
    mcpUrl: 'http://127.0.0.1:8765/mcp'
    mcpPort: 8765
    blenderPort: 9876
    autoBootBlender: true
    injectContext: true   # 是否注入场景建模模式说明与运行时状态
    autoCheckBatch: 6     # 累计多少次建模工具调用后自动快速检查；0 表示关闭
    viewCheck: true       # 看图即检测：look / render_preview 结果追加穿模 + 孤立摘要
    viewCheckItems: 6     # 摘要里最多列几条穿模/孤立命中
    viewCheckTimeoutMs: 120000  # 检测超时上限；超时只附一行说明，不影响看图本身
```

## 看图即检测

「孤立」和「穿模」两项检测绑在看图动作上：`look` / `render_preview` 的返回结果里会自动追加一段摘要（`lib/tools.mjs` 的 `buildViewCheckReport`，与 `model_isolation` 同源、同阈值）：

- 头部一行：mesh 数、穿模对数（组内穿出 / 组间）、孤立件数；
- 逐条命中：`interferenceLine` 与 `isolationLine` 的原文，最多 `viewCheckItems` 条；
- 层次前几行：全局组间与逐组内部的连接簇结论；
- 检测不完整或超时都明确写出，不把「没检测到」当成「没问题」。

实现位置在 `lib/index.js` 的 `tools/post-execute`。宿主 0.2.1-rc.3 的契约要求：accept 决策只能替换 `content`、不能同时替换 `value`；监听器抛错会把整次调用变成 `isError`。所以这里全程 try/catch 加超时兜底——最坏情况只是少一段检测，绝不会让看图失败。它仍不是完整检查：没有五视图，也没有逐组完整报告，签收以 `model_loop` 为准。

## 自测

```bash
# 43 项离线回归，不连接 Blender、不创建真实子代理
npm test
```

离线回归覆盖实际宿主上下文注入、脚本编辑与导出状态、局部签收、自查/独立复核、多组待办、两层几何检查、场景意图、真实材质渲染请求、源选择、调研、无损 JSON、看图即检测和环境安装引导，共 43 项。`tests/run_offline.mjs` 显式列出这些脚本，避免运行会重建活动场景的现场测试。配套 MCP 可在其目录执行 `npm test` 验证脚本通道及 52→12 工具筛选，`python tests/verify_render_cleanup.py` 验证预览环境恢复。

真实 Blender、DSH 加载与导出文件仍需更新后另做实机验证。

## 发布（两个仓库成对）

| 仓库 | 内容 | Release zip |
|---|---|---|
| <https://github.com/panda472328/dsh-ptc-model-check> | 本包：preset、11 个工具、检查引擎 | `ptc-model-check-<ver>.zip` |
| <https://github.com/panda472328/dsh-blender-mcp> | MCP 服务器（Node）、addon、DSH 注册 patch | `blender-mcp-<ver>.zip` |

**两个必须都发**：只发本包，用户装完仍然没有 `mcp__blender__*`（就是建模测试 27/28 的故障）。文档与插件状态文本里的下载地址写死了 `panda472328/<仓库名>/releases`，改名或换 owner 要同步 `docs/install-blender-mcp.md` §2 和 `lib/index.js` 的强制提示。

发版流程（以本包为例；本机没装 `gh`，用网页上传附件）：

```bash
npm test                                   # 43 项全绿才发
git tag v2.29.0 && git push origin v2.29.0
git archive --format=zip -o ptc-model-check-2.29.0.zip HEAD
```

然后打开 `https://github.com/panda472328/dsh-ptc-model-check/releases/new?tag=v2.29.0`，上传 zip 作附件。装了 `gh` 的话等价一条：

```bash
gh release create v2.29.0 ptc-model-check-2.29.0.zip --title "v2.29.0" --notes-file CHANGELOG.md
```

配套包同理，附件名 `blender-mcp-1.2.3.zip`。

附件名要和文档 §2.1 的下载 URL 对得上（文档用 `releases/latest/download/blender-mcp-1.2.3.zip` 这类直链，升版时记得同步）。

## 实现要点

- `lib/core/geometry.mjs` — 引擎无关：BVH、三角形对、最近点、穿透深度、孤立距离、形状分类与必看视角。
- `lib/adapters/` — `live.mjs`（经 MCP 读写活场景）、`web.mjs`（WS / CDP）、`obj.mjs`（只读）。
- `lib/core/framing.mjs` — 场景级取景：排掉远处环境物，避免主体被压成亚像素。
- `lib/tools.mjs` — 工具定义与结果渲染。
- `lib/index.js` — Host 插件入口：注册工具、注入提示段与运行时上下文。

两个已知的坑已经处理：

1. **渲染引擎不能按 `enum_items` 过滤**。headless 状态下 `bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items` 只列出当前可用的一个，照它过滤会把 workbench 悄悄换成 eevee，而没有灯光/世界的场景里 eevee 渲出来是全黑的。现在改为「赋值 + 回读」，并在 eevee/cycles 下自动补世界和三向太阳光。
2. **孤立距离采样**。只取顶点会系统性高估间距（顶点到面的距离大于面到面），立方体场景下能差 2.6 个单位。现在顶点与三角形重心一起采样。
