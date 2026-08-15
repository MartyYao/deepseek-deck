// dsh-shell app — Electron 主进程（v0.11.0, 2026-08-15；三平台 + 捆绑运行时版）
// 独立桌面壳（Windows / macOS / Linux）：加载 http://127.0.0.1:3080 的 dsh web。
// 服务托管按平台分支：
//   - macOS：launchd 托管（TCC 红线：责任进程 = node 二进制，壳只发 launchctl 命令，
//     不直接 spawn dsh；iCloud vault 长期记忆授权链路不受影响）。行为与 v0.1.1 完全一致。
//   - Windows / Linux：壳直接 spawn `dsh web` 子进程，随壳退出自动终止（防孤儿），
//     stdout/stderr 追加写入 userData/logs/dsh-web.log 便于排障。
//     dsh 来源三级查找（resolveDsh）：DSH_BIN 覆盖 → PATH 系统版 → 安装包捆绑运行时
//     （resources/node-bin/node + resources/dsh-runtime 内预装的 @deepseek-ai/dsh，免安装）。
// 与 DSH 更新解耦：壳只依赖稳定 HTTP 表面（web UI + /api），不 import 任何 DSH 包。

import { app, BrowserWindow, Tray, Menu, shell, session, dialog, Notification, ipcMain, nativeImage, screen } from 'electron';
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
// canonical 仓库名 deepseek-harness-deck（旧名 deepseek-deck 301 重定向，atom 跟随重定向但仍用新名）
const RELEASES_URL = 'https://github.com/MartyYao/deepseek-harness-deck/releases';
const RELEASES_ATOM = RELEASES_URL + '.atom'; // atom 免登录、github.com 域名可达
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
const ASSETS = (name) => path.join(__dirname, 'assets', name);

let mainWindow = null;
let tray = null;
let isQuitting = false;
let loadFailures = 0;
let trayRefreshInFlight = false;
let dshChild = null;       // win/linux：壳 spawn 的 `dsh web` 子进程
let lastSpawnError = null; // win/linux：最近一次 spawn 失败原因（如 dsh 未安装且捆绑运行时缺失）
let dshSource = null;      // win/linux：实际使用的 dsh 来源（env/system/bundled），记日志便于排障
let lastTrayRunning = null; // 托盘菜单顶部只读项含服务状态：状态变化才重建菜单
let lastNotifiedSpawnError = null; // P2-2：同一 spawn 失败只通知一次（引用比较去重）

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

// ── dsh 来源三级查找（win/linux spawn 分支使用）────────────────────────────────
// 1) DSH_BIN 显式覆盖  2) PATH 中的系统版 dsh（兼容老用户，可随 npm update 升级）
// 3) 安装包捆绑运行时（免安装：官方 Node 二进制 + 预装的 @deepseek-ai/dsh）
function findOnPath(name) {
  const exts = isWin ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try { fs.accessSync(path.join(dir, name + ext), fs.constants.X_OK); return true; } catch { /* 继续找 */ }
    }
  }
  return false;
}

