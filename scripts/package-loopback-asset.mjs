import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { ensureLoopback, LOOPBACK_DIR } from './fetch-runtime.mjs';

const rootDir = process.cwd();
const packageInfo = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const releaseDir = path.join(rootDir, 'release');
const output = path.join(releaseDir, `Roomcast-${packageInfo.version}-loopback-capture.zip`);

await ensureLoopback({ checkOnly: true });
if (process.platform !== 'win32') {
  throw new Error('loopback 组件打包目前仅支持 Windows。');
}
mkdirSync(releaseDir, { recursive: true });
if (existsSync(output)) rmSync(output, { force: true });

function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

const command = `Compress-Archive -Path ${quote(path.join(LOOPBACK_DIR, '*'))} -DestinationPath ${quote(output)} -Force`;
const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Compress-Archive 失败：${result.status}`);
if (!existsSync(output)) throw new Error('loopback 组件 ZIP 未生成');
console.log(`[loopback] 已生成：${output}`);