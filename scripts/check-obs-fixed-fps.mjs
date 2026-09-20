import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { ObsFixedFpsEngine } = require('../electron/obs-fixed-fps.cjs');

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataRoot = path.join(rootDir, 'runtime', 'obs-test-data');
const args = new Map(process.argv.slice(2).map(value => {
  const match = value.match(/^--([^=]+)=(.*)$/);
  return match ? [match[1], match[2]] : [value.replace(/^--/, ''), 'true'];
}));
const width = Number(args.get('width') || 1920);
const height = Number(args.get('height') || 1080);
const fps = Number(args.get('fps') || 60);
const port = Number(args.get('port') || 4457);

if (process.platform !== 'win32') {
  console.error('[OBS fixed-fps] 此检查必须在 Windows 上运行。');
  process.exitCode = 1;
} else {
  const engine = new ObsFixedFpsEngine({ runtimeRoot: rootDir, dataRoot, port });
  try {
    console.log(`[OBS fixed-fps] 准备隔离 OBS：${width}x${height}@${fps} FPS`);
    const prepared = await engine.prepare();
    console.log(`[OBS fixed-fps] OBS 目录：${prepared.obsDir}`);
    console.log(`[OBS fixed-fps] 来源：Roomcast 内置 OBS ${prepared.version}（${prepared.copied ? '首次复制到隔离工作目录' : '隔离工作目录已存在'}）`);

    const launched = await engine.launch({ width, height, fps });
    console.log(`[OBS fixed-fps] 已连接 OBS ${launched.version || 'unknown'}`);
    console.log(`[OBS fixed-fps] OBS 实际视频设置：${launched.video.width}x${launched.video.height}@${launched.video.fpsNumerator}/${launched.video.fpsDenominator} FPS`);

    const sources = await engine.sources();
    console.log(`[OBS fixed-fps] 显示器：${sources.monitors.length} 个；窗口：${sources.windows.length} 个。`);
    console.log(JSON.stringify({ ok: true, status: launched, sources }, null, 2));
  } catch (error) {
    console.error(`[OBS fixed-fps] FAIL: ${error?.stack || error}`);
    process.exitCode = 1;
  } finally {
    await engine.close().catch(() => {});
  }
}
