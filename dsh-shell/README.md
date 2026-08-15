# dsh-shell — DeepSeek Harness 桌面启动体系（源码仓库）

三平台桌面壳（Windows / macOS / Linux），v0.12.0。与 DSH 更新完全解耦：壳只负责
"拉起 `dsh web` 服务 + 提供原生窗口/托盘"，不 import 任何 DSH 包、不读 DSH 内部文件。
v0.12.0 起支持双更新通道：托盘可检查 dsh 新版本并一键更新（bundled 运行时落 userData 副本），
Deck 自身新版本可一键下载安装包。

## 壳形态（现状）

| | 状态 |
|---|---|
| `app/`（Electron 壳） | **当前唯一入口**（v0.11.0，三平台 + 捆绑运行时版）：窗口 + 托盘 + 服务控制 |
| `statusbar/`（Swift 菜单栏工具） | **已退役**（2026-08-15，macOS-only），源码保留于本机工作文件夹、未随仓库发布（bootout 启停、状态+版本显示） |
| Chrome PWA | 已退役（2026-08-15） |

## 架构（服务生命周期按平台分支）

- **macOS：launchd 托管（TCC 红线：服务必须由 launchd 生成）**

```
~/.local/bin/dsh-web-launcher.sh (v2.1)
  ├→ launchctl bootstrap + kickstart ai.dsh.web   ← launchd 托管服务
  │    责任进程 = node 二进制 → iCloud vault (TCC) 授权按路径命中
  ├→ open ~/Applications/DeepSeek Harness.app     ← Electron 壳（唯一一次 open，无二次打开）
  └→ curl 轮询 3080 就绪（上限 60s，仅确认不重复 open）
```

  - `~/Library/LaunchAgents/ai.dsh.web.plist`：`RunAtLoad=false`（按需启动）、
    `KeepAlive={SuccessfulExit:false}`（崩溃自动重启，正常退出不重启）
  - 停止 = `launchctl bootout`（卸载 job → KeepAlive 不触发），启动 = `bootstrap` + `kickstart`
  - 日志: `~/.dsh/logs/web.{stdout,stderr}.log`

- **Windows / Linux：壳直接 spawn `dsh web` 子进程**
  - dsh 来源三级查找（`resolveDsh()`）：`DSH_BIN` 覆盖 → PATH 系统版（兼容老用户）→
    安装包捆绑运行时（`resources/node-bin` 官方 Node 22 二进制 + 预装的 @deepseek-ai/dsh，
    bin 入口 `lib/bin.js`，spawn node + CLI 不经 shell）。
    v0.12.0 起捆绑运行时拆两级：首启把 `resources/dsh-runtime` 迁到 `userData/dsh-runtime`
    （包内 Resources 只读不可写），bundled 分支 userData 副本优先、resources 兜底，
    dshSource 记为 `bundled-userdata`/`bundled-resources`；node 二进制仍只用 resources 的
  - 壳启动时自动拉起服务，随壳退出自动终止（整棵进程树清理，不留孤儿）：
    Windows 用 `taskkill /pid /T /F`（spawnSync 同步执行），Linux 用负 pid 进程组 SIGTERM
  - 服务 stdout/stderr 追加写入 `userData/logs/dsh-web.log`，排障先看它（托盘有「打开日志目录」）
  - 找不到 dsh（未装系统版且捆绑缺失）→ error.html 引导"安装 Node.js 与 dsh 或检查安装包完整性"
  - `DSH_BIN` 环境变量可覆盖 dsh 可执行文件路径（Windows 上可指向 `dsh.cmd` 全路径）

- **Electron 壳** (`app/`)：窗口状态记忆（含屏幕边界校验）、托盘（启停/状态/浏览器/退出）、
  origin 精确导航守卫、IPC sender 校验、权限白名单、崩溃自动重连（耗尽后 error.html 兜底）、
  冷启动加载页（loading.html）

## 构建与部署

```bash
cd app && npm install    # 手动装依赖（npm 安全策略需 approve electron 的 install 脚本）
npm start                # 开发模式运行（无需捆绑运行时，系统已装 dsh 即可）
# 打包前需先准备捆绑运行时（否则 electron-builder 因 extraResources 缺失报错）：
# 下载 Node 22 官方二进制到 resources/node-bin，用其自带 npm 装 dsh 到 resources/dsh-runtime
# ——完整命令见 .github/workflows/release.yml 的「准备捆绑运行时」步骤（本地 registry 可走 npmmirror）
npm run dist:mac         # macOS：dmg + zip（--arm64 / --x64 指定架构）
npm run dist:win         # Windows：nsis 安装包
npm run dist:linux       # Linux：AppImage + deb
```

