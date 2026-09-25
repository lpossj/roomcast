const { spawn } = require('node:child_process');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Packaging leaves an `ns<random>.tmp` working directory (~0.5-1.2 GB) in %TEMP% whenever a
// build is interrupted. Clear the abandoned ones before starting another build so repeated
// packaging cannot quietly fill the disk. Cleanup must never fail the build.
async function cleanAbandonedBuildScratch() {
  try {
    const { cleanBuildScratch } = await import(pathToFileURL(path.join(__dirname, 'clean-build-scratch.mjs')).href);
    const result = cleanBuildScratch({ apply: true });
    if (result.removed.length) {
      console.log(`[build-scratch] 已清理 ${result.removed.length} 个残留打包临时目录，释放 ${(result.bytes / 1024 / 1024).toFixed(1)} MB。`);
    }
  } catch (error) {
    console.warn(`[build-scratch] 清理跳过：${error.message}`);
  }
}

exports.default = async function beforePack() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('Roomcast 当前发布目标仅支持 Windows x64；无法准备内置 OBS Runtime。');
  }
  await cleanAbandonedBuildScratch();
  for (const [name, args] of [
    ['fetch-web-invite.mjs', []],
    ['prepare-embedded-obs.mjs', ['--release']],
  ]) {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(__dirname, name), ...args], {
        cwd: path.resolve(__dirname, '..'),
        stdio: 'inherit',
        windowsHide: true,
      });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${name} 准备失败：${code}`)));
    });
  }
};
