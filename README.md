# DeepSeek Deck

**DeepSeek Harness 的独立桌面应用**（Windows / macOS / Linux）。

DeepSeek Harness 是 DeepSeek 官方的 AI 智能体工作台：写代码、查资料、建知识库、编排多步骤任务，跑在你自己电脑上的完整 AI 工作环境。官方形态是一个本地网页服务，平时要在浏览器里打开使用。

**DeepSeek Deck 把 Harness 从浏览器里请了出来**——基于 DeepSeek Harness 开发，给它配上了独立的桌面窗口、常驻托盘和服务管理，双击图标就能进，体验和原生软件一样。

> An standalone desktop app for DeepSeek Harness — one window, one tray icon, zero browser tabs. Works on Windows, macOS and Linux.

## 为什么用 Deck 而不是浏览器

| | 浏览器打开 Harness | DeepSeek Deck |
|---|---|---|
| 打开方式 | 记地址、开浏览器、找标签页 | 双击图标，即开即用 |
| 窗口 | 淹没在标签页里 | 独立窗口，Command+Tab 直达 |
| 后台常驻 | 关标签就断了 | 托盘驻留，关窗不退出，随时呼出 |
| 服务管理 | 手动启动/排查 | 自动拉起、崩溃自愈、托盘一键启停 |
| 更新 | — | 与 Harness 解耦，Harness 更新无需动 Deck |

## 界面

![DeepSeek Deck 主界面](docs/screenshot.png)

## 特性

- 独立窗口承载 Harness 完整界面（会话、工作区、模型切换、工具模式一个不少）
- 托盘常驻：运行状态一目了然，启停服务/浏览器打开/退出都在托盘
- 服务自动管理：启动时自动拉起 `dsh web`，崩溃自动重连，不需要碰终端
- 窗口状态记忆：记住尺寸位置，拔掉外接显示器自动回正
- 黑渐变海豚图标，三平台原生外观

## 下载

从 [Releases](https://github.com/MartyYao/deepseek-deck/releases) 下载对应平台产物：

| 平台 | 产物 | 说明 |
|---|---|---|
| macOS | `.dmg` / `.zip`（arm64 与 x64 两种） | 未签名：首次打开请右键 →「打开」，或执行 `xattr -dr com.apple.quarantine /Applications/DeepSeek\ Harness.app` |
| Windows | `.exe`（NSIS 安装包） | 双击安装即可 |
| Linux | `.AppImage` / `.deb` | AppImage 先 `chmod +x` 再执行；deb 用 `sudo dpkg -i` 安装 |

## 前置依赖

Deck 负责界面和服务管理，AI 引擎本体来自官方组件，需要：

- **Node.js 18+**（三平台均需）
- 全局安装 dsh：

```bash
npm i -g @deepseek-ai/dsh
```

## 使用方法

### macOS

服务由 **launchd 托管**（托盘「启动 DSH 服务」即可，也可用 `deploy/dsh-web-launcher.sh`）。Deck 只发 `launchctl` 命令、不直接拉起服务进程——这保证服务以正确的系统身份运行，首次访问 iCloud 目录时按系统提示授权即可。

### Windows / Linux

Deck 启动时自动 **spawn `dsh web` 子进程**，退出时自动停止（整棵进程树清理，不留孤儿）。服务日志在：

- Windows：`%APPDATA%/DeepSeek Harness/logs/dsh-web.log`
- Linux：`~/.config/DeepSeek Harness/logs/dsh-web.log`

### 托盘菜单

- **显示 / 隐藏窗口**：单击托盘图标同效
- **启动 / 停止 DSH 服务**：macOS 走 launchctl，Windows/Linux 拉起或终止 dsh 子进程
- **在浏览器中打开**：需要浏览器版时随时可切
- **退出**：退出应用（Windows/Linux 一并停止 dsh 子进程）

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_SHELL_URL` | `http://127.0.0.1:3080` | dsh web 地址 |
| `DSH_SHELL_NO_TRAY` | — | 设为非空即不创建托盘（无托盘时关窗即退出） |
| `DSH_BIN` | `dsh`（PATH 查找） | dsh 可执行文件路径覆盖（Windows 上可指向 `dsh.cmd` 全路径） |

## 架构

Deck 与 Harness 完全解耦，只依赖稳定的 HTTP 接口（web UI + `/api`），不碰 Harness 内部文件，因此 **Harness 升级不需要重新发布 Deck**。服务生命周期按平台分支：

- **macOS**：launchd 托管。Deck 仅通过 `launchctl bootstrap/kickstart/bootout` 控制，保证服务以正确身份运行（iCloud 授权链不断）
- **Windows / Linux**：子进程模式。Deck spawn `dsh web`，日志落 `userData/logs/dsh-web.log`，退出时终止整棵进程树

## 从源码构建

```bash
cd dsh-shell/app
npm install
npm run dist:mac    # macOS：dmg + zip（--arm64 / --x64 指定架构）
npm run dist:win    # Windows：nsis 安装包
npm run dist:linux  # Linux：AppImage + deb
```

仓库带 GitHub Actions（`.github/workflows/release.yml`）：推送 `v*` 标签即三平台矩阵构建并自动发布 Release。

## 已知限制

- macOS 服务依赖 launchd（`LaunchAgents/ai.dsh.web.plist` 需已安装或由 Deck 自动注册）
- Windows / Linux 上服务生命周期绑定应用进程：退出应用即停止服务；需要常驻服务请自行用任务管理器 / systemd 托管 `dsh web`
- 产物未做代码签名：macOS 首次打开需右键打开 / `xattr` 去隔离，Windows SmartScreen 可能提示

## License

MIT
