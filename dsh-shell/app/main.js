// dsh-shell app — Electron 主进程（v0.12.0, 2026-08-15；三平台 + 双更新通道版）
// v0.12.0：dsh 更新检测 + 一键更新（bundled 运行时首启迁 userData，包内 Resources 只读不可写）；
//         Deck 更新引导增强（弹窗「下载并安装」→ 下载对应平台安装包，方案 A 不引入 electron-updater）。
// 独立桌面壳（Windows / macOS / Linux）：加载 http://127.0.0.1:3080 的 dsh web。
// 服务托管按平台分支：
//   - macOS：launchd 托管（TCC 红线：责任进程 = node 二进制，壳只发 launchctl 命令，
//     不直接 spawn dsh；iCloud vault 长期记忆授权链路不受影响）。行为与 v0.1.1 完全一致。
//   - Windows / Linux：壳直接 spawn `dsh web` 子进程，随壳退出自动终止（防孤儿），
//     stdout/stderr 追加写入 userData/logs/dsh-web.log 便于排障。
//     dsh 来源三级查找（resolveDsh）：DSH_BIN 覆盖 → PATH 系统版 → 安装包捆绑运行时
//     （resources/node-bin/node + resources/dsh-runtime 内预装的 @deepseek-ai/dsh，免安装）。
// 与 DSH 更新解耦：壳只依赖稳定 HTTP 表面（web UI + /api），不 import 任何 DSH 包。

import { app, BrowserWindow, Tray, Menu, shell, session, dialog, clipboard, Notification, ipcMain, nativeImage, screen } from 'electron';
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
// dsh 更新检测/更新走 npmmirror：官方 registry.npmjs.org 国内不通（npmmirror 实测 0.2s 可达，
// 海外用户亦可直连；如需官方源改这一处即可）
const DSH_REGISTRY = 'https://registry.npmmirror.com';
const DSH_LATEST_URL = `${DSH_REGISTRY}/@deepseek-ai/dsh/latest`;
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
const ASSETS = (name) => path.join(__dirname, 'assets', name);

let mainWindow = null;
let tray = null;
let isQuitting = false;
let loadFailures = 0;
let trayRefreshInFlight = false;
let dshChild = null;       // win/linux：壳 spawn 的 `dsh web` 子进程
let lastSpawnError = null; // win/linux：最近一次 spawn 失败原因（如 dsh 未安装且捆绑运行时缺失）
let dshSource = null;      // win/linux：实际使用的 dsh 来源（env/system/bundled-userdata/bundled-resources），记日志便于排障
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
  await spawnDshChild();
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
// v0.12.0：捆绑运行时拆两级——userData 副本优先（可写，一键更新落在它上面），
// resources 兜底（app 包内 Resources/ 受签名/权限保护只读，仅首启迁移失败时用到）。
const runtimeDir = () => path.join(app.getPath('userData'), 'dsh-runtime');
const resourcesRuntimeDir = () => path.join(process.resourcesPath, 'dsh-runtime');
const dshCliIn = (root) => path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const dshPkgIn = (root) => path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');

// 延迟迁移（P2-2）：不再 whenReady 无条件执行，仅当 resolveDsh 即将落到 bundled-resources
// 兜底时才迁移（spawnDshChild 触发）——命中 DSH_BIN/PATH 系统版的用户不白复制 343MB。
// 完成标记 = 有意义文件存在（bin.js + package.json），而非「目录存在」（P1-1）：迁移中断
// 留下半成品目录时重跑 cpSync（对已存在目录为合并覆盖，可自愈残缺副本，已实测）。
// 失败仅记日志、不阻塞启动——resolveDsh 会走 resources 兜底分支（只读但仍可运行）。
function migrateBundledRuntime() {
  try {
    const dest = runtimeDir();
    if (fs.existsSync(dshCliIn(dest)) && fs.existsSync(dshPkgIn(dest))) return; // 已迁移完成
    const src = resourcesRuntimeDir();
    if (!fs.existsSync(dshCliIn(src))) return; // 开发模式/安装包无捆绑运行时
    console.log('[dsh-shell] 迁移捆绑运行时到 userData…');
    fs.cpSync(src, dest, { recursive: true });
    console.log('[dsh-shell] 运行时迁移完成:', dest);
  } catch (err) {
    console.error('[dsh-shell] 运行时迁移失败（不影响启动，走 resources 兜底）:', err.message);
  }
}

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
  // userData 副本优先，否则回退 resources 只读副本；命中条件 = bin.js + package.json 都存在
  // （P1-1：半成品迁移目录恰好含 bin.js 但缺 package.json 时不命中，杜绝残缺运行时）。
  // node 二进制始终用 resources 的——node 随 Deck 版本走，不独立更新。
  const nodeBin = path.join(process.resourcesPath, 'node-bin', isWin ? 'node.exe' : 'node');
  for (const [kind, root] of [['bundled-userdata', runtimeDir()], ['bundled-resources', resourcesRuntimeDir()]]) {
    const dshCli = dshCliIn(root);
    if (fs.existsSync(nodeBin) && fs.existsSync(dshCli) && fs.existsSync(dshPkgIn(root))) {
      return { kind, bin: nodeBin, args: [dshCli, 'web'], shell: false, runtimeRoot: root };
    }
  }
  return null;
}

async function spawnDshChild() {
  lastSpawnError = null;
  let resolved = resolveDsh();
  // P2-2 延迟迁移：即将落到 resources 只读兜底时，先尝试把捆绑运行时迁到 userData，
  // 迁移成功则本次直接用可写副本（重 resolve 一次）；失败维持 resources 兜底。
  // 命中 env/system 的用户完全不触发迁移；whenReady 不再无条件迁移。
  if (resolved && resolved.kind === 'bundled-resources') {
    migrateBundledRuntime();
    resolved = resolveDsh();
  }
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

// 遍历所有 <entry>，取第一个严格匹配正式版 tag（v?x.y.z）的 tag 原文（如 "v0.12.0"）；
// 含 - 后缀（rc/beta/alpha）或不含版本号的 prerelease 条目直接跳过——
// releases.atom 首条不保证是最新正式版。标题正则仅作无 tag 时的兜底（P2-8：兜底也补
// v 前缀，与 tag 分支同构，/download/<tag>/ 段可直接用）。
// 返回值保留 tag 原文：下载 URL 的 /download/<tag>/ 段直接用它，比较版本时再剥 v 前缀。
function latestStableFromAtom(xml) {
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
  for (const entry of entries) {
    const id = entry.match(/<id>([^<]+)<\/id>/);
    const tag = id && id[1].trim().split('/').pop(); // 形如 .../releases/tag/v0.10.0
    if (tag) {
      if (/^v?\d+\.\d+\.\d+$/.test(tag)) return tag;
      continue; // tag 非正式版（含 rc/beta 等后缀）→ 跳过本 entry
    }
    const title = entry.match(/<title>\s*([^<]+?)\s*<\/title>/);
    const m = title && title[1].match(/(\d+\.\d+\.\d+)/);
    if (m) return `v${m[1]}`;
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

// interactive=true（托盘菜单点击）：有新版弹框（「下载并安装」主按钮 + 跳 Releases 备用）；
// 无新版/失败仅 Notification。interactive=false：只记日志，不打扰用户。该静默入口为预留
// （P2-10 决策：有意不接定时器自动检查，保持纯手动触发，仅保留此入口供未来启用）。
// updateCheckInFlight 防重入：托盘连点/与 dsh 更新检查/未来的静默检查并发时直接返回，
// 交互入口被拦截时补 Notification 提示（P1-3）。
let updateCheckInFlight = false;
async function checkForUpdates(interactive) {
  if (updateCheckInFlight) {
    // P1-3：交互点击被防重拦截时补提示，不再静默吞掉（与 dshUpdateInFlight 分支同风格）
    if (interactive && Notification.isSupported()) {
      new Notification({ title: APP_TITLE, body: '正在检查更新，请稍候…' }).show();
    }
    return;
  }
  updateCheckInFlight = true;
  try {
    const latestTag = await fetchLatestVersion(); // tag 原文（如 v0.12.0）
    const latest = latestTag.replace(/^v/, '');
    const current = app.getVersion();
    if (compareSemver(latest, current) > 0) {
      console.log(`[dsh-shell] 发现新版本 ${latestTag}（当前 v${current}）`);
      const { response } = await dialog.showMessageBox({
        type: 'info',
        title: '发现新版本',
        message: `DeepSeek Deck v${latest} 已发布`,
        detail: `当前版本 v${current}。可下载安装包后手动安装（覆盖安装即可），或打开 Releases 页面自选资产。`,
        buttons: ['下载并安装', '打开 Releases', '稍后'],
        defaultId: 0,
        cancelId: 2,
      });
      if (response === 0) downloadDeckUpdate(latestTag);
      else if (response === 1) shell.openExternal(RELEASES_URL);
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

// ── Deck 更新引导：下载安装包（方案 A 定案：不引入 electron-updater 自动安装）─────
// 资产名按 release.yml 实际产物（electron-builder 默认命名，版本段不带 v 前缀，
// 已对照 v0.11.0 Release 资产核实）：
//   mac arm64: DeepSeek.Harness-<v>-arm64.dmg ；mac x64: DeepSeek.Harness-<v>.dmg
//   win:       DeepSeek.Harness.Setup.<v>.exe
//   linux:     DeepSeek.Harness-<v>.AppImage（.deb 不自动下载，走 Releases 页面）
// /download/<tag>/ 段用 atom 解析出的 tag 原文（带 v 前缀），文件名段用剥掉 v 的版本号。
function deckAssetUrl(tag) {
  const v = tag.replace(/^v/, '');
  const base = `${RELEASES_URL}/download/${tag}/`;
  if (isMac) return base + (process.arch === 'arm64' ? `DeepSeek.Harness-${v}-arm64.dmg` : `DeepSeek.Harness-${v}.dmg`);
  if (isWin) return base + `DeepSeek.Harness.Setup.${v}.exe`;
  return base + `DeepSeek.Harness-${v}.AppImage`;
}

// P1-4：模块级保存 will-download 监听器引用——downloadURL 网络失败不触发 will-download 时
// 监听器会常驻、反复触发则累加；注册前移除旧引用，done 时移除并置 null。
let deckWillDownloadHandler = null;
function downloadDeckUpdate(tag) {
  const url = deckAssetUrl(tag);
  const ses = session.defaultSession;
  const notify = (body) => { if (Notification.isSupported()) new Notification({ title: APP_TITLE, body }).show(); };
  const expectedExt = isMac ? '.dmg' : (isWin ? '.exe' : '.AppImage'); // P2-3：完成时校验扩展名
  if (deckWillDownloadHandler) ses.removeListener('will-download', deckWillDownloadHandler);
  const onDownload = (_event, item) => {
    // P2-10：下载目录被用户删过则重建；P2-3：文件名来自服务器 Content-Disposition，basename 去路径
    const downloadsDir = app.getPath('downloads');
    fs.mkdirSync(downloadsDir, { recursive: true });
    const savePath = path.join(downloadsDir, path.basename(item.getFilename()));
    item.setSavePath(savePath); // 免系统保存对话框，直接落下载目录
    item.once('done', (_e, state) => {
      ses.removeListener('will-download', onDownload);
      if (deckWillDownloadHandler === onDownload) deckWillDownloadHandler = null;
      // P2-3：completed ≠ 有效——资产名漂移 404 时 GitHub 的 HTML 错误页可能被存成预期
      // 文件名；校验文件存在 + 大小 > 1MB + 扩展名符合预期，异常走 Releases 兜底
      const valid = state === 'completed' && (() => {
        try { return fs.statSync(savePath).size > 1024 * 1024 && savePath.endsWith(expectedExt); }
        catch { return false; }
      })();
      if (valid) {
        console.log('[dsh-shell] Deck 安装包下载完成:', savePath);
        notify('安装包下载完成，已打开所在文件夹，请运行安装');
        shell.showItemInFolder(savePath);
      } else {
        // 中断/失败/校验未通过：提示 + 保留「打开 Releases」备用路径
        console.log('[dsh-shell] Deck 安装包下载无效:', state, savePath);
        notify(`安装包下载未完成（${state === 'completed' ? '文件校验未通过' : state}），已打开 Releases 页面可手动下载`);
        shell.openExternal(RELEASES_URL);
      }
    });
  };
  deckWillDownloadHandler = onDownload;
  ses.on('will-download', onDownload);
  ses.downloadURL(url); // 走 Chromium 网络栈，自动读系统代理
  console.log('[dsh-shell] 开始下载 Deck 安装包:', url);
  notify('开始下载安装包…');
}

// ── dsh 更新检测 + 一键更新（npmmirror；bundled 运行时落在 userData 副本）────────
async function fetchLatestDshVersion() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000); // 8s 超时，不卡托盘菜单
  try {
    // 同 Deck 检测：session.fetch 走 Chromium 网络栈读系统代理
    const res = await session.defaultSession.fetch(DSH_LATEST_URL, {
      signal: ctrl.signal,
      headers: { 'User-Agent': `deepseek-harness-deck/${app.getVersion()}` },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data || typeof data.version !== 'string') throw new Error('registry 响应缺少 version 字段');
    return data.version;
  } finally { clearTimeout(t); }
}

// shell:true 变体：win 上系统版 dsh 是 dsh.cmd（cmd shim），必须经 cmd.exe 执行（同 spawnDshChild 逻辑）
function runShell(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000, shell: true }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, out: String(stdout || '') + String(stderr || '') });
    });
  });
}

