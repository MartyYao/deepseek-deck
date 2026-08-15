// afterPack 钩子：把捆绑运行时（dsh-runtime）复制进打包后的 app。
// 运行环境要求 Node ≥18.17（fs.readdirSync 的 recursive 选项自 18.17 起可用；CI 用 Node 22）。
// 原因：electron-builder 的 extraResources 对包含 node_modules 的目录会静默排除
// （实测 v26.15.3：extraResources 里的 node_modules 不进包，filter/exclude 均无效），
// 故改用 afterPack 手动复制，绕过其过滤逻辑。node-bin 无 node_modules，走 extraResources。
// 2026-08-15 踩坑记录（Obsidian: Agent/环境/dsh-shell 桌面壳.md）
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  const { appOutDir, packager, electronPlatformName } = context;
  const src = path.join(packager.info.projectDir, 'resources', 'dsh-runtime');

  // 资源根：darwin 是 <app>/Contents/Resources，win32/linux 是 <app>/resources。
  // dir target 的 appOutDir 可能是外层目录（mac：dist/mac-arm64），.app 产物在其下。
  let appRoot = appOutDir;
  const resourceSub = electronPlatformName === 'darwin' ? path.join('Contents', 'Resources') : 'resources';
  if (!fs.existsSync(path.join(appRoot, resourceSub))) {
    const apps = fs.readdirSync(appOutDir).filter((d) => d.endsWith('.app'));
    if (apps.length > 0) appRoot = path.join(appOutDir, apps[0]);
  }
  const dest = path.join(appRoot, resourceSub, 'dsh-runtime');

  if (!fs.existsSync(src)) {
    console.warn('[afterPack] resources/dsh-runtime 不存在，跳过（开发模式或未准备运行时）');
    return;
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true, dereference: false });
  const count = fs.readdirSync(dest, { recursive: true }).length;
  console.log(`[afterPack] dsh-runtime 已复制: ${dest} (${count} 条目)`);
};
