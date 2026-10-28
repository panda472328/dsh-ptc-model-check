# 环境安装：Blender 与 Blender MCP

> **这份文档只在环境缺失时读。**
> 插件每个会话会先自己检测，环境齐全时状态会直接写「已就绪」，**不必读本文件**。
> 缺任意一项 → 状态会明确要求你先读完本文件再动手。

本文件写给 AI 读者，不是人类手册。每一步都给出可执行的判定方式，不要凭印象判断「应该装好了」。

## 四个依赖，缺一个都不算通

| # | 依赖 | 是谁 | 缺了会怎样 |
|---|---|---|---|
| ① | **Blender** 4.2+ | 本机程序 | 插件报 `缺少 Blender` |
| ② | **addon** `blender_mcp.py` | Blender 里的插件 | Blender 能开，但 9876 不监听 |
| ③ | **blender-mcp bundle** | 装进 DSH profile 的包 | **最隐蔽**：服务器照样能起、探测全绿、状态显示「已就绪」，但建模工具列表里一个 `mcp__blender__*` 都没有 |
| ④ | **MCP 服务器进程** | `node src/server.mjs` | 8765 离线，插件报 `MCP 服务器离线` |

③ 必须单独强调：它不是「装个服务器」，而是**把服务器注册进 DSH**。bundle 自带 `cordis.patch.yml`，那行配置才是 `mcp__blender__*` 工具出现的原因。只把源码放在某个目录里、或者手动 `Start-Process` 起服务器，**都不会让工具出现**。

真实教训（建模测试 27 / 28）：两次都只有 ①②④，缺 ③。27 里模型自己写了个 `bl.ps1` 用 HTTP 直连服务器，勉强把检查跑通了；28 里模型看到工具列表没有 `mcp__blender__*`，改用自己开无头 `blender -b` 跑脚本，结果插件的几何检查和看图检测全程看不见那个场景，**整个建模过程一次检查都没做**。所以 ③ 不是可绕过的形式要求。

---

## 0. 先搞清楚缺的是哪一项

按状态文本里的结论分头处理：

| 状态文本 | 缺什么 | 跳到 |
|---|---|---|
| `缺少 Blender（本机没找到可用的 blender.exe）` | ① | §1 → §3 |
| `MCP 服务器可达，但没接进 DSH：mcp__blender__* 工具不存在` | **③** | **§2** |
| `本机没有 Blender MCP 服务器（缺 server.mjs 与 bundle 注册）` | ③ ④ | §2 → §4 |
| `MCP 服务器离线，且自动启动已关闭` | ④ | §4 |
| `Blender 已装，但 addon 没在监听端口` | ② 或 ④ | §3 → §4 |
| `插件检查端点与 DSH 原生建模端点不一致` | 配置 | §4.3 |
| `MCP 服务器在线，但 DSH 的 MCP 客户端已断连` | 不是缺件，是**连接断了** | **完全退出 DSH 再启动**（重装无效） |
| `已就绪` | 都不缺 | 关掉本文档，开始建模 |

判定永远以**实际探测结果**为准，不要因为「用户说装过了」就跳过验证。特别注意：**探测到 8765 在线不代表 ③ 已经装好**——必须按 §5 第 ⑦ 项确认工具真的存在。

---

## 1. 安装 Blender

要求：**Blender 4.2 或更高**（addon 依赖 4.2+ 的扩展接口）。推荐 4.5 LTS。

### 1.1 Windows

1. 打开 <https://www.blender.org/download/>，下载 Windows 安装包（`.msi`）。
2. 用 PowerShell 静默安装到默认目录：

   ```powershell
   $msi = Join-Path $env:TEMP 'blender-setup.msi'
   Invoke-WebRequest -Uri 'https://mirrors.aliyun.com/blender/release/Blender4.5/blender-4.5.3-windows-x64.msi' -OutFile $msi
   Start-Process msiexec.exe -Wait -ArgumentList '/i', $msi, '/qn'
   ```

   网络访问外网受限时，让用户手动下载安装包再把路径告诉你，用同样的 `msiexec /i <path> /qn` 安装。

3. 装完确认可执行文件存在（版本号可能不同，用通配符找）：

   ```powershell
   Get-ChildItem 'C:\Program Files\Blender Foundation' -Directory |
     ForEach-Object { Get-ChildItem $_.FullName -Filter blender.exe -Recurse -Depth 2 }
   ```

   预期输出类似 `C:\Program Files\Blender Foundation\Blender 4.5\blender.exe`。

4. 如果装在非默认位置，把这个路径告诉用户，让他们在插件配置里填 `blenderPath`，或者设置环境变量 `BLENDER_EXE`。插件按以下顺序找：配置项 → `PTC_BLENDER` → `BLENDER_EXE` → 默认安装目录。

### 1.2 macOS / Linux

```bash
# macOS
brew install --cask blender
ls /Applications/Blender.app/Contents/MacOS/Blender

# Linux（Ubuntu/Debian 系，官方 apt 源）
sudo apt update && sudo apt install -y blender
which blender
```

非 apt 发行版用官方 tar 包解到 `/opt/blender`，并把 `blender` 软链到 `/usr/local/bin`。

### 1.3 安装后自检

```powershell
& 'C:\Program Files\Blender Foundation\Blender 4.5\blender.exe' --version
```

必须打印出版本号（如 `Blender 4.5.3`）。打不开或报缺 DLL → 安装包损坏，重装。

---

## 2. 安装 blender-mcp bundle（第③层，最容易漏）

**这一步决定 `mcp__blender__*` 工具是否存在。** bundle 里带的 `cordis.patch.yml` 会把服务器注册成 DSH 工具：

```yaml
- insert:
    - id: mcp-blender
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: blender
        transport: streamable-http
        url: http://127.0.0.1:8765/mcp
```

没有这个注册，服务器起一百次也没用——探测依然全绿，工具依然不存在（见 §0 的 27/28 教训）。

### 2.1 下载

| 包 | Release 地址 |
|---|---|
| 建模插件（本包） | <https://github.com/panda472328/dsh-ptc-model-check/releases> |
| MCP 配套包 | <https://github.com/panda472328/dsh-blender-mcp/releases> |

取各自的 `blender-mcp-<版本>.zip` 与 `ptc-model-check-<版本>.zip`（latest）。国内网络拉 GitHub 慢时可用镜像前缀（如 `https://ghproxy.net/` + 原地址），但**装完必须按 §5 核对版本号**。

### 2.2 安装方式（按顺序尝试，A 最省事）

**方式 A（推荐）：一行 CLI 命令。** DSH 自带命令行，内含 pnpm，**不需要系统装 pnpm**：

```powershell
# 1) 解压
Expand-Archive -Path "$env:TEMP\blender-mcp.zip" -DestinationPath "$env:TEMP\blender-mcp" -Force
# 2) 装进 profile（自动写 dependencies 与 dsh.profile.bundles）
& "<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile <profile名> add file:"$env:TEMP\blender-mcp\blender-mcp-1.2.4"
```

`<DSH 安装目录>` = `DeepSeek Harness.exe` 所在目录（例如 `D:\dsh`）；`<profile名>` = `DSH_PROFILE_DIR` 的最后一段（`D:\DSHData\profiles\desktop` → `desktop`）。

实测（全新 profile）：这条命令会把包加进 `dependencies`，**并自动登记到 `dsh.profile.bundles`** —— 后者是手工方式最容易漏的一步，漏了等于没装。

**方式 B：图形界面。** 设置 → 插件管理 → 安装插件 → 选解包目录，等价于 A。注意：**建模模式里 `plugin_manager` 工具是 disabled 的**，所以要让 AI 自己装，只能走 A 的 CLI —— 运行时状态会直接把这条命令连同 profile 名一起给它。

**方式 C：手工写 profile**（前两者都不可用时）。profile 目录 = 环境变量 `DSH_PROFILE_DIR`。解压到该目录的 `pkgs\blender-mcp`，然后编辑 `package.json`：

```json
"dependencies": { "@local/blender-mcp": "link:./pkgs/blender-mcp" },
"dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@local/blender-mcp"
] } }
```

再在 profile 目录执行：

```powershell
& "<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile <profile名> install
```

它同样调用 DSH 自带的 pnpm —— **不要依赖系统的 `pnpm` 命令，普通机器上没有**（实测干净环境 `Get-Command pnpm` 直接报缺失，照文档写 `pnpm install` 会失败）。

