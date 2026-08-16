// dsh-shell app — Electron 主进程（v0.14.0, 2026-08-16；win/linux 全自动更新版）
// v0.14.0：win/linux Deck 自身更新改全自动（electron-updater + generic provider：
//         下载→弹窗确认→重启安装）；mac 保持 atom 检测 + 手动下载引导（自动更新需
//         Apple 签名证书，暂不引入）。generic provider 指向 releases/latest/download
//         （github.com 域名国内可达；默认 GitHub provider 走 api.github.com 必失败）。
// v0.12.0：dsh 更新检测 + 一键更新（bundled 运行时首启迁 userData，包内 Resources 只读不可写）；
//         Deck 更新引导增强（弹窗「下载并安装」→ 下载对应平台安装包）。
// 未发版累积（2026-08-16）：外观设置 v2——整板换肤（覆盖 --dsw-static-neutral-bluish-* 19 级）、
//         字号改 Chromium zoom、标题栏联动 nativeTheme、DSH_SHELL_DEBUG 调试端口。
// 独立桌面壳（Windows / macOS / Linux）：加载 http://127.0.0.1:3080 的 dsh web。
// 服务托管按平台分支：
//   - macOS：launchd 托管（TCC 红线：责任进程 = node 二进制，壳只发 launchctl 命令，
//     不直接 spawn dsh；iCloud vault 长期记忆授权链路不受影响）。行为与 v0.1.1 完全一致。
//   - Windows / Linux：壳直接 spawn `dsh web` 子进程，随壳退出自动终止（防孤儿），
//     stdout/stderr 追加写入 userData/logs/dsh-web.log 便于排障。
//     dsh 来源三级查找（resolveDsh）：DSH_BIN 覆盖 → PATH 系统版 → 安装包捆绑运行时
//     （resources/node-bin/node + resources/dsh-runtime 内预装的 @deepseek-ai/dsh，免安装）。
// 与 DSH 更新解耦：壳只依赖稳定 HTTP 表面（web UI + /api），不 import 任何 DSH 包。

import { app, BrowserWindow, Tray, Menu, shell, session, dialog, clipboard, Notification, ipcMain, nativeImage, nativeTheme, screen } from 'electron';
import { execFile, spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

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

// 调试端口（仅调试用，README 不宣传）：DSH_SHELL_DEBUG=1 启动时开启 Chromium 远程调试
// （http://127.0.0.1:9222），用于获取实机 DOM 类名——DSH 前端为 CSS modules 哈希类名，
// 下一步侧边栏/气泡独立调节需锁定当前 dsh 版本实测类名。
// 安全影响：开启后本机任意进程可连接调试端口读取/操控页面——仅限本机、仅调试期使用。
if (process.env.DSH_SHELL_DEBUG) app.commandLine.appendSwitch('remote-debugging-port', '9222');

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

// ── 外观设置（背景配色 / 字体颜色 / 字号）─────────────────────────────────
// 方案：壳注入 CSS 覆盖 DSH 语义变量（webContents.insertCSS，不受 CSP 限制，不碰 dsh）。
// 存储：userData/settings.json（无则默认 {}，读失败按空处理）。
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// 预设配色表（深色基调，与官方深色主题协调；单源——设置页经 settings-get 的返回拿到此表）。
// v2 起预设只存 base 主色，整板 19 级由 generatePalette 实时生成；预设只管背景，文字色独立设置。
const APPEARANCE_PRESETS = {
  deepblue: { label: '深空蓝', base: '#0d1b2a' },
  forest: { label: '墨绿', base: '#0f1f17' },
  warmbrown: { label: '暖棕', base: '#1f1712' },
  violet: { label: '紫罗兰', base: '#17122b' },
  graphite: { label: '石墨', base: '#1c1c1e' },
};

// ── 整板生成（纯 JS 无依赖）：base 主色 → --dsw-static-neutral-bluish-* 全 19 级 ──
// DSH 组件大量直接引用 static 色板（100+ 处），只覆盖 alias（15 处）换肤不生效，必须整板覆盖。
// 亮度模板取官方灰阶每级亮度；500 为锚点（= base 亮度），浅色端线性升到 97%、深色端线性降到 6%。
function hexToHsl(hex) {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex || '');
  if (!m) return null;
  const r = parseInt(m[1], 16) / 255, g = parseInt(m[2], 16) / 255, b = parseInt(m[3], 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  const d = max - min;
  if (d > 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h, s: s * 100, l: l * 100 };
}

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r, g, b;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return '#' + to(r) + to(g) + to(b);
}

const PALETTE_LEVELS = [
  ['00', 97], ['50', 95], ['60', 93], ['75', 91], ['100', 89], ['150', 87],
  ['200', 84], ['300', 78], ['400', 66], ['500', 58], ['600', 48], ['700', 37],
  ['750', 26], ['800', 20], ['850', 16], ['875', 13], ['900', 10], ['950', 8], ['1000', 5],
];

// 非法输入回退：返回 null（调用方不注入）。base 亮度钳制到 [8,95]，保证两端斜坡单调。
function generatePalette(baseHex) {
  const hsl = hexToHsl(baseHex);
  if (!hsl) return null;
  const baseL = Math.min(95, Math.max(8, hsl.l));
  const out = {};
  for (const [level, t] of PALETTE_LEVELS) {
    let l;
    if (t > 58) l = baseL + (97 - baseL) * ((t - 58) / 39);   // 浅色端：升到 97%
    else if (t < 58) l = 6 + (baseL - 6) * ((t - 5) / 53);    // 深色端：降到 6%
    else l = baseL;                                           // 500 锚点 = base 亮度
    // 色相保持；两端微降饱和（最多 -12%）防艳，中段保持 base 饱和
    const satScale = 1 - 0.12 * Math.min(1, Math.abs(t - 58) / 53);
    out[level] = hslToHex(hsl.h, hsl.s * satScale, l);
  }
  return out;
}

function readSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return s && typeof s === 'object' ? s : {};
  } catch { return {}; } // 文件不存在/损坏均按空设置处理
}

// 原子写：tmp + rename，防中途崩溃留半截 JSON
function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  const file = settingsFile();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, file);
  return next;
}

