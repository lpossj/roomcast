import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL('../electron/obs-virtualcam-registration.cjs', import.meta.url), 'utf8');
const { OBS_VIRTUAL_CAM_CLSID, parseRegistrationExport } = require('../electron/obs-virtualcam-registration.cjs');
const key = `HKEY_LOCAL_MACHINE\\SOFTWARE\\Classes\\CLSID\\${OBS_VIRTUAL_CAM_CLSID}\\InprocServer32`;
const fixture = value => `Windows Registry Editor Version 5.00\r\n\r\n[${key}]\r\n${value}\r\n`;

test('registry export parser preserves Unicode, quoting and expanded UTF-16 paths', () => {
  const unicode = 'C:\\中文目录\\OBS camera.dll';
  assert.equal(parseRegistrationExport(fixture(`@=${JSON.stringify(unicode)}`), 64).path, unicode);
  assert.equal(parseRegistrationExport(fixture(`@=${JSON.stringify(`"${unicode}"`)}`), 32).path, unicode);
  const bytes = Buffer.from('%SystemRoot%\\中文.dll\0', 'utf16le');
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0'));
  const wrapped = hex.slice(0, 8).join(',') + ',\\\r\n  ' + hex.slice(8).join(',');
  const previous = process.env.SystemRoot;
  try {
    process.env.SystemRoot = 'C:\\Windows';
    assert.equal(parseRegistrationExport(fixture(`@=hex(2):${wrapped}`), 32).path, 'C:\\Windows\\中文.dll');
  } finally {
    if (previous === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = previous;
  }
  assert.equal(parseRegistrationExport(fixture('"ThreadingModel"="Both"'), 64).pathExists, false);
  assert.throws(() => parseRegistrationExport('[unrelated]\n@="fake"', 64), /目标项/);
  assert.throws(() => parseRegistrationExport(fixture('@=hex(2):invalid'), 64), /编码/);
});

function queryHarness(spawnImpl) {
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, Buffer, TextDecoder, process: { platform: 'win32', env: { SystemRoot: 'C:\\Windows' } },
    require: name => name === 'node:child_process' ? { spawnSync: spawnImpl, spawn() {} }
      : name === './obs-virtualcam-trust.cjs' ? require('../electron/obs-virtualcam-trust.cjs') : require(name),
    setTimeout, clearTimeout,
  });
  return module.exports;
}

test('read-only registry query uses bounded reg.exe exports for both views and removes temporary files', () => {
  const files = [];
  const h = queryHarness((file, args, options) => {
    assert.match(file, /System32[\\/]reg\.exe$/i);
    assert.equal(args[0], 'export'); assert.equal(options.timeout, 5000); assert.equal(options.windowsHide, true);
    assert.equal(args.at(-1), `/reg:${files.length ? 64 : 32}`);
    files.push(args[2]);
    fs.writeFileSync(args[2], '\uFEFF' + fixture('@="C:\\\\中文\\\\camera.dll"'), 'utf16le');
    return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  });
  assert.equal(h.registrationStatus().reg32Path, 'C:\\中文\\camera.dll');
  assert.equal(files.length, 2);
  for (const file of files) assert.equal(fs.existsSync(file), false);
});

test('missing registry keys are absent while denied, blocked and timed-out queries remain errors', () => {
  const absent = queryHarness(() => ({ status: 1, stderr: Buffer.from('ERROR: The system was unable to find the specified registry key or value.') }));
  assert.equal(absent.registrationStatus().state, 'absent');
  for (const result of [{ status: 1, stderr: Buffer.from('Access is denied.') }, { error: new Error('ETIMEDOUT') }]) {
    assert.throws(() => queryHarness(() => result).registrationStatus(), /无法读取/);
  }
});

test('unreadable startup registration logs the failure without attempting elevation or preparing OBS', async () => {
  const main = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const block = main.slice(main.indexOf('      const preferredCaptureBackend ='), main.indexOf('      let savedWindow ='));
  let engines = 0; const logs = [];
  await vm.runInNewContext(`(async () => { ${block} })()`, {
    preferences: {}, process: { platform: 'win32', env: {} }, app: { isPackaged: true, getPath: () => 'C:/profile' },
    registrationStatus: () => { throw new Error('query blocked'); },
    ObsFixedFpsEngine: class { constructor() { engines++; } }, startupMark() {},
    path: require('node:path'), fs: { existsSync: () => false, appendFileSync: (_path, text) => logs.push(text) }, Date,
  });
  assert.equal(engines, 0); assert.match(logs[0], /query blocked/);
});
