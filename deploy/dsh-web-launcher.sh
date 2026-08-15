#!/bin/bash
# dsh 启动器（v2.1 2026-08-15）：launchd 按需拉起服务器 + 打开 Electron 独立壳 + 就绪确认。
# 服务器进程由 launchd 生成 → 责任进程是 node 二进制本身，TCC 权限链路正常（iCloud vault 可读写）。
# v2.1：去掉轮询后的重复 open（P1-1）；清理 PWA 时代注释与变量名（P2-10）。
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
PLIST="$HOME/Library/LaunchAgents/ai.dsh.web.plist"
URL="${DSH_WEB_URL:-http://127.0.0.1:3080}"
SHELL_APP="$HOME/Applications/DeepSeek Harness.app"

# 1. 注册 job（已注册时 bootstrap 报错，忽略）
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || true
# 2. 按需启动服务器（已在运行则无操作）
launchctl kickstart "gui/$(id -u)/ai.dsh.web"
# 3. 打开 Electron 独立壳（含托盘：启停服务/状态/浏览器打开/退出）
open "$SHELL_APP"

# 4. 轮询端口就绪（最多 60 秒）——只做就绪确认与日志，不再重复 open（壳已在步骤 3 打开，避免二次打开抢焦点）
echo "等待 DSH 服务就绪 ($URL) ..."
ready=0
for i in $(seq 1 60); do
  if curl -sf -o /dev/null --max-time 2 "$URL" 2>/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" = "1" ]; then
  echo "服务已就绪。"
else
  echo "警告：DSH 服务 60 秒内未就绪（检查 $HOME/.dsh/logs/web.stderr.log）" >&2
fi
