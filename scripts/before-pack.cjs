const { spawn } = require('node:child_process');
const path = require('node:path');

exports.default = async function beforePack() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('Roomcast 当前发布目标仅支持 Windows x64；无法准备内置 OBS Runtime。');
  }
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