仓库带 GitHub Actions（`.github/workflows/release.yml`）：推送 `v*` 标签即三平台矩阵构建
（mac 拆 arm64/x64 两个产物；electron-builder 前自动下载 Node v22.20.0 + 预装 dsh 捆绑进包）
并自动发布 Release。

## 已知坑（来自长期记忆，详见 Obsidian `Agent/环境/dsh-shell 桌面壳.md`）

- TCC 红线（macOS）：服务必须由 launchd 生成，壳只发 launchctl 命令
- KeepAlive 与手动停止兼容：停止必须 bootout（kill 会被拉起）
- npm 安全策略拦 install-scripts → `npm install-scripts approve electron`（写入 package.json 的 allowScripts 字段——该字段非 npm 标准字段，是 install-scripts 审批工具的私有配置，勿当成 electron-builder 配置误改）
- Windows 的 dsh 是 `dsh.cmd`（cmd shim）：必须 `shell:true` 经 cmd.exe 启动；`shell:true` 下
  参数只拼接不转义，`DSH_BIN` 含 `"` 可逃逸（本地用户自控 env，接受现状）；Node 对此打
  DEP0190 警告，属预期行为
- 国内网络：Electron 二进制下载用 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`
- install.js 假成功（exit 0 但 dist 不完整）→ 手动解压 `~/Library/Caches/electron/` 缓存 zip
- 像素验证一律用 ffmpeg（自写 PNG 解码器不可靠）
- plist 变更需下次 `bootout`+`bootstrap` 才生效

## 历史

- 2026-08-15（v0.12.0）：双更新通道——①dsh 更新检测（npmmirror registry，8s 超时）+
  bundled 一键更新：捆绑运行时首启迁 `userData/dsh-runtime`（resolveDsh bundled 拆
  `bundled-userdata`/`bundled-resources` 两级），用捆绑 node 跑 npm CLI（包内未捆绑 npm，
  运行时从 npmmirror 下载 npm 10.9.4 解到 userData 缓存）执行
  `install --prefix userData/dsh-runtime @deepseek-ai/dsh@latest`，完成后 `--version` 校验，
  不自动重启服务；env/system 分支只给升级命令 + 复制。②Deck 更新引导增强：弹窗新增
  「下载并安装」→ 按平台拼资产 URL（tag 原文走 `/download/<tag>/`，文件名段不带 v 前缀，
  已对照实际 Release 资产核实）用 `session.downloadURL` 下载到下载目录，失败保留
  Releases 备用路径。托盘菜单「检查更新…」改名「检查 Deck 更新…」并新增「检查 dsh 更新…」
  （详见 `reviews/改造说明-v0.12.0.md`）
- 2026-08-15（v0.11.0）：P0 免安装——安装包捆绑 Node v22.20.0 官方二进制 + 预装
  @deepseek-ai/dsh（CI 在 electron-builder 前下载/安装，`extraResources` 整体进包）；
  win/linux spawn 改为三级查找（DSH_BIN → PATH 系统版 → 捆绑运行时，捆绑分支 spawn
  node + `lib/bin.js` 不经 shell）。P1 体验增强：托盘开机自启开关（mac/win）、检查更新
  （releases.atom + 8s 超时）、托盘顶部版本/服务状态只读项、打开日志目录、
  loading/error 页跟随系统深浅色（详见 `reviews/改造说明-v0.11.0.md`）
- 2026-08-15（v0.10.0）：三平台化改造——Windows/Linux 走壳内 spawn `dsh web` 子进程方案，
  macOS 行为与 v0.1.1 完全一致；新增 win/linux 打包配置、error.html 安装引导、
  GitHub Actions 三平台 Release；dsh 审查（P0=0）后修复 P1×2 + P2×6
  （Windows spawn-failed 检测、taskkill 同步化、lsof 回退 fetch 等，详见 `reviews/修复说明.md`）
- 2026-08-15（v0.1.1）：launcher 就绪轮询替代 `sleep 3`、去二次 open；plist 崩溃自动重启；
  菜单栏 Swift 工具退役；Electron 壳替代 Chrome PWA；K3 审查（P0=0）加固：窗口边界校验、
  origin 导航守卫、IPC 校验、权限白名单、加载页、重试兜底、防重入