**方式 D：开发者 link**（源码已在本机，如 `git clone` 场景）：dependencies 写 `"@local/blender-mcp": "link:D:/绝对路径/blender-mcp"`，其余同 C。

### 2.2.1 服务器会随 DSH 自动启动

装好本包之后，`@local/ptc-model-check` 带一个 profile 级监督插件（`ptc-blender-supervisor`）：
**DSH 启动时**如果发现 8765 没在监听，会自动拉起 `server.mjs` 并等端口就绪，再让 MCP 客户端去连。
这样就不必手动开 `start-server.bat`，也避免「客户端先连、服务器后到」导致的长期断连。

排查问题时看日志里有 `[ptc-supervisor]` 前缀的那几行。

### 2.3 重启

**改完必须完全退出 DSH 再启动**（不是刷新页面）——bundle 列表只在启动时读取。

### 2.4 验证注册生效

```powershell
# bundle 进了 profile 依赖
Get-Content "$env:DSH_PROFILE_DIR\package.json" | Select-String 'blender-mcp'
# 文件真的就位
Test-Path "$env:DSH_PROFILE_DIR\node_modules\@local\blender-mcp\cordis.patch.yml"
```

最终判据只能是在**建模会话里调用 `mcp__blender__get_scene_info`** 成功（§5 第 ⑦ 项）。前两条全过不代表注册成功——重载没做的话照样找不到工具。

---

## 3. 安装 Blender MCP addon

插件依赖的 addon 提供 `look`、`render_preview`、`execute_python`、`get_scene_info` 等工具。**没装 addon 时 Blender 能开，但端口 9876 不会监听**，插件会报「Blender 在运行，但 addon 没启动」。

### 3.1 找到 addon 文件

addon 是**一个 `.py` 文件**：`addon/blender_mcp.py`。它随配套的 `blender-mcp` 包分发，装进 DSH 后位于 profile 的 `node_modules/@local/blender-mcp/addon/blender_mcp.py`。

⚠️ **不要从网上随便找一个「blender mcp」项目装。** 本项目配套的是 addon 名 `blender_mcp`、版本 **1.2.3** 的本地实现（单文件，约 3400 行），工具名就是 `look` / `render_preview` / `execute_python` 这一套。上游公开项目的结构（zip 扩展、`addon.py`、不同工具名）与本插件不兼容，装错的表现是工具名对不上、检查功能全失效。

按顺序找，找到就停：

```powershell
# ① bundle 已装进 DSH profile（§2 装完就有；DSH_PROFILE_DIR 见 §2.2）
$p = "$env:DSH_PROFILE_DIR\node_modules\@local\blender-mcp\addon\blender_mcp.py"
Test-Path $p

# ② 本地开发目录
Get-ChildItem "$env:USERPROFILE\*blender-mcp\addon\blender_mcp.py" -ErrorAction SilentlyContinue

# ③ 兜底：限定深度找
Get-ChildItem 'D:\','C:\' -Recurse -Depth 4 -Filter blender_mcp.py -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match '\\addon\\' } | Select-Object -First 5 FullName
```

**找不到就按 §2 装 bundle**（addon 就在包里）。没有网络时让用户从 <https://github.com/panda472328/dsh-blender-mcp> 的 Release 下载 zip；不要用网上同名项目替代，也不要自己写一个凑合。

拿到后先核对版本，避免装旧版：

```powershell
Select-String -Path $p -Pattern "'version':" | Select-Object -First 1
# 期望 (1, 2, 3) 或更新
```

### 3.2 安装到 Blender

**方式 A（推荐，命令行可完成）**：拷进 Blender 的 addons 目录。

```powershell
$dst = "$env:APPDATA\Blender Foundation\Blender\4.5\scripts\addons"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item $p "$dst\blender_mcp.py" -Force
Test-Path "$dst\blender_mcp.py"
```

`4.5` 换成实际版本号（`& blender --version` 的前两位）。放的是**单文件**，不是目录；文件名必须正好叫 `blender_mcp.py`——addon 模块名由文件名决定，改名后 `addon_utils.enable('blender_mcp')` 就找不到。

**方式 B（图形界面）**：Blender → `Edit → Preferences → Add-ons` → 右上 `Install…` → 选 `blender_mcp.py` → 勾选 `Blender MCP`。

### 3.3 启用 addon

命令行启用（不需要点界面）：

```powershell
& 'C:\Program Files\Blender Foundation\Blender 4.5\blender.exe' --background --python-expr "import addon_utils,bpy; addon_utils.enable('blender_mcp', default_set=True, persistent=True); bpy.ops.wm.save_userpref(); print('ADDON_OK')"
```

输出 `ADDON_OK` 即成功。常见报错：

- `No module named 'blender_mcp'` → §3.2 的目标目录不对，确认文件真在 `scripts\addons\blender_mcp.py`
- 启用成功但 N 面板没有「Blender MCP」标签 → 重启 Blender 再看；仍没有说明文件被改名或损坏

图形界面路径：`Edit → Preferences → Add-ons` → 搜 `Blender MCP` → 勾选。

---

## 4. 启动 MCP 服务器（第④层）

这里有两层，别混：

- **addon 的 socket**：Blender 进程内，监听 `9876`（默认）。它让插件能操作场景。
- **MCP 服务器**：独立进程，监听 `8765`（默认），把 MCP 协议转成上面那个 socket。插件通过 `http://127.0.0.1:8765/mcp` 访问它。

两者都要在。插件能自己拉起它们（`autoBootBlender: true`，默认开），所以多数情况下你只需调用一次 `blender_ready` 让它自动完成。

### 4.1 让插件自动拉起

```
blender_ready({})
```

然后读返回里的 `steps`，正常应是：

```
MCP 服务器在线（12 个工具） / Blender addon 在线（端口 9876）
```

### 4.2 手动启动（自动拉起失败时）

**启动 addon socket**：Blender 里在 3D 视口按 `N` → 打开「Blender MCP」标签 → 点 `Start MCP Server`。

**启动 MCP 服务器**：配套包的根目录下有 `start-server.bat`（内部跑 `node src/server.mjs`）：

```powershell
# 配套包目录下双击或执行；窗口要一直开着
.\start-server.bat

# 等价于（可加参数改端口）
node src\server.mjs --port 8765 --blender-port 9876
```

注意这是 **Node 实现**（`src/server.mjs`），不是 Python 包。所以本机需要 Node.js ≥ 18，且 `start-server.bat` 会先检查 `node` 是否在 PATH 里。

### 4.3 端口与端点核对

插件默认 `mcpUrl = http://127.0.0.1:8765/mcp`。若服务器实际监听别的端口，必须同时改配置里的 `mcpUrl` 和 `mcpPort`，两者不一致会报 `mcp-endpoint-unavailable`。

验证端点真的是 MCP（而不是随便一个 HTTP 服务）：

```powershell
$body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
(Invoke-WebRequest -Method Post -Uri 'http://127.0.0.1:8765/mcp' -ContentType 'application/json' -Body $body).Content
```

# ⑦ 最关键：DSH 里真的有这些工具
# 在建模会话里调用 mcp__blender__get_scene_info，返回场景对象列表才算通过。
# 只有前六项过、第 ⑦ 项报 tool not found → 缺的是 §2 的 bundle 注册。

返回里 `result.tools` 是数组且长度 > 0 才算通过。

---

## 5. 验收清单

逐条实测，全部通过才算装好。**不要跳过其中任何一条，也不要凭「应该有」下结论。**

```powershell
# ① blender.exe 存在
Get-ChildItem 'C:\Program Files\Blender Foundation' -Recurse -Filter blender.exe -Depth 3

# ② addon 文件就位（单文件，不是目录）
Test-Path "$env:APPDATA\Blender Foundation\Blender\4.5\scripts\addons\blender_mcp.py"

# ③ addon 已启用（在偏好里查得到）
& 'C:\Program Files\Blender Foundation\Blender 4.5\blender.exe' --background --python-expr "import addon_utils; print([m.__name__ for m in addon_utils.modules() if 'blender_mcp' in m.__name__])"

# ④ addon socket 在监听（需 Blender 已开且 addon 已启动）
(Test-NetConnection -ComputerName 127.0.0.1 -Port 9876 -InformationLevel Quiet)

# ⑤ MCP 服务器在监听
(Test-NetConnection -ComputerName 127.0.0.1 -Port 8765 -InformationLevel Quiet)

# ⑥ MCP 端点返回工具列表
$body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
(Invoke-WebRequest -Method Post -Uri 'http://127.0.0.1:8765/mcp' -ContentType 'application/json' -Body $body).Content

# ⑦ bundle 已注册进 profile（第③层）
Get-Content "$env:DSH_PROFILE_DIR\package.json" | Select-String 'blender-mcp'
Test-Path "$env:DSH_PROFILE_DIR\node_modules\@local\blender-mcp\cordis.patch.yml"
```

