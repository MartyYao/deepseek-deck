// preload.cjs — 沙箱化 preload（sandbox: true 下必须 CJS）。
// 只暴露只读壳信息；页面不依赖它，DSH 网页可完全忽略。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshShell', {
  getInfo: () => ipcRenderer.invoke('dsh-shell:info'),
  retry: () => ipcRenderer.send('dsh-shell:retry'),
});
