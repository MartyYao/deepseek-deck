# DeepSeek Deck

DeepSeek Harness 独立桌面壳（Windows / macOS / Linux），v0.10.0。

> An standalone desktop shell for DeepSeek Harness — one window, one tray icon, zero browser tabs. Works on Windows, macOS and Linux; talks to `dsh web` over a plain HTTP contract.

## 特性

- 独立窗口（非浏览器标签），DSH 网页壳内直开
- 托盘控制：启动 / 停止服务、运行状态显示、浏览器打开、退出
- 窗口状态记忆（尺寸 / 位置，拔掉外接显示器自动回正）
- 服务崩溃自动重连（限次，耗尽后给可操作错误页）
- 纯 HTTP 契约与 DSH 解耦：壳不 import 任何 DSH 包，DSH 更新无需动壳
- 黑渐变海豚图标

## 下载

从 [Releases](https://github.com/MartyYao/deepseek-deck/releases) 页面下载对应平台产物：

| 平台 | 产物 | 说明 |
|---|---|---|
| macOS | `.dmg` / `.zip`（arm64 与 x64 两种架构产物，按芯片选择） | 未签名：首次打开请右键 →「打开」，或执行 `xattr -dr com.apple.quarantine /Applications/DeepSeek\ Harness.app` |
| Windows | `.exe`（NSIS 安装包） | 双击安装即可 |
| Linux | `.AppImage` / `.deb` | AppImage 需先 `chmod +x` 再执行；deb 用 `sudo dpkg -i` 安装 |

## 前置依赖

- **Node.js 18+**（Windows / macOS / Linux 均需）
- 全局安装 dsh：

```bash
npm i -g @deepseek-ai/dsh
```

## 使用方法

### macOS

服务由 **launchd 托管**（启动器 `deploy/dsh-web-launcher.sh`，或壳内托盘「启动 DSH 服务」）。
壳只发 `launchctl` 命令、不直接 spawn dsh——这是 TCC 红线：责任进程保持为 node 二进制，
iCloud 长期记忆库（vault）等授权链路不受影响；首次访问 iCloud 目录时按系统提示授权即可。

### Windows / Linux

壳启动时自动 **spawn `dsh web` 子进程**；退出壳自动停止服务（整棵进程树清理，不留孤儿）。
服务日志追加写入 `userData/logs/dsh-web.log`，排障先看它：

- Windows：`%APPDATA%/DeepSeek Harness/logs/dsh-web.log`
- Linux：`~/.config/DeepSeek Harness/logs/dsh-web.log`

### 托盘菜单

- **显示 / 隐藏窗口**：单击托盘图标同效
- **启动 / 停止 DSH 服务**：macOS 走 launchctl，Windows/Linux 拉起或终止 dsh 子进程
- **在浏览器中打开**：系统浏览器访问 http://127.0.0.1:3080
- **退出**：退出壳（Windows/Linux 会一并停止 dsh 子进程）

## 从源码构建

```bash
cd dsh-shell/app
npm install
npm run dist:mac    # macOS：dmg + zip
npm run dist:win    # Windows：nsis 安装包
npm run dist:linux  # Linux：AppImage + deb
```

仓库带 GitHub Actions（`.github/workflows/release.yml`）：推送 `v*` 标签即三平台矩阵构建并自动发布 Release。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_SHELL_URL` | `http://127.0.0.1:3080` | dsh web 地址 |
| `DSH_SHELL_NO_TRAY` | — | 设为非空即不创建托盘（无托盘时关窗即退出） |
| `DSH_BIN` | `dsh`（PATH 查找） | dsh 可执行文件路径覆盖（Windows 上可指向 `dsh.cmd` 全路径） |

## 架构说明

壳与 DSH 完全解耦，只依赖稳定 HTTP 表面（web UI + `/api`）。服务生命周期按平台分支：

- **macOS**：launchd 托管。壳仅通过 `launchctl bootstrap/kickstart/bootout` 控制，
  保证 TCC 责任进程为 node 二进制（iCloud vault 授权链不断）。
- **Windows / Linux**：子进程模式。壳 spawn `dsh web`，stdout/stderr 落
  `userData/logs/dsh-web.log`；`before-quit` 时终止整棵进程树（Windows 用
  `taskkill /T /F`，Linux 用负 pid 进程组 SIGTERM），服务生命周期绑定壳进程。

## 已知限制

- macOS 服务依赖 launchd（`LaunchAgents/ai.dsh.web.plist` 需已安装或由壳 bootstrap）
- Windows / Linux 上服务生命周期绑定壳进程：壳退出即服务停止；需要常驻服务请自行用
  任务管理器 / systemd 等方式托管 `dsh web`
- 产物未做代码签名：macOS 首次打开需右键打开 / `xattr` 去隔离，Windows SmartScreen 可能提示