**①～⑦ 全绿之后，还必须在建模会话里真的调用一次 `mcp__blender__get_scene_info`。** 这是唯一能证明「工具存在」的判据——⑥ 只证明服务器活着，⑦ 只证明文件装了，两者都不证明 DSH 把连接建起来了。调不通就是缺 ⑦ 之后的**完全重启**（bundle 只在启动时读取，刷新页面没用）。

最省事的一条：调 `blender_ready({})`，返回 `ok: true` **且本会话工具列表里有 `mcp__blender__*`** 才算全部就绪。只要「已就绪」却调不到原生工具，就是 §2 没做。

---

## 6. 常见失败与处置

| 现象 | 原因 | 处置 |
|---|---|---|
| `找不到 blender.exe` | 未安装或装在非默认路径 | §1；非默认路径设 `blenderPath` / `BLENDER_EXE` |
| **状态「已就绪」但 `mcp__blender__*` 调不到（tool not found）** | **第③层缺失：bundle 没装或装了没重启** | §2 装 bundle → §2.3 完全退出 DSH 重启 → 再调 `get_scene_info` |
| 插件报「找不到启动脚本」 | 第④层的 server.mjs 不在插件能发现的位置 | §2 装 bundle（脚本随包就位），或配置 `mcpServerScript` |
| `Blender 在运行，但 addon 没启动` | addon 没启用或 socket 没开 | §3.3 启用 → §4.2 点 Start MCP Server |
| `MCP 服务器离线，且找不到启动脚本` | 服务器进程没跑 | §4.2 跑 `start-server.bat`（需 Node ≥ 18），或配置 `mcpServerScript` 指向它 |
| `MCP 服务器端口起来了，但指定端点不可用` | `mcpUrl` 与端口不一致 | §4.3 同时改 `mcpUrl` 和 `mcpPort` |
| `重启后 addon 仍没监听` | addon 被禁用或装错位置 | 确认文件在 `scripts\addons\blender_mcp.py`，重启 Blender（§3.2） |
| 工具名对不上（找不到 `look` / `render_preview`） | 装成了别家的 blender mcp addon | 卸载它，换回本项目配套的 1.2.3（§3.1），不要混用 |
| Blender 崩过、重开后没带 addon 启动参数 | 进程被外部重启 | 请求重启时传 `restart_blender: true`（会丢失未保存改动，先让用户确认） |

**不要做的事**：

- 不要为了绕过环境检查去改插件的检测逻辑、把 `autoBootBlender` 关掉再声称就绪，或者用 `execute_python` 拼一个假场景骗过检查。
- **不要自己开无头 Blender（`blender -b`）跑脚本硬做**——那是建模测试 28 走错的路：插件的 live 源连的是 9876 上的 GUI 实例，无头实例里的场景它完全看不见，于是几何检查、看图检测、五视图、签收门禁**全部失效，交付时等于一次检查都没做过**。环境缺 ③ 就装 ③，别换赛道。
- 不要自己 `Start-Process` 起一个 server.mjs 然后手写 JSON-RPC 调它（27 的临时自救）。那样插件会探测到「服务器在线」而显示就绪，但工具仍不存在，问题只会更难查。

---

## 7. 装好之后

回到建模会话，先调 `blender_ready({})` 确认 `ok: true`，再调 `mcp__blender__get_scene_info` 确认工具真的能返回场景对象。两条都通过才开始建模 → 用 `model_loop` 做几何检查与五视图验收。

**自检清单里任何一项「看起来过了但工具调不通」，都按 §2 处理**（bundle 没装或没完全重启），不要改检测逻辑、不要另开无头实例绕过去。

本文件不再需要。
