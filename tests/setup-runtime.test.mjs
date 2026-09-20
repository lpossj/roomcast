import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
for (const state of ['missing', 'corrupt']) {
  test(`clean source setup reports ${state} loopback component before installing Electron`, { skip: process.platform !== 'win32' || process.arch !== 'x64' }, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'roomcast-setup-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, 'scripts'));
    await copyFile(new URL('../scripts/setup.mjs', import.meta.url), path.join(root, 'scripts/setup.mjs'));
    if (state === 'corrupt') {
      await mkdir(path.join(root, 'runtime/loopback-capture'), { recursive: true });
      await writeFile(path.join(root, 'runtime/loopback-capture/loopback_capture_addon.node'), 'wrong binary');
    }
    await assert.rejects(execute(process.execPath, [path.join(root, 'scripts/setup.mjs')], { windowsHide: true }), error => {
      assert.match(error.stderr, /系统音频组件缺失或校验失败/);
      assert.match(error.stderr, /LOOPBACK-CAPTURE-COMPLIANCE\.md/);
      assert.doesNotMatch(error.stdout, /正在准备 Electron|已就绪/);
      return true;
    });
  });
}
