import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const packageInfo = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const releaseDir = path.join(rootDir, 'release');
const output = path.join(releaseDir, `Roomcast-${packageInfo.version}-source.zip`);
mkdirSync(releaseDir, { recursive: true });
if (existsSync(output)) rmSync(output, { force: true });

const status = spawnSync('git', ['status', '--porcelain'], { cwd: rootDir, encoding: 'utf8' });
if (status.status !== 0) throw new Error('无法读取 git 工作区状态');
if (status.stdout.trim() && !process.argv.includes('--allow-dirty')) {
  throw new Error('发布源码包要求工作区干净。请先提交所有发布改动，或使用 --allow-dirty 仅做本地检查。');
}

const result = spawnSync('git', [
  'archive',
  '--format=zip',
  `--prefix=Roomcast-${packageInfo.version}/`,
  `--output=${output}`,
  'HEAD',
], {
  cwd: rootDir,
  stdio: 'inherit',
  windowsHide: true,
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`git archive 失败：${result.status}`);
if (!existsSync(output)) throw new Error('源码 ZIP 未生成');
console.log(`[source] 已生成：${output}`);