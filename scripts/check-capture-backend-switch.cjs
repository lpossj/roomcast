const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const root = process.cwd();
const projectRequire = createRequire(path.join(root, 'package.json'));
const { build } = projectRequire('esbuild');
const { _electron: electron } = projectRequire('playwright');

async function main() {
  let source = await fs.readFile(path.join(root, 'src/App.jsx'), 'utf8');
  if (process.argv.includes('--baseline')) {
    source = source.replace(/    \/\/ IDs belong[\s\S]*?setSettings\(current => \(\{ \.\.\.current, sourceId: '' \}\)\);\r?\n/, '');
  }
  const imports = source.split(/\r?\n/).filter(line => /^import .*from '(lucide-react|react|\.\/lib.js|\.\/preferences.js)'/.test(line)).join('\n');
  const component = [
    imports,
    "import { createRoot } from 'react-dom/client';",
    source.slice(source.indexOf('const presets ='), source.indexOf('const params =')),
    source.slice(source.indexOf('function Modal('), source.indexOf('function EntryModal(')),
    source.slice(source.indexOf('function ShareModal('), source.indexOf('function SettingsModal(')),
    `window.obsFails = true;
    window.starts = [];
    window.roomcast = {
      desktop: true,
      getPreference: () => undefined,
      setPreference: () => true,
      audioSources: async () => [],
      obsCaptureSources: async () => window.obsFails
        ? { ok: false, message: 'OBS 来源读取失败：Roomcast 内置 OBS Runtime 不可用。' }
        : { monitors: [{ id: 'obs-monitor', name: 'OBS monitor' }], windows: [] },
      captureSources: async () => [{ id: 'screen:0:0', type: 'monitor', name: 'Native monitor' }],
    };
    createRoot(document.getElementById('root')).render(<ShareModal onClose={() => {}} onStart={async options => window.starts.push(options)} busy={false} />);`,
  ].join('\n');
  const bundle = await build({ stdin: { contents: component, loader: 'jsx', resolveDir: path.join(root, 'src') }, jsx: 'automatic', bundle: true, write: false, platform: 'browser', define: { 'process.env.NODE_ENV': '"test"' } });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'roomcast-picker-check-'));
  let app;
  try {
    await fs.writeFile(path.join(temp, 'ui.js'), bundle.outputFiles[0].text);
    await fs.writeFile(path.join(temp, 'index.html'), '<!doctype html><html><body><div id="root"></div><script src="ui.js"></script></body></html>');
    await fs.writeFile(path.join(temp, 'main.cjs'), `const { app, BrowserWindow } = require('electron'); app.whenReady().then(() => { const win = new BrowserWindow({ show: false, width: 1200, height: 1000, webPreferences: { backgroundThrottling: false } }); win.loadFile(require('node:path').join(__dirname, 'index.html')); });`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [path.join(temp, 'main.cjs')], env, timeout: 30000 });
    const page = await app.firstWindow();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const start = page.getByRole('button', { name: '开始共享', exact: true });
    await page.getByRole('alert').waitFor();
    assert.equal(await page.locator('.source-card').count(), 0);
    assert.equal(await start.isDisabled(), true);
    await page.getByRole('button', { name: '原生采集', exact: true }).click();
    await page.getByRole('button', { name: 'Native monitor', exact: true }).waitFor();
    assert.equal(await start.isEnabled(), true);
    await page.getByRole('button', { name: 'OBS', exact: true }).click();
    await page.getByRole('alert').waitFor();
    assert.equal(await page.locator('.source-card').count(), 0, 'failed OBS enumeration must not display native source cards');
    assert.equal(await start.isDisabled(), true);
    await page.evaluate(() => { window.obsFails = false; });
    await page.getByRole('button', { name: '刷新采集来源', exact: true }).click();
    await page.getByRole('button', { name: 'OBS monitor', exact: true }).waitFor();
    await start.click();
    await page.waitForFunction(() => window.starts.length === 1);
    const selected = await page.evaluate(() => window.starts[0]);
    assert.equal(selected.captureBackend, 'obs');
    assert.equal(selected.sourceId, 'obs-monitor');
    await page.evaluate(() => { window.obsFails = true; });
    await page.getByRole('button', { name: '刷新采集来源', exact: true }).click();
    await page.getByRole('alert').waitFor();
    assert.equal(await page.locator('.source-card').count(), 0, 'failed refresh must also clear previous OBS cards');
    assert.equal(await start.isDisabled(), true);
    await page.getByRole('button', { name: '原生采集', exact: true }).click();
    await page.getByRole('button', { name: 'Native monitor', exact: true }).waitFor();
    await start.click();
    await page.waitForFunction(() => window.starts.length === 2);
    assert.equal(await page.evaluate(() => window.starts[1].captureBackend), 'native');
    assert.deepEqual(errors, []);
    console.log('PASS: actual ShareModal OBS failure -> native -> OBS failure; no stale sources; recovered OBS and native submit correct IDs.');
  } finally {
    if (app) await app.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
