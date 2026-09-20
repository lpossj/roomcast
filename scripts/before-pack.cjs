const { spawn } = require('node:child_process');
const path = require('node:path');

exports.default = async function beforePack() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('Roomcast 当前发布目标仅支持 Windows x64；无法准备内置 OBS Runtime。');
  }
  const script = path.join(__dirname, 'prepare-embedded-obs.mjs');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, '--release'], {
      cwd: path.resolve(__dirname, '..'),
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`内置 OBS 准备失败：${code}`)));
  });
};