// 当前 dsh 版本，按 resolveDsh 实际命中分支取：
// - bundled-userdata / bundled-resources：读对应运行时目录里 @deepseek-ai/dsh/package.json 的 version
// - env / system：执行 `dsh --version`（win 经 shell 兼容 dsh.cmd）从输出抓版本号
async function currentDshVersion(resolved) {
  if (!resolved) return null;
  if (resolved.runtimeRoot) {
    try {
      return JSON.parse(fs.readFileSync(dshPkgIn(resolved.runtimeRoot), 'utf8')).version || null;
    } catch { return null; }
  }
  const r = resolved.shell
    ? await runShell(`"${resolved.bin}"`, ['--version'])
    : await run(resolved.bin, ['--version']);
  const m = r.out.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
  return m ? m[0] : null;
}

// interactive=true（托盘菜单点击）：有新版弹窗——bundled 分支（仅非 mac，P1-2）给「立即更新」，
// env/system 及 mac 一律给升级命令 + 「复制命令」；无新版/失败仅 Notification。
// interactive=false：有新版仅 Notification，不弹窗。
// 与 Deck 检查共用 updateCheckInFlight 防重；更新执行期间（dshUpdateInFlight）直接提示进行中。
async function checkDshUpdate(interactive) {
  if (dshUpdateInFlight) {
    if (interactive && Notification.isSupported()) {
      new Notification({ title: APP_TITLE, body: 'dsh 更新正在进行中，请稍候…' }).show();
    }
    return;
  }
  if (updateCheckInFlight) {
    // P1-3：交互点击被防重拦截时补提示，不再静默吞掉
    if (interactive && Notification.isSupported()) {
      new Notification({ title: APP_TITLE, body: '正在检查更新，请稍候…' }).show();
    }
    return;
  }
  updateCheckInFlight = true;
  try {
    const resolved = resolveDsh();
    const [latest, current] = await Promise.all([fetchLatestDshVersion(), currentDshVersion(resolved)]);
    if (!current) {
      console.log('[dsh-shell] 无法确定当前 dsh 版本（未找到 dsh？）');
      if (interactive && Notification.isSupported()) {
        new Notification({ title: APP_TITLE, body: '未检测到 dsh 安装，无法检查更新' }).show();
      }
      return;
    }
    if (compareSemver(latest, current) > 0) {
      const bundled = resolved.kind.startsWith('bundled');
      // P1-2：mac 服务由 launchd 按 plist 硬编码路径拉起（系统 dsh），从不读捆绑/userData
      // 运行时——mac 上「立即更新」装进 userData 是无效更新且提示误导，一律走 system 式
      // 弹窗（显示升级命令 + 复制按钮）。mac 端若要捆绑运行时服务，需后续改造
      // plist/launcher 指向 resources/node-bin + userData 运行时（后置版本）。
      const oneClick = bundled && !isMac;
      console.log(`[dsh-shell] 发现 dsh 新版本 ${latest}（当前 ${current}，来源 ${resolved.kind}）`);
      if (interactive) {
        const { response } = await dialog.showMessageBox(oneClick ? {
          type: 'info',
          title: 'dsh 更新',
          message: `dsh ${latest} 已发布`,
          detail: `当前版本 ${current}。一键更新约需 1-3 分钟；更新后需重启 DSH 服务生效。`,
          buttons: ['立即更新', '稍后'],
          defaultId: 0,
          cancelId: 1,
        } : {
          type: 'info',
          title: 'dsh 更新',
          message: `dsh ${latest} 已发布`,
          detail: isMac
            ? `当前版本 ${current}。mac 服务由 launchd 托管（系统 dsh），请在终端手动升级：\n\nnpm i -g @deepseek-ai/dsh@latest`
            : `当前版本 ${current}。当前 dsh 来自${resolved.kind === 'env' ? ' DSH_BIN 环境变量' : '系统 PATH'}，请在终端手动升级：\n\nnpm i -g @deepseek-ai/dsh@latest`,
          buttons: ['复制升级命令', '稍后'],
          defaultId: 0,
          cancelId: 1,
        });
        if (response === 0) {
          if (oneClick) updateDsh(latest);
          else clipboard.writeText('npm i -g @deepseek-ai/dsh@latest');
        }
      } else if (Notification.isSupported()) {
        new Notification({ title: APP_TITLE, body: `dsh 有新版本 ${latest}（当前 ${current}），可从托盘菜单更新` }).show();
      }
    } else {
      console.log(`[dsh-shell] dsh 已是最新（${current}）`);
      if (interactive && Notification.isSupported()) {
        new Notification({ title: APP_TITLE, body: `dsh 已是最新版本（${current}）` }).show();
      }
    }
  } catch (err) {
    console.log('[dsh-shell] 检查 dsh 更新失败:', err.message);
    if (interactive && Notification.isSupported()) {
      new Notification({ title: APP_TITLE, body: '检查 dsh 更新失败（网络不可达？），请稍后重试' }).show();
    }
  } finally {
    updateCheckInFlight = false;
  }
}

