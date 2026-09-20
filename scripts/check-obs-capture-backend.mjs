import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs/promises';

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
const type = args.has('window') ? 'window' : 'monitor';
const index = Math.max(0, Number(args.get(type) || 0));
const holdSeconds = Math.max(2, Math.min(30, Number(args.get('seconds') || 6)));
const virtualCamRequested = args.get('virtual-cam') === 'true';
const screenshotPath = path.join(dataRoot, 'obs-capture-check.png');

if (process.platform !== 'win32') {
  console.error('[OBS capture-backend] 此检查必须在 Windows 上运行。');
  process.exitCode = 1;
} else {
  const engine = new ObsFixedFpsEngine({ runtimeRoot: rootDir, dataRoot, port });
  try {
    console.log(`[OBS capture-backend] 启动：${width}x${height}@${fps} FPS`);
    const launched = await engine.launch({ width, height, fps });
    console.log(`[OBS capture-backend] 已连接 OBS ${launched.version || 'unknown'}`);

    const sources = await engine.sources();
    const list = type === 'monitor' ? sources.monitors : sources.windows;
    if (!list.length) throw new Error(`没有可用的${type === 'monitor' ? '显示器' : '窗口'}。`);
    if (!Number.isInteger(index) || index >= list.length) throw new Error(`索引 ${index} 无效；当前只有 ${list.length} 个${type === 'monitor' ? '显示器' : '窗口'}。`);
    const chosen = list[index];
    console.log(`[OBS capture-backend] 选择${type === 'monitor' ? '显示器' : '窗口'} #${index}: ${chosen.name}`);

    const capture = await engine.selectSource({ type, id: chosen.id, cursor: true, clientArea: true });
    console.log(`[OBS capture-backend] 已创建采集输入：${capture.name}`);

    await delay(1200);
    const screenshot = await engine.captureScreenshot({ width: Math.min(width, 1280) });
    await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
    await fs.writeFile(screenshotPath, screenshot.bytes);
    console.log(`[OBS capture-backend] 已验证真实采集并保存截图：${screenshotPath} (${screenshot.byteLength} bytes)`);

    if (virtualCamRequested) {
      await engine.startVirtualCamera();
      console.log('[OBS capture-backend] Virtual Camera 已启动（显式 --virtual-cam=true）。');
    } else {
      console.log('[OBS capture-backend] 本轮不启动 Virtual Camera；仅验收内置 OBS 抓屏与固定渲染帧率。');
    }

    const samples = [];
    const started = Date.now();
    while (Date.now() - started < holdSeconds * 1000) {
      await delay(1000);
      const stats = await engine.stats();
      samples.push(stats);
      console.log(`[OBS capture-backend] activeFps=${stats.activeFps.toFixed(2)} renderSkipped=${stats.renderSkippedFrames}/${stats.renderTotalFrames} outputSkipped=${stats.outputSkippedFrames}/${stats.outputTotalFrames}`);
    }

    const status = await engine.status();
    const stableSamples = samples.filter(sample => sample.activeFps > 0);
    const averageActiveFps = stableSamples.length
      ? stableSamples.reduce((sum, sample) => sum + sample.activeFps, 0) / stableSamples.length
      : 0;
    const tolerance = Math.max(1.5, fps * 0.05);
    if (virtualCamRequested && !status.virtualCamActive) throw new Error('Virtual Camera 在验收结束前意外停止。');
    if (!virtualCamRequested && status.virtualCamActive) throw new Error('本轮未请求 Virtual Camera，但其意外处于活动状态。');
    if (!stableSamples.length || Math.abs(averageActiveFps - fps) > tolerance) {
      throw new Error(`OBS 实际渲染帧率未稳定在 ${fps} FPS：平均 ${averageActiveFps.toFixed(2)} FPS。`);
    }

    console.log(JSON.stringify({
      ok: true,
      target: { width, height, fps },
      selected: capture,
      screenshot: { path: screenshotPath, byteLength: screenshot.byteLength },
      virtualCamRequested,
      averageActiveFps: Number(averageActiveFps.toFixed(3)),
      status,
      samples,
    }, null, 2));
  } catch (error) {
    console.error(`[OBS capture-backend] FAIL: ${error?.stack || error}`);
    process.exitCode = 1;
  } finally {
    await engine.close().catch(() => {});
  }
}
