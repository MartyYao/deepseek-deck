// dsh-shell app — Electron 主进程（v0.10.0, 2026-08-15；三平台版）
// 独立桌面壳（Windows / macOS / Linux）：加载 http://127.0.0.1:3080 的 dsh web。
// 服务托管按平台分支：
//   - macOS：launchd 托管（TCC 红线：责任进程 = node 二进制，壳只发 launchctl 命令，
//     不直接 spawn dsh；iCloud vault 长期记忆授权链路不受影响）。行为与 v0.1.1 完全一致。
//   - Windows / Linux：壳直接 spawn `dsh web` 子进程，随壳退出自动终止（防孤儿），
//     stdout/stderr 追加写入 userData/logs/dsh-web.log 便于排障。
// 与 DSH 更新解耦：壳只依赖稳定 HTTP 表面（web UI + /api），不 import 任何 DSH 包。

import { app, BrowserWindow, Tray, Menu, shell, session, Notification, ipcMain, nativeImage, screen } from 'electron';
import { execFile, spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

// ── 常量（launchd 相关常量仅 darwin 分支使用；getuid 等 mac/unix API 不进顶层表达式）───
const WEB_URL = process.env.DSH_SHELL_URL || 'http://127.0.0.1:3080';
const WEB_ORIGIN = new URL(WEB_URL).origin;
const PORT = new URL(WEB_URL).port || '3080';
const SERVICE = 'ai.dsh.web';
// 以下两个为惰性函数：仅在 darwin 分支求值，避免 Windows 上 getuid 不存在导致模块加载即崩
const GUI_SERVICE = () => `gui/${process.getuid()}/${SERVICE}`;
const PLIST = () => `${process.env.HOME}/Library/LaunchAgents/${SERVICE}.plist`;
const LAUNCHCTL = '/bin/launchctl';
const LSOF = 'lsof'; // darwin/linux 走 PATH 查找（execFile 不经 shell，无注入面）；win32 走 fetch 探测；lsof 缺失时回退 fetch
const APP_TITLE = 'DeepSeek Harness';
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
const ASSETS = (name) => path.join(__dirname, 'assets', name);

let mainWindow = null;
let tray = null;
let isQuitting = false;
let loadFailures = 0;
let trayRefreshInFlight = false;
let dshChild = null;       // win/linux：壳 spawn 的 `dsh web` 子进程
let lastSpawnError = null; // win/linux：最近一次 spawn 失败原因（如 ENOENT = dsh 未安装）

// ── 命令执行（child_process；macOS 下只发 launchctl，不 spawn 服务本身）────────────
function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, out: String(stdout || '') + String(stderr || '') });
    });
  });
}

// 短超时 HTTP 探测：fetch 对 / 的任意 <500 响应即视为存活（win32 主路径；linux 下 lsof 缺失时的回退）
async function fetchProbe() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(WEB_URL, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok || res.status < 500;
  } catch { return false; }
}

async function serverRunning() {
  if (isWin) return fetchProbe(); // win32 无 lsof
  const r = await run(LSOF, ['-sTCP:LISTEN', `-iTCP:${PORT}`, '-t']);
  if (r.code === 0) return r.out.trim().length > 0;
  // lsof 退出码 1 = 正常返回"无监听"；其他失败（如 ENOENT = 发行版未装 lsof）回退 fetch 探测，保证托盘状态准确
  if (r.code === 1) return false;
  return fetchProbe();
}

// ── 服务生命周期：darwin 走 launchd（同 v0.1.1），win/linux 走 spawn 子进程 ─────────
async function startService() {
  if (isMac) {
    // 已注册时 bootstrap 报错，忽略；kickstart 幂等
    await run(LAUNCHCTL, ['bootstrap', `gui/${process.getuid()}`, PLIST()]);
    await run(LAUNCHCTL, ['kickstart', GUI_SERVICE()]);
    return;
  }
  if (dshChild && dshChild.exitCode === null && dshChild.signalCode === null) return; // 已在跑
  spawnDshChild();
}

async function stopService() {
  if (isMac) {
    await run(LAUNCHCTL, ['bootout', GUI_SERVICE()]);
    return;
  }
  stopDshChild();
}

function dshLogFd() {
  const dir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  return fs.openSync(path.join(dir, 'dsh-web.log'), 'a');
}

function spawnDshChild() {
  const bin = process.env.DSH_BIN || 'dsh';
  lastSpawnError = null;
  let fd;
  try { fd = dshLogFd(); } catch { fd = 'ignore'; }
  // Windows 坑：npm 全局安装的 dsh 在 PATH 里是 dsh.cmd（cmd shim），不走 cmd.exe
  // 直接 spawn 会失败，必须 shell:true；bin 加引号以兼容含空格的 DSH_BIN 路径。
  // linux 用 detached 独立进程组，退出时整组 SIGTERM 防孤儿。
  // 已知风险（接受现状）：shell:true 下参数只拼接不转义，DSH_BIN 含 `"` 可逃逸引号
  // 注入 cmd 命令——但 DSH_BIN 是本地用户自控 env，攻击面等同用户自己开 cmd，不改行为。
  // 另注：Node ≥20 对 shell:true + args 拼接会打 DEP0190 警告，属预期行为、非构建错误。
  const child = spawn(isWin ? `"${bin}"` : bin, ['web'], {
    shell: isWin,
    detached: !isWin,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
  });
  dshChild = child;
  child.on('error', (err) => {
    lastSpawnError = err; // 典型：ENOENT = PATH 里找不到 dsh（未安装）
    console.error('[dsh-shell] spawn dsh 失败:', err.message);
  });
  child.on('close', (code) => {
    if (fd !== 'ignore') { try { fs.closeSync(fd); } catch { /* 忽略 */ } }
    if (dshChild === child) dshChild = null;
    // Windows 上 spawn 的是 cmd.exe：dsh.cmd 缺失时 cmd 只非零退出（code=127/9009），
    // 不触发 error 事件——必须在 close 里补记，否则 spawn-failed 分支不可达（P1-1）。
    // Linux 的 ENOENT 走上面的 error 回调，两者互不干扰。
    if (code !== 0 && !isQuitting && lastSpawnError === null) {
      lastSpawnError = new Error('dsh web 退出 code=' + code);
    }
    if (!isQuitting) console.log('[dsh-shell] dsh web 子进程退出，code =', code);
  });
}

function stopDshChild() {
  const child = dshChild;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (isWin) {
    // taskkill /T 终止整棵进程树（cmd.exe shim → node），防孤儿；child.kill 只杀 cmd 壳。
    // 用 spawnSync 而非异步 spawn：同步阻塞、结果确定，before-quit 清理不靠时序侥幸，
    // 也无需给异步 spawn 补 error 监听（P1-2）。
    if (child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    // detached 进程组：负 pid 整组 SIGTERM；失败则退回只杀直接子进程
    try { process.kill(-child.pid, 'SIGTERM'); }
    catch { try { child.kill('SIGTERM'); } catch { /* 已退出 */ } }
  }
  // 发出终止后立即清空引用：消除托盘「停止→快速启动」竞态中 startService 幂等判断
  // 误判"已在跑"（P2-2）；close 回调有 `dshChild === child` 相等保护，清空安全。
  dshChild = null;
}

async function waitForServer(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // 已知失败立即退出，不把 60s 死等拖满（P1-1）：
    // - 子进程已死且非零退出（如 cmd 找不到 dsh.cmd）；注意 close 回调会先一步
    //   把 dshChild 置 null，故同时检查 lastSpawnError（close 已补记非零退出）
    if (lastSpawnError) return false;
    if (dshChild && dshChild.exitCode !== null && dshChild.exitCode !== 0) return false;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2000);
      const res = await fetch(WEB_URL, { signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok || res.status < 500) return true;
    } catch { /* 未就绪，继续轮询 */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

// ── 窗口 ──────────────────────────────────────────────────────────────────
function persistBounds() {
  if (!mainWindow) return;
  fs.writeFileSync(stateFile(), JSON.stringify(mainWindow.getBounds()));
}

// P1-3：恢复坐标前校验可见性（拔掉外接显示器后窗口可能落在屏幕外）
function isVisibleOnSomeDisplay(x, y, w, h) {
  if (typeof x !== 'number' || typeof y !== 'number') return false;
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    const ox = Math.max(0, Math.min(x + w, a.x + a.width) - Math.max(x, a.x));
    const oy = Math.max(0, Math.min(y + h, a.y + a.height) - Math.max(y, a.y));
    return ox >= 100 && oy >= 100; // 至少 100x100 可见
  });
}

function createWindow() {
  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { /* 首次运行 */ }
  const w = state.width || 1280;
  const h = state.height || 860;
  const hasValidPos = isVisibleOnSomeDisplay(state.x, state.y, w, h);

  mainWindow = new BrowserWindow({
    title: APP_TITLE,
    width: w,
    height: h,
    ...(hasValidPos ? { x: state.x, y: state.y } : {}), // 无有效坐标则系统居中
    minWidth: 900,
    minHeight: 600,
    show: false,
    icon: ASSETS(isMac ? 'icon.icns' : (isWin ? 'icon.ico' : 'icon.png')),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  // P2-8：冷启动先显示加载页（服务可能需 60s 才就绪），避免无窗口反馈
  mainWindow.loadFile(ASSETS('loading.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  const debounce = (fn, ms) => { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; };
  const save = debounce(persistBounds, 500);
  mainWindow.on('resize', save);
  mainWindow.on('move', save);

  mainWindow.on('close', (e) => {
    if (!isQuitting && tray) { e.preventDefault(); mainWindow.hide(); }
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  // 外部链接 → 系统浏览器；页面内禁止新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // P2-1/P2-2：导航守卫用 origin 精确比较；非 http(s)/file: 一律拦截
  mainWindow.webContents.on('will-navigate', (e, url) => {
    let allowed = false;
    try {
      if (url.startsWith('file:')) allowed = true;                    // loading/error 本地页
      else if (/^https?:/i.test(url)) allowed = new URL(url).origin === WEB_ORIGIN;
    } catch { allowed = false; }
    if (!allowed) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  // P2-6：网页标题不覆盖"运行中/已停止"状态标题
  mainWindow.webContents.on('page-title-updated', (e) => e.preventDefault());

  // 服务重启/崩溃后自动重连（限次）；P2-7：耗尽后给可操作错误页
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    if (isQuitting || url.startsWith('file:')) return;
    loadFailures += 1;
    if (loadFailures <= 15) {
      // .catch 吞掉 rejection：重试失败由 did-fail-load 兜底，防 Node unhandled rejection 崩溃（P2-5）
      setTimeout(() => { if (mainWindow && !isQuitting) mainWindow.loadURL(WEB_URL).catch(() => {}); }, 2000);
    } else {
      mainWindow.loadFile(ASSETS('error.html'));
    }
  });
  mainWindow.webContents.on('did-finish-load', () => { loadFailures = 0; });

  return mainWindow;
}

async function loadOrStart() {
  if (!mainWindow) createWindow();
  let up = await serverRunning();
  if (!up) {
    await startService();
    up = await waitForServer();
  }
  if (up) {
    await mainWindow.loadURL(WEB_URL).catch(() => {}); // 失败由 did-fail-load 重连兜底（P2-5）
  } else if (!isMac && lastSpawnError !== null) {
    // win/linux：spawn 失败（多为 dsh 未安装；含 cmd 非零退出经 close 补记的情形），错误页展示安装引导
    mainWindow.loadFile(ASSETS('error.html'), { query: { reason: 'spawn-failed' } });
  } else {
    mainWindow.loadFile(ASSETS('error.html'));
  }
}

// ── 托盘 ──────────────────────────────────────────────────────────────────
function createTray() {
  let img = nativeImage.createFromPath(ASSETS('tray.png'));
  if (isMac) { img = img.resize({ width: 18 }); img.setTemplateImage(true); } // 模板图仅 mac；win/linux 用彩色图
  tray = new Tray(img);
  tray.setToolTip(APP_TITLE);
  refreshTrayStatus();
  setInterval(refreshTrayStatus, 3000);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 / 隐藏窗口', click: toggleWindow },
    { type: 'separator' },
    { label: '启动 DSH 服务', click: async () => { await startService(); await refreshTrayStatus(); } },
    { label: '停止 DSH 服务', click: async () => { await stopService(); await refreshTrayStatus(); } },
    { label: '在浏览器中打开', click: () => shell.openExternal(WEB_URL) },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', toggleWindow);
}

// P2-5：防重入（端口探测可能卡住导致并发轮询）
async function refreshTrayStatus() {
  if (!tray || trayRefreshInFlight) return;
  trayRefreshInFlight = true;
  try {
    const running = await serverRunning();
    tray.setToolTip(running ? `${APP_TITLE} — 服务运行中 (${WEB_URL})` : `${APP_TITLE} — 服务已停止`);
    if (mainWindow) {
      mainWindow.setTitle(running ? `${APP_TITLE} (运行中)` : `${APP_TITLE} (已停止)`);
    }
  } finally {
    trayRefreshInFlight = false;
  }
}

function toggleWindow() {
  if (!mainWindow) { createWindow(); loadOrStart(); return; }
  if (mainWindow.isVisible()) mainWindow.hide();
  else { mainWindow.show(); mainWindow.focus(); }
}

// ── 权限与安全 ────────────────────────────────────────────────────────────
// P2-4：白名单数组（不再是 clipboard 前缀通配；clipboard-read 因 DSH 粘贴功能保留）
const ALLOWED_PERMISSIONS = new Set(['notifications', 'clipboard-sanitized-write', 'clipboard-read']);

function configurePermissions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, cb) => {
    const allowed = ALLOWED_PERMISSIONS.has(permission);
    if (!allowed) console.log('[dsh-shell] denied:', permission);
    cb(allowed);
  });
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
}

// P2-3：IPC sender 校验（仅信任 DSH 页面 origin 或本地壳资源页）
function isTrustedSender(event) {
  try {
    const u = event.senderFrame.url;
    return u.startsWith('file:') || new URL(u).origin === WEB_ORIGIN;
  } catch { return false; }
}

// ── 生命周期 ──────────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });

  app.whenReady().then(async () => {
    configurePermissions();
    createWindow();
    if (!process.env.DSH_SHELL_NO_TRAY) createTray();
    await loadOrStart();

    app.on('activate', () => {
      if (!mainWindow) { createWindow(); loadOrStart(); }
      else mainWindow.show();
    });
  });

  app.on('before-quit', () => {
    isQuitting = true;
    // win/linux：壳退出带走 spawn 的 dsh web，防孤儿进程；
    // 内部为 spawnSync（win）/同步 kill（linux），调用返回即清理完成，无异步时序问题（P1-2）
    if (!isMac) stopDshChild();
  });

  // darwin 惯例：有托盘时驻留后台（关窗即隐藏，不触发本事件）；
  // win/linux 平台惯例：无托盘时关窗即退出（有托盘时窗口 close 被拦截为 hide，同样不触发）
  app.on('window-all-closed', () => {
    if (!tray) app.quit();
  });
}

// 壳信息供页面（可选）使用：与 DSH 内部无耦合
ipcMain.handle('dsh-shell:info', (event) => {
  if (!isTrustedSender(event)) return null;
  return { appVersion: app.getVersion(), url: WEB_URL, service: SERVICE };
});
ipcMain.on('dsh-shell:retry', (event) => {
  if (!isTrustedSender(event)) return;
  loadFailures = 0;
  loadOrStart();
});
