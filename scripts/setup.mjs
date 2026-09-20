import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('当前桌面客户端面向 Windows x64。');
}

// Source archives intentionally omit runtime binaries. Fail before announcing a
// complete setup, and pin the disclosed prebuilt addon instead of fetching it blindly.
const loopbackFiles = [
  ['loopback_capture_addon.node', '23acf5f229c8e1fc5a70e4519def9d39e8ccd43b47912f364d8b81d93be5a50c'],
  ['LICENSE', '30085cfcb641f0712d2453402257cfa4d9badef164933954c35e4f6675801e1a'],
];
for (const [file, expected] of loopbackFiles) {
  const bytes = await readFile(path.join(rootDir, 'runtime', 'loopback-capture', file)).catch(() => null);
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== expected) {
    throw new Error('系统音频组件缺失或校验失败：' + file
      + '。请按 docs/LOOPBACK-CAPTURE-COMPLIANCE.md 从对应发布 ZIP 取得并校验组件，再运行 npm run setup。');
  }
}

try {
  await access(
    path.join(
      rootDir,
      'node_modules',
      'electron',
      'dist',
      'electron.exe',
    ),
  );
} catch {
  console.log('正在准备 Electron 桌面运行时…');

  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(
          rootDir,
          'node_modules',
          'electron',
          'install.js',
        ),
      ],
      {
        stdio: 'inherit',
        windowsHide: true,
      },
    );

    child.on('error', reject);

    child.on(
      'exit',
      code =>
        code === 0
          ? resolve()
          : reject(
            new Error(
              'Electron 下载失败',
            ),
          ),
    );
  });
}

console.log('Electron 与系统音频组件已就绪。源码环境如需 OBS 采集，请运行 npm run prepare:obs。');