// npm CLI 来源三级：包内捆绑（当前安装包不含，预留——若未来 CI 把 npm 打进 dsh-runtime 则直接用）→
// userData 缓存 → 从 npmmirror 下载 npm 压缩包现解现用（npm 为纯 JS，用捆绑 node 跑即可）。
// 版本固定 10.9.x：npm ≥12 要求 node ^22.22.2，捆绑 node v22.20.0 不满足；10.9.4 与 Node 22 同代。
// 供应链信任边界（P2-4 文档化）：npm CLI tgz 本身无 SRI 校验、下载即解压执行，信任
// npmmirror HTTPS + 固定版本 + 固定 host；dsh 包本体由 npm 自带 dist.integrity 校验。
const NPM_CLI_VERSION = '10.9.4';
const npmCliDir = () => path.join(app.getPath('userData'), 'npm-cli');

async function ensureNpmCli() {
  const bundledCli = path.join(resourcesRuntimeDir(), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(bundledCli)) return bundledCli;
  const cachedCli = path.join(npmCliDir(), 'package', 'bin', 'npm-cli.js'); // tarball 内顶层目录为 package/
  if (fs.existsSync(cachedCli)) return cachedCli;
  const url = `${DSH_REGISTRY}/npm/-/npm-${NPM_CLI_VERSION}.tgz`;
  console.log('[dsh-shell] 下载 npm CLI:', url);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000); // 30s 超时（tgz 约 3MB）
  let res;
  try { res = await session.defaultSession.fetch(url, { signal: ctrl.signal }); }
  finally { clearTimeout(t); }
  if (!res.ok) throw new Error('npm CLI 下载失败 HTTP ' + res.status);
  const tgz = path.join(app.getPath('temp'), `npm-${NPM_CLI_VERSION}.tgz`);
  fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
  fs.rmSync(npmCliDir(), { recursive: true, force: true });
  fs.mkdirSync(npmCliDir(), { recursive: true });
  // mac/linux 用系统 tar；Win10 1803+ 自带 bsdtar（System32\tar.exe，与 CI 准备步骤同款）
  const tar = isWin ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const r = await run(tar, ['-xzf', tgz, '-C', npmCliDir()]);
  try { fs.unlinkSync(tgz); } catch { /* 忽略 */ }
  if (r.code !== 0 || !fs.existsSync(cachedCli)) throw new Error('npm CLI 解压失败: ' + r.out.trim().slice(0, 200));
  return cachedCli;
}

