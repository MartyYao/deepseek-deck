// preload.cjs — 沙箱化 preload（sandbox: true 下必须 CJS）。
// 只暴露只读壳信息；页面不依赖它，DSH 网页可完全忽略。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshShell', {
  getInfo: () => ipcRenderer.invoke('dsh-shell:info'),
  retry: () => ipcRenderer.send('dsh-shell:retry'),
  // 外观设置页专用（主进程侧 isTrustedSender 校验 + patch 白名单校验）
  getSettings: () => ipcRenderer.invoke('dsh-shell:settings-get'),
  setSettings: (patch) => ipcRenderer.send('dsh-shell:settings-set', patch),
});

// ── 外观强制：主进程经 dsh-shell:appearance-js 下发主题/zoom（v3.1 preload 通道）──
// preload 在页面上下文运行，无 executeJavaScript 的执行上下文销毁问题。仅主窗口
// DSH 页面会收到（主进程按 WEB_ORIGIN 过滤发送；设置页 file:// 不发送）。
// 一次性强制：页面 JS 后续手动切主题以页面为准，不拦截。
ipcRenderer.on('dsh-shell:appearance-js', (_e, payload) => {
  const apply = () => {
    try {
      if (!document.body) return;
      const p = payload && typeof payload === 'object' ? payload : {};
      if (p.theme === 'dark') {
        document.body.setAttribute('data-ds-dark-theme', '');
        document.documentElement.style.colorScheme = 'dark';
      } else if (p.theme === 'light') {
        document.body.removeAttribute('data-ds-dark-theme');
        document.documentElement.style.colorScheme = 'light';
      } else { // null：清除强制，交还页面自身主题
        document.body.removeAttribute('data-ds-dark-theme');
        document.documentElement.style.colorScheme = '';
      }
      // zoom 设到 <html>（2026-08-16 实测：页面 JS 初始化会清 body.style，html 的
      // zoom 不受影响——页面 JS 只按属性赋值 colorScheme，不动 html.style 的 zoom）
      document.documentElement.style.zoom = Number.isFinite(p.zoom) ? Math.round(p.zoom) + '%' : '';
    } catch { /* 忽略 */ }
  };
  // 收到时 body 可能尚未生成：等 DOMContentLoaded 后执行
  if (document.body) apply();
  else document.addEventListener('DOMContentLoaded', apply);
});

// ── 主题同步：观察 <html style="color-scheme">，IPC 通知主进程同步 nativeTheme ──
// DSH 页面主题切换会改 <html style="color-scheme: dark|light">（2026-08-16 实测：
// htmlAttr 含 style=color-scheme: dark;，body 背景 rgb(21,21,23)）。
// 若 DSH 未来改主题机制（如 class/data 属性），改 readColorScheme 一处即可。
function readColorScheme() {
  try {
    const el = document.documentElement;
    if (!el) return null;
    const inline = el.style && el.style.colorScheme;
    const v = inline || (window.getComputedStyle ? getComputedStyle(el).colorScheme : '');
    if (/\bdark\b/.test(v)) return 'dark';
    if (/\blight\b/.test(v)) return 'light';
    return null;
  } catch { return null; }
}

function reportTheme() {
  const theme = readColorScheme();
  if (theme) ipcRenderer.send('dsh-shell:theme', theme); // 取不到时静默不发
}

function attachThemeObserver() {
  const el = document.documentElement;
  if (!el) return false;
  // 初始立即发一次（页面加载完成时 html 已有 style）
  reportTheme();
  new MutationObserver(() => {
    // try/catch 容错：防 DSH 页面异常导致 preload 报错
    try { reportTheme(); } catch { /* 忽略 */ }
  }).observe(el, { attributes: true, attributeFilter: ['style'] });
  return true;
}

try {
  // preload 早于页面解析执行，documentElement 可能尚未生成：挂不上则等 DOMContentLoaded
  if (!attachThemeObserver()) {
    document.addEventListener('DOMContentLoaded', () => {
      try { attachThemeObserver(); } catch { /* 忽略 */ }
    });
  }
} catch { /* 静默 */ }