// 由设置生成注入 CSS。v2 整板换肤：覆盖 --dsw-static-neutral-bluish-* 全 19 级，
// 选择器 `body, body[data-ds-dark-theme]`——深色主题变量定义在 body[data-ds-dark-theme]
// （特异性 0,1,1），单 body 选择器在深色下被打败，必须两套都覆盖，全部 !important。
// 注：注入固定值会同时覆盖官方深浅两套变量（用户自定义外观即固定），属预期行为；
// DSH 升级后若变量名变化，注入的自定义属性无人引用即自然失效，不报错。
function generateAppearanceCss(settings) {
  const a = settings && settings.appearance;
  if (!a || typeof a !== 'object') return '';
  const rules = [];
  const SEL = 'body, body[data-ds-dark-theme]';
  // 背景：preset/custom 都由 base 色生成整板；default 不生成（恢复默认 = 不注入）
  let palette = null;
  if (a.bg && a.bg.mode === 'preset' && APPEARANCE_PRESETS[a.bg.preset]) {
    palette = generatePalette(APPEARANCE_PRESETS[a.bg.preset].base);
  } else if (a.bg && a.bg.mode === 'custom' && COLOR_RE.test(a.bg.custom || '')) {
    palette = generatePalette(a.bg.custom);
  }
  if (palette) {
    const decl = PALETTE_LEVELS.map(([level]) => `--dsw-static-neutral-bluish-${level}:${palette[level]} !important`).join(';');
    rules.push(`${SEL}{${decl}}`);
    // alias 分主题映射（v3 修复：浅色 base 时深色端映射导致深底深字）。深色主题页取
    // 深色端（官方映射：bg-base=950、layer-1=875、layer-2=850、layer-3=800），
    // 浅色主题页取浅色端（00/50/60/75），保证经 alias 取色的组件与整板一致
    rules.push(`body[data-ds-dark-theme]{--dsw-alias-bg-base:${palette['950']} !important;--dsw-alias-bg-layer-1:${palette['875']} !important;--dsw-alias-bg-layer-2:${palette['850']} !important;--dsw-alias-bg-layer-3:${palette['800']} !important}`);
    rules.push(`body:not([data-ds-dark-theme]){--dsw-alias-bg-base:${palette['00']} !important;--dsw-alias-bg-layer-1:${palette['50']} !important;--dsw-alias-bg-layer-2:${palette['60']} !important;--dsw-alias-bg-layer-3:${palette['75']} !important}`);
  }
  // 文字：custom 时 primary 自定义，dimmed/caption 用 color-mix 派生；default 不生成
  if (a.label && a.label.mode === 'custom' && COLOR_RE.test(a.label.custom || '')) {
    const c = a.label.custom;
    rules.push(`body{--dsw-alias-label-primary:${c} !important;--dsw-alias-label-dimmed:color-mix(in srgb,${c} 70%,transparent) !important;--dsw-alias-label-caption:color-mix(in srgb,${c} 55%,transparent) !important}`);
  }
  // 侧边栏独立背景：custom 时叠加覆盖（侧边栏已随整板变色，此为独立调节）。
  // 锁 dsh 0.1.0-rc.6：侧边栏容器为 CSS modules 哈希类名（实测 `pI_x6G_sidebarCol`），
  // 用后缀匹配 [class$="_sidebarCol"] 防前缀随机变化；DSH 前端升级需重新适配。
  if (a.sidebar && a.sidebar.mode === 'custom' && COLOR_RE.test(a.sidebar.custom || '')) {
    rules.push(`[class$="_sidebarCol"]{background-color:${a.sidebar.custom} !important}`);
  }
  // 消息气泡独立调节（v3.1）：气泡背景不走 neutral-bluish 整板（官方为品牌蓝
  // rgb(237,243,254)，整板覆盖不到），浅底近白字看不清，需单独覆盖。
  // 锁 dsh 0.1.0-rc.6：气泡为 CSS modules 哈希类名（实测 `gdEzaW_bubble`），后缀匹配
  // [class$="_bubble"] 防前缀随机变化；DSH 前端升级需重新适配。
  if (a.bubble && a.bubble.mode === 'follow') {
    // 气泡随主题色系：背景取 alias layer-1（深浅主题各取对应端），文字随主题
    rules.push(`[class$="_bubble"]{background-color:var(--dsw-alias-bg-layer-1) !important;color:var(--dsw-alias-label-primary) !important}`);
  } else if (a.bubble && a.bubble.mode === 'custom' && COLOR_RE.test(a.bubble.custom || '')) {
    // 自定义色 + 文字自动对比度：背景亮度 < 50% → 白字，≥50% → 深字
    const hsl = hexToHsl(a.bubble.custom);
    const txt = hsl && hsl.l < 50 ? '#f5f5f5' : '#1c1c1e';
    rules.push(`[class$="_bubble"]{background-color:${a.bubble.custom} !important;color:${txt} !important}`);
  }
  // default：不生成气泡规则（官方原样）
  // 字号缩放走 applyAppearanceCss 的 preload 通道（ipc send → preload 内联
  // body.style.zoom）——insertCSS（Blink inspector 样式表）对非标准属性 zoom 无效，
  // 故此处不再生成 zoom 规则
  return rules.join('\n');
}

// 标题栏联动判定：外观背景为深色系 → 'dark'，浅色系 → 'light'，无外观背景设置 → null
// （交还 system / 页面上报）。预设均为深色系；custom 按 base 亮度 < 50% 判深。
function appearanceTheme(settings) {
  const a = settings && settings.appearance;
  if (!a || !a.bg || typeof a.bg !== 'object') return null;
  if (a.bg.mode === 'preset' && APPEARANCE_PRESETS[a.bg.preset]) return 'dark';
  if (a.bg.mode === 'custom' && COLOR_RE.test(a.bg.custom || '')) {
    const hsl = hexToHsl(a.bg.custom);
    return hsl && hsl.l < 50 ? 'dark' : 'light';
  }
  return null;
}