function logTail(file, n = 5) {
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-n).join(' | ').slice(0, 300) || '（日志为空）';
  } catch { return '（无日志）'; }
}

// bundled 分支一键更新：用捆绑 node 跑 npm CLI 把 @deepseek-ai/dsh@latest 装进 userData 运行时。
// 不自动重启服务——更新完成后弹窗说明，用户托盘点「启动」或重启应用生效。
let dshUpdateInFlight = false;
async function updateDsh(latest) {
  if (dshUpdateInFlight) return;
  const resolved = resolveDsh();
  if (isMac || !resolved || !resolved.kind.startsWith('bundled')) return; // 仅非 mac 的 bundled 可一键更新（P1-2：mac 服务走 launchd 系统 dsh，装 userData 无效）
  dshUpdateInFlight = true;
  const notify = (body) => { if (Notification.isSupported()) new Notification({ title: APP_TITLE, body }).show(); };
  const logPath = path.join(logsDir(), 'dsh-update.log');
  try {
    notify('dsh 更新中…（约 1-3 分钟）');
    const npmCli = await ensureNpmCli();
    const nodeBin = path.join(process.resourcesPath, 'node-bin', isWin ? 'node.exe' : 'node');
    const target = runtimeDir(); // 更新落 userData 副本（resources 包内目录只读）
    const args = [npmCli, 'install', '--prefix', target, '@deepseek-ai/dsh@latest',
      '--no-audit', '--no-fund', `--registry=${DSH_REGISTRY}`];
    console.log('[dsh-shell] dsh 更新命令:', nodeBin, args.join(' '));
    const code = await new Promise((resolve) => {
      const fd = fs.openSync(logPath, 'a');
      fs.writeSync(fd, `\n===== dsh update ${new Date().toISOString()} → ${latest} =====\n`);
      // PATH 前置 node-bin：install 生命周期脚本（prebuild-install/node-gyp 等）须用捆绑 node
      // 执行，与 CI「准备捆绑运行时」步骤同思路
      const env = { ...process.env, PATH: path.dirname(nodeBin) + path.delimiter + (process.env.PATH || '') };
      const child = spawn(nodeBin, args, { env, windowsHide: true, stdio: ['ignore', fd, fd] });
      let done = false;
      const finish = (c) => { if (done) return; done = true; try { fs.closeSync(fd); } catch { /* 忽略 */ } resolve(c); };
      child.on('error', (err) => { try { fs.writeSync(fd, 'spawn error: ' + err.message + '\n'); } catch { /* 忽略 */ } finish(-1); });
      child.on('close', (c) => finish(c ?? -1));
    });
    if (code !== 0) throw new Error(`npm install 退出码 ${code}。日志尾部：${logTail(logPath)}`);
    // 完成后校验：--version 输出抽取版本号与 latest 精确相等（P2-5：子串 includes 会让
    // 0.12.0 误通过 0.12.0-rc.1；含 pre-release 后缀比较，必须全等）
    const verify = await run(nodeBin, [dshCliIn(target), '--version']);
    const got = verify.out.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
    if (!got || got[0] !== latest) {
      throw new Error(`更新后版本校验失败（期望 ${latest}，实得 ${got ? got[0] : (verify.out.trim().slice(0, 100) || '无输出')}）`);
    }
    console.log(`[dsh-shell] dsh 已更新至 ${latest}`);
    notify(`dsh 已更新至 ${latest}，重启服务后生效`);
    await dialog.showMessageBox({
      type: 'info',
      title: 'dsh 更新完成',
      message: `dsh 已更新至 ${latest}`,
      detail: '正在运行的服务仍是旧版本。Deck 不会自动重启服务：请通过托盘「停止 DSH 服务」→「启动 DSH 服务」，或重启应用后生效。',
      buttons: ['知道了'],
    });
  } catch (err) {
    console.error('[dsh-shell] dsh 更新失败:', err.message);
    notify('dsh 更新失败：' + String(err.message).slice(0, 180));
  } finally {
    dshUpdateInFlight = false;
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
    { label: '检查 dsh 更新…', click: () => checkDshUpdate(true) },
    { label: '检查 Deck 更新…', click: () => checkForUpdates(true) },
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
    // 运行时迁移改延迟执行（P2-2）：whenReady 不再无条件迁移，由 spawnDshChild 在
    // resolveDsh 落到 bundled-resources 兜底时触发（见 spawnDshChild）。
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