function resolveDsh() {
  if (process.env.DSH_BIN) return { kind: 'env', bin: process.env.DSH_BIN, args: ['web'], shell: isWin };
  if (findOnPath('dsh')) return { kind: 'system', bin: 'dsh', args: ['web'], shell: isWin };
  // 捆绑运行时：直接 spawn node + dsh CLI 入口（bin 经 npm view 确认为 lib/bin.js），不经 shell——
  // 非 .cmd 无 shell 坑；路径含空格（Windows 安装目录）也无需转义。找不到返回 null。
  const nodeBin = path.join(process.resourcesPath, 'node-bin', isWin ? 'node.exe' : 'node');
  const dshCli = path.join(process.resourcesPath, 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (fs.existsSync(nodeBin) && fs.existsSync(dshCli)) {
    return { kind: 'bundled', bin: nodeBin, args: [dshCli, 'web'], shell: false };
  }
  return null;
}

function spawnDshChild() {
  lastSpawnError = null;
  const resolved = resolveDsh();
  if (!resolved) {
    // 未装系统版 dsh 且捆绑运行时缺失（开发模式 npm start、或安装包不完整）
    lastSpawnError = new Error('未找到 dsh：DSH_BIN 未设置、PATH 无 dsh、捆绑运行时缺失');
    console.error('[dsh-shell]', lastSpawnError.message);
    return;
  }
  dshSource = resolved.kind;
  console.log(`[dsh-shell] dsh 来源: ${dshSource} (${resolved.bin})`);
  let fd;
  try { fd = dshLogFd(); } catch { fd = 'ignore'; }
  // Windows 坑：npm 全局安装的 dsh 在 PATH 里是 dsh.cmd（cmd shim），不走 cmd.exe
  // 直接 spawn 会失败，必须 shell:true；bin 加引号以兼容含空格的 DSH_BIN 路径。
  // 捆绑运行时（shell:false）spawn 的是 node.exe 本体、不经 cmd，无此坑。
  // linux 用 detached 独立进程组，退出时整组 SIGTERM 防孤儿。
  // 已知风险（接受现状）：shell:true 下参数只拼接不转义，DSH_BIN 含 `"` 可逃逸引号
  // 注入 cmd 命令——但 DSH_BIN 是本地用户自控 env，攻击面等同用户自己开 cmd，不改行为。
  // 另注：Node ≥20 对 shell:true + args 拼接会打 DEP0190 警告，属预期行为、非构建错误。
  const child = spawn(resolved.shell ? `"${resolved.bin}"` : resolved.bin, resolved.args, {
    shell: resolved.shell,
    detached: !isWin,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
  });
  dshChild = child;
  child.on('error', (err) => {
    lastSpawnError = err; // 典型：ENOENT = 可执行文件缺失
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
    // win/linux：spawn 失败（dsh 未安装且捆绑运行时缺失；含 cmd 非零退出经 close 补记的情形），错误页展示引导
    mainWindow.loadFile(ASSETS('error.html'), { query: { reason: 'spawn-failed' } });
  } else {
    mainWindow.loadFile(ASSETS('error.html'));
  }
}

// ── 检查更新（GitHub Releases atom，免登录；正则解析无依赖）─────────────────────
// 仅比较数字段（x.y.z），忽略 pre-release 后缀；a>b → 1，相等 0，a<b → -1
function compareSemver(a, b) {
  const pa = a.split('.').map((s) => parseInt(s, 10) || 0);
  const pb = b.split('.').map((s) => parseInt(s, 10) || 0);
  while (pa.length < 3) pa.push(0); // 归一到三段，避免 "0.11" vs "0.11.0" 误判
  while (pb.length < 3) pb.push(0);
  for (let i = 0; i < 3; i++) { if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1; }
  return 0;
}

// 遍历所有 <entry>，取第一个严格匹配正式版 tag（v?x.y.z）的版本号；
// 含 - 后缀（rc/beta/alpha）或不含版本号的 prerelease 条目直接跳过——
// releases.atom 首条不保证是最新正式版。标题正则仅作无 tag 时的兜底。
function latestStableFromAtom(xml) {
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
  for (const entry of entries) {
    const id = entry.match(/<id>([^<]+)<\/id>/);
    const tag = id && id[1].trim().split('/').pop(); // 形如 .../releases/tag/v0.10.0
    if (tag) {
      if (/^v?\d+\.\d+\.\d+$/.test(tag)) return tag.replace(/^v/, '');
      continue; // tag 非正式版（含 rc/beta 等后缀）→ 跳过本 entry
    }
    const title = entry.match(/<title>\s*([^<]+?)\s*<\/title>/);
    const v = title && title[1].match(/(\d+\.\d+\.\d+)/);
    if (v) return v[1];
  }
  throw new Error('atom 中未解析到正式版版本号');
}

async function fetchLatestVersion() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000); // 8s 超时，不卡托盘菜单
  try {
    // 走 Electron 网络栈（session.fetch）：Chromium 层自动读系统代理，三平台一致；
    // 主进程全局 fetch（undici）不读系统代理，公司代理环境必失效
    const res = await session.defaultSession.fetch(RELEASES_ATOM, {
      signal: ctrl.signal,
      headers: { 'User-Agent': `deepseek-harness-deck/${app.getVersion()}` },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const xml = await res.text();
    return latestStableFromAtom(xml);
  } finally { clearTimeout(t); }
}

// interactive=true（托盘菜单点击）：有新版弹框（可跳 Releases）；无新版/失败仅 Notification。
// interactive=false：只记日志，不打扰用户。该静默入口为预留（P2-10 决策：
// 有意不接定时器自动检查，保持纯手动触发，仅保留此入口供未来启用）。
// updateCheckInFlight 防重入：托盘连点/与未来的静默检查并发时直接返回。
let updateCheckInFlight = false;
async function checkForUpdates(interactive) {
  if (updateCheckInFlight) return;
  updateCheckInFlight = true;
  try {
    const latest = await fetchLatestVersion();
    const current = app.getVersion();
    if (compareSemver(latest, current) > 0) {
      console.log(`[dsh-shell] 发现新版本 v${latest}（当前 v${current}）`);
      const { response } = await dialog.showMessageBox({
        type: 'info',
        title: '发现新版本',
        message: `DeepSeek Deck v${latest} 已发布`,
        detail: `当前版本 v${current}。`,
        buttons: ['打开 Releases', '稍后'],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) shell.openExternal(RELEASES_URL);
    } else {
      console.log(`[dsh-shell] 已是最新版本（v${current}）`);
      if (interactive && Notification.isSupported()) {
        new Notification({ title: APP_TITLE, body: `已是最新版本（v${current}）` }).show();
      }
    }
  } catch (err) {
    console.log('[dsh-shell] 检查更新失败:', err.message);
    if (interactive && Notification.isSupported()) {
      new Notification({ title: APP_TITLE, body: '检查更新失败（网络不可达？），请稍后重试' }).show();
    }
  } finally {
    updateCheckInFlight = false;
  }
}

// ── 托盘 ──────────────────────────────────────────────────────────────────
function logsDir() {
  const dir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(dir, { recursive: true }); // 目录不存在则创建，openPath 才不会静默失败
  return dir;
}

// 开机自启：mac/win 走系统登录项（勾选即时生效）；Linux 不支持，禁用项并说明。
// mac 用 openAsHidden 避免登录后弹窗抢焦点；自启后现有 loadOrStart 会自动拉起服务，无需额外处理。
function loginItemMenuItem() {
  if (!isMac && !isWin) return { label: '开机自启（Linux 请使用系统自启）', enabled: false };
  return {
    label: '开机自启',
    type: 'checkbox',
    checked: app.getLoginItemSettings().openAtLogin, // 构建菜单时同步系统侧勾选态
    click: (item) => {
      app.setLoginItemSettings(isMac ? { openAtLogin: item.checked, openAsHidden: true } : { openAtLogin: item.checked });
    },
  };
}

function buildTrayMenu(running) {
  return Menu.buildFromTemplate([
    { label: `DeepSeek Deck v${app.getVersion()}（服务：${running ? '运行中' : '已停止'}）`, enabled: false },
    { type: 'separator' },
    { label: '显示 / 隐藏窗口', click: toggleWindow },
    { type: 'separator' },
    { label: '启动 DSH 服务', click: async () => { await startService(); await refreshTrayStatus(); } },
    { label: '停止 DSH 服务', click: async () => { await stopService(); await refreshTrayStatus(); } },
    { label: '在浏览器中打开', click: () => shell.openExternal(WEB_URL) },
    { type: 'separator' },
    loginItemMenuItem(),
    { label: '检查更新…', click: () => checkForUpdates(true) },
    { label: '打开日志目录', click: () => shell.openPath(logsDir()) },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } },
  ]);
}

function createTray() {
  let img = nativeImage.createFromPath(ASSETS('tray.png'));
  if (isMac) { img = img.resize({ width: 18 }); img.setTemplateImage(true); } // 模板图仅 mac；win/linux 用彩色图
  tray = new Tray(img);
  tray.setToolTip(APP_TITLE);
  tray.setContextMenu(buildTrayMenu(false)); // 初始菜单；refreshTrayStatus 探测后按真实状态重建
  refreshTrayStatus();
  setInterval(refreshTrayStatus, 3000);
  tray.on('click', toggleWindow);
}

// P2-5：防重入（端口探测可能卡住导致并发轮询）
async function refreshTrayStatus() {
  if (!tray || trayRefreshInFlight) return;
  trayRefreshInFlight = true;
  try {
    const running = await serverRunning();
    tray.setToolTip(running ? `${APP_TITLE} — 服务运行中 (${WEB_URL})` : `${APP_TITLE} — 服务已停止`);
    if (running !== lastTrayRunning) { // 顶部只读项含服务状态：仅在状态变化时重建菜单，不打断正打开的菜单
      lastTrayRunning = running;
      tray.setContextMenu(buildTrayMenu(running));
    }
    if (mainWindow) {
      mainWindow.setTitle(running ? `${APP_TITLE} (运行中)` : `${APP_TITLE} (已停止)`);
    }
    // P2-2（仅非 mac；mac 走 launchd 不涉及 spawn）：托盘「启动 DSH 服务」后
    // 若 spawn 失败（含 ENOENT 异步 error 事件、未找到 dsh），给用户可见反馈。
    // 同一错误对象只弹一次；下次启动尝试会先把 lastSpawnError 置 null，新失败可再弹。
    if (!isMac && lastSpawnError !== null && lastSpawnError !== lastNotifiedSpawnError) {
      lastNotifiedSpawnError = lastSpawnError;
      if (Notification.isSupported()) {
        new Notification({ title: 'DSH 服务启动失败', body: lastSpawnError.message }).show();
      }
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
  return { appVersion: app.getVersion(), url: WEB_URL, service: SERVICE, dshSource };
});
ipcMain.on('dsh-shell:retry', (event) => {
  if (!isTrustedSender(event)) return;
  loadFailures = 0;
  loadOrStart();
});
