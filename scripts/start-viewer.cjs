const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const viewerRoot = path.join(projectRoot, 'runtime', 'dev-viewer-instance');
const profileDir = path.join(viewerRoot, 'profile');
const dataDir = path.join(viewerRoot, 'data');
const clean = process.argv.includes('--clean');
const dryRun = process.argv.includes('--dry-run');

if (clean) fs.rmSync(viewerRoot, { recursive: true, force: true });
fs.mkdirSync(profileDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

let electronExecutable;
try {
  electronExecutable = process.env.ROOMCAST_ELECTRON_EXE || require('electron');
} catch (error) {
  if (!dryRun) throw error;
  electronExecutable = path.join(projectRoot, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
}
const childEnv = {
  ...process.env,
  ROOMCAST_PROFILE_DIR: profileDir,
  ROOMCAST_DATA_DIR: dataDir,
  ROOMCAST_ALLOW_PARALLEL_INSTANCE: '1',
  ROOMCAST_VIEWER_INSTANCE: '1',
};
// The app already asks Windows for a free local service port when PORT is absent.
// Do not inherit a development PORT/HOST into the viewer instance.
delete childEnv.PORT;
delete childEnv.HOST;

const plan = {
  electronExecutable,
  cwd: projectRoot,
  profileDir,
  dataDir,
  parallelInstance: childEnv.ROOMCAST_ALLOW_PARALLEL_INSTANCE,
};

if (dryRun) {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}

console.log('[Roomcast viewer] Starting isolated second instance...');
console.log(`[Roomcast viewer] profile: ${profileDir}`);
console.log(`[Roomcast viewer] data:    ${dataDir}`);
console.log('[Roomcast viewer] Close this viewer window to stop the second instance.');

const child = spawn(electronExecutable, ['.'], {
  cwd: projectRoot,
  env: childEnv,
  stdio: 'inherit',
  windowsHide: false,
});

child.on('error', error => {
  console.error(`[Roomcast viewer] Failed to start Electron: ${error.message}`);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.log(`[Roomcast viewer] Electron exited by signal ${signal}.`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = Number.isInteger(code) ? code : 0;
});