// 注入管理：记录上次 insertCSS 返回的 key，重注入前先 removeInsertedCSS。
// 坑（2026-08-16 实测）：Electron insertCSS 的样式在作者样式表最前（优先级最低），
// 同选择器规则会被页面样式覆盖——变量规则必须 !important 才能生效。
// insertedCSS 随页面导航清除，故 did-finish-load 后需重注入。仅对主窗口的 DSH 页面
// 注入（loading/error 本地页不注入），设置窗口不注入。
let appearanceCssKey = null;
// 是否曾对页面强制过主题/zoom（preload 通道是发送即忘，无法像 insertCSS 一样按键移除，
// 恢复默认时需以清除负载收尾；纯默认用户不发送，避免剥掉页面自身主题）
let appearanceJsForced = false;
async function applyAppearanceCss(win) {
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  if (appearanceCssKey) {
    try { await wc.removeInsertedCSS(appearanceCssKey); } catch { /* 页面已导航旧 key 失效，忽略 */ }
    appearanceCssKey = null;
  }
  const settings = readSettings();
  // 标题栏联动：外观背景决定 nativeTheme.themeSource（mac 标题栏 + loading/error 页的
  // prefers-color-scheme 同步）；无外观背景 → 'system'，交还页面 color-scheme 上报
  // （preload 观察器继续工作）。优先级：外观设置存在时以外观决定（theme IPC 侧有守卫）。
  const theme = appearanceTheme(settings);
  // 标题栏（nativeTheme）完全跟随页面实际 colorScheme（preload 观察器上报）：
  // 外观设置只强制页面 data-ds-dark-theme/colorScheme（下方 preload 通道），页面
  // colorScheme 变化即触发上报 → 标题栏/窗口背景跟随页面——页面深色标题栏必深色，
  // 用户手动切页面主题也实时跟随（2026-08-16：移除外观锁死 themeSource 的设计，
  // 原设计导致页面深色时标题栏仍浅色）。
  if (!wc.getURL().startsWith(WEB_ORIGIN)) return;
  // 主题强制 + zoom 内联（v3.1 改 preload 通道）：insertCSS（Blink inspector 样式表）
  // 对非标准属性 zoom 无效，zoom 必须内联 body.style.zoom；executeJavaScript 在
  // did-finish-load 后立即执行时机不可靠（页面 JS 初始化期间执行上下文被销毁，
  // "Execution context was destroyed" 异常被吞掉后无重试，zoom 没设上——2026-08-16
  // CDP 实测定位）。改经 webContents.send 发 preload 通道：preload 在页面上下文运行，
  // 收到后等 document.body 就绪再执行，无 context 问题。主题也一并强制——外观激活时
  // 令页面主题与外观一致（深色 base → data-ds-dark-theme，浅色 → 移除），恢复默认
  // （无外观背景）时清除。均为一次性强制：页面 JS 后续手动切主题以页面为准，不拦截。
  // 注：colorScheme 置 '' 时 preload 观察器读不到值静默不发，页面随后自报主题恢复同步。
  const pct = Number(settings && settings.appearance && settings.appearance.fontSize);
  const zoom = Number.isFinite(pct) && pct !== 100 ? Math.round(pct) : null;
  const needForce = theme !== null || zoom !== null;
  // 纯默认用户（从未设置外观）不动页面属性——否则每次 did-finish-load 都会剥掉
  // 页面自己的 data-ds-dark-theme；仅在外观激活或之前强制过（恢复默认需清除）时发送
  if (needForce || appearanceJsForced) {
    wc.send('dsh-shell:appearance-js', { theme, zoom });
    appearanceJsForced = needForce;
  }
  const css = generateAppearanceCss(settings);
  if (!css) return;
  try { appearanceCssKey = await wc.insertCSS(css); } catch { /* 注入失败不影响页面 */ }
}

// 设置窗口（单例：已开则 focus；关闭即销毁）
let settingsWindow = null;
function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    title: '外观设置',
    width: 480,
    height: 620,
    minWidth: 420,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    icon: ASSETS(isMac ? 'icon.icns' : (isWin ? 'icon.ico' : 'icon.png')),
    webPreferences: { // 同主窗口安全基线；设置页经 dshShell bridge 走 settings IPC
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  settingsWindow.loadFile(ASSETS('settings.html'));
  settingsWindow.once('ready-to-show', () => { if (settingsWindow) settingsWindow.show(); });
  settingsWindow.on('closed', () => { settingsWindow = null; });
  settingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // 导航守卫沿用主窗口策略：本地 file:// 放行，其余一律拦截
  settingsWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) e.preventDefault();
  });
}

// settings-set 的 patch 白名单校验：只接受 appearance 下已知字段；颜色严格正则、
// preset 名枚举校验、fontSize 数字钳制 90-130——注入 CSS 的内容来自设置，必须防注入。
function sanitizeAppearance(input) {
  if (!input || typeof input !== 'object') return null;
  const out = {};
  if (input.bg && typeof input.bg === 'object') {
    const bg = input.bg;
    out.bg = {
      mode: ['preset', 'custom', 'default'].includes(bg.mode) ? bg.mode : 'default',
      preset: typeof bg.preset === 'string' && APPEARANCE_PRESETS[bg.preset] ? bg.preset : 'deepblue',
      custom: COLOR_RE.test(bg.custom || '') ? bg.custom : '#0d1b2a',
    };
  }
  if (input.label && typeof input.label === 'object') {
    const label = input.label;
    out.label = {
      mode: label.mode === 'custom' ? 'custom' : 'default',
      custom: COLOR_RE.test(label.custom || '') ? label.custom : '#e6e6e6',
    };
  }
  if (input.sidebar && typeof input.sidebar === 'object') {
    const sidebar = input.sidebar;
    out.sidebar = {
      // follow=跟随背景整板（默认）；custom=独立色；default=官方原样
      mode: ['follow', 'custom', 'default'].includes(sidebar.mode) ? sidebar.mode : 'follow',
      custom: COLOR_RE.test(sidebar.custom || '') ? sidebar.custom : '#1c1c1e',
    };
  }
  if (input.bubble && typeof input.bubble === 'object') {
    const bubble = input.bubble;
    out.bubble = {
      // follow=气泡随主题色系（默认）；custom=独立色+自动对比度文字；default=官方原样
      mode: ['follow', 'custom', 'default'].includes(bubble.mode) ? bubble.mode : 'follow',
      custom: COLOR_RE.test(bubble.custom || '') ? bubble.custom : '#e8ecf4',
    };
  }
  if (input.fontSize !== undefined) {
    const n = Number(input.fontSize);
    if (Number.isFinite(n)) out.fontSize = Math.min(130, Math.max(90, Math.round(n)));
  }
  return out;
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
  mainWindow.webContents.on('did-finish-load', () => {
    loadFailures = 0;
    applyAppearanceCss(mainWindow); // insertedCSS 随导航清除，每次加载完成需重注入
  });

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

// ── Deck 自动更新（electron-updater + generic provider，仅 win/linux）────────────
// mac 不引入（自动更新需 Apple 签名证书）——保持下方 atom 检测 + 手动下载引导不变。
// generic provider 指向 releases/latest/download（app-update.yml 由 electron-builder
// 打包时按 package.json build.publish 写入）：GitHub latest-release 资产永久重定向，
// 走 github.com 域名国内可达；默认 GitHub provider 走 api.github.com（国内被分流拦截）。
// electron-updater 为 CJS 包（main.js 是 ESM），经 createRequire 加载；且仅 win/linux
// packaged 才 require——开发模式（npm start）无 app-update.yml 会报错，跳过。
// win 请求 <url>/latest.yml，linux 请求 <url>/latest-linux.yml（CI release.yml 会上传）。
let autoUpdater = null;
let updaterManualCheck = false; // 手动检查标记：update-not-available/error 仅手动时提示，静默检查只记日志
let lastProgressPct = -1;   // 下载进度节流：上次已提示的百分比档位（P1-1）
let lastProgressAt = 0;     // 下载进度节流：上次提示时间戳（P1-1）
const updaterLog = (...args) => console.log('[dsh-shell][updater]', ...args);
const updaterNotify = (body) => { if (Notification.isSupported()) new Notification({ title: APP_TITLE, body }).show(); };

// Linux 安装包类型（P1-2）：electron-builder 打包时写入 resources/package-type，
// 内容 'deb' / 'AppImage'；读不到（win/mac/开发模式）返回 null。
// deb 安装走 DebUpdater，而 latest-linux.yml 只含 AppImage 项 → 必失败，需整条路径跳过。
function linuxPackageType() {
  if (process.platform !== 'linux' || !app.isPackaged) return null;
  try {
    return fs.readFileSync(path.join(process.resourcesPath, 'package-type'), 'utf8').trim();
  } catch {
    return null;
  }
}

function initAutoUpdater() {
  if (isMac || !app.isPackaged) return;
  if (linuxPackageType() === 'deb') { // P1-2：deb 不支持自动更新，不初始化（启动静默检查随 autoUpdater=null 一并跳过）
    updaterLog('deb 安装，跳过自动更新初始化');
    return;
  }
  try {
    const require = createRequire(import.meta.url);
    autoUpdater = require('electron-updater').autoUpdater;
  } catch (err) {
    updaterLog('electron-updater 加载失败（跳过自动更新）:', err.message);
    return;
  }
  autoUpdater.autoDownload = true;          // 发现新版即下载
  autoUpdater.autoInstallOnAppQuit = true;  // 退出时若有已下载更新则安装（quitAndInstall 双保险）

  autoUpdater.on('update-available', (info) => {
    updaterLog('发现新版本:', info.version);
    updaterNotify(`发现新版本 v${info.version}，正在下载…`);
  });
  autoUpdater.on('update-not-available', (info) => {
    updaterLog('已是最新版本:', info && info.version);
    if (updaterManualCheck) {
      updaterManualCheck = false;
      updaterNotify(`已是最新版本（v${app.getVersion()}）`);
    }
  });
  autoUpdater.on('download-progress', (p) => {
    updaterLog(`下载进度 ${Math.round(p.percent)}%（${Math.round((p.bytesPerSecond || 0) / 1024)} KB/s）`);
    // P1-1：全量下载 5-15 分钟零反馈，加节流通知——每跨 25% 档或距上次 ≥30s（先到者）提示一次；
    // 100% 不提示（终点由 update-downloaded 负责）
    const pct = Math.round(p.percent);
    if (pct >= 100) return;
    const now = Date.now();
    if (Math.floor(pct / 25) > Math.floor(lastProgressPct / 25) || now - lastProgressAt >= 30000) {
      lastProgressPct = pct;
      lastProgressAt = now;
      const mbps = ((p.bytesPerSecond || 0) / 1024 / 1024).toFixed(1);
      updaterNotify(`正在下载更新：${pct}%（${mbps} MB/s）`);
    }
  });
  autoUpdater.on('update-downloaded', async (info) => {
    updaterLog('更新已下载完成:', info.version);
    updaterNotify(`新版本 v${info.version} 已下载完成`);
    try {
      const { response } = await dialog.showMessageBox({
        type: 'info',
        title: '更新已就绪',
        message: `DeepSeek Deck v${info.version} 已下载完成`,
        detail: '重启应用完成安装（Windows NSIS 静默覆盖安装；Linux AppImage 直接替换）。',
        buttons: ['立即重启安装', '稍后'],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) {
        isQuitting = true;
        autoUpdater.quitAndInstall();
      }
    } catch (err) {
      updaterLog('更新安装弹窗失败:', err.message);
    }
  });
  autoUpdater.on('error', (err) => {
    updaterLog('更新错误:', err && err.message);
    if (updaterManualCheck) {
      updaterManualCheck = false;
      updaterNotify('检查更新失败，可到 Releases 页手动下载');
    }
  });
}

// 托盘「检查 Deck 更新…」分流：mac → atom 引导（不变）；win/linux → electron-updater。
// checkForUpdates 返回 promise：失败经 error 事件提示，catch 内按手动标记补提示（防 promise 直接
// reject 而未触发 error 事件时零反馈）。
function checkDeckUpdateInteractive() {
  if (isMac) { checkForUpdates(true); return; }
  updaterManualCheck = false; // P2-2 卫生项：开头先复位，防上次残留标记造成重复提示
  if (linuxPackageType() === 'deb') { // P1-2：deb 安装不支持自动更新，明确引导而非报「检查失败」
    updaterNotify('当前为 deb 安装，暂不支持自动更新，请到 Releases 页手动下载');
    return;
  }
  if (!autoUpdater) { // 开发模式（npm start）无 app-update.yml，自动更新不可用
    updaterNotify('开发模式下不支持自动更新，请使用安装版或到 Releases 页手动下载');
    return;
  }
  updaterManualCheck = true;
  autoUpdater.checkForUpdates().catch((err) => {
    updaterLog('手动检查更新失败:', err && err.message);
    if (updaterManualCheck) { // P1-2：手动检查合并进已失败/空响应检查时，catch 也要给用户反馈
      updaterManualCheck = false;
      updaterNotify('检查更新失败，可到 Releases 页手动下载');
    }
  });
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
    { label: '外观设置…', click: openSettingsWindow },
    { type: 'separator' },
    { label: '启动 DSH 服务', click: async () => { await startService(); await refreshTrayStatus(); } },
    { label: '停止 DSH 服务', click: async () => { await stopService(); await refreshTrayStatus(); } },
    { label: '在浏览器中打开', click: () => shell.openExternal(WEB_URL) },
    { type: 'separator' },
    loginItemMenuItem(),
    { label: '检查 dsh 更新…', click: () => checkDshUpdate(true) },
    { label: '检查 Deck 更新…', click: () => checkDeckUpdateInteractive() },
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
  // macOS：不绑 click（左键点击默认弹出菜单，原生 NSStatusBar 行为）；
  // win/linux：左键 toggle 窗口、右键菜单（平台惯例）。
  if (!isMac) tray.on('click', toggleWindow);
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

    // Deck 自动更新（仅 win/linux packaged）：初始化事件绑定，启动 15s 后静默检查一次
    // （失败静默只记日志，不打扰用户；手动检查走托盘菜单）
    initAutoUpdater();
    if (autoUpdater) {
      setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 15000);
    }

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
// 外观设置 IPC（设置页专用；均经 isTrustedSender 校验）
ipcMain.handle('dsh-shell:settings-get', (event) => {
  if (!isTrustedSender(event)) return null;
  // 预设表单源在 main.js，随返回带给设置页渲染色卡
  return { settings: readSettings(), presets: APPEARANCE_PRESETS };
});
ipcMain.on('dsh-shell:settings-set', (event, patch) => {
  if (!isTrustedSender(event)) return;
  const appearance = sanitizeAppearance(patch && patch.appearance);
  if (!appearance) return;
  writeSettings({ appearance });
  applyAppearanceCss(mainWindow); // 立即生效：重新注入主窗口
});

// 标题栏主题同步（v0.12.x）：preload 观察 DSH 页面 <html style="color-scheme"> 变化上报。
// macOS 标题栏颜色跟随 nativeTheme.themeSource；此同步让壳 UI（标题栏/loading/error 页
// 的 prefers-color-scheme 适配）与 DSH 页面主题一致。启动时 themeSource 保持默认 'system'
// 不变——页面加载后 preload 会立刻上报一次实际主题并覆盖。null/未知值忽略。
let lastShellTheme = null;
ipcMain.on('dsh-shell:theme', (event, theme) => {
  if (!isTrustedSender(event)) return;
  if (theme !== 'dark' && theme !== 'light') return;
  // 标题栏始终跟随页面实际主题（2026-08-16：移除外观存在时忽略上报的守卫——外观
  // 设置通过强制页面 colorScheme 间接驱动标题栏，页面手动切主题也实时跟随）
  nativeTheme.themeSource = theme;
  // 窗口背景与页面背景一致（深色 #151517），避免缩放/过渡时白闪
  if (mainWindow) mainWindow.setBackgroundColor(theme === 'dark' ? '#151517' : '#ffffff');
  if (theme !== lastShellTheme) { // 去重：仅在切换时打一次日志，不刷屏
    lastShellTheme = theme;
    console.log('[dsh-shell] 页面主题切换:', theme);
  }
});
