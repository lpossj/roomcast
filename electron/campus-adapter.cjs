const { Worker } = require('node:worker_threads');
const { randomBytes } = require('node:crypto');
const path = require('node:path');

function createCampusAdapter(address, onEnded) {
  const username = randomBytes(24).toString('base64url');
  const credential = randomBytes(32).toString('base64url');
  // Node worker ESM resolution uses real files, independently of Electron's
  // main-process ASAR loader. These two packages are explicitly unpacked.
  const entry = path.join(__dirname, 'campus-adapter-worker.mjs').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  const worker = new Worker(entry, {
    workerData: { address, username, credential },
  });
  let stopped = false;
  const stop = () => { stopped = true; return worker.terminate(); };
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { void stop(); reject(new Error('EasyTier 本机适配启动超时。')); }, 10000);
    const failed = () => { clearTimeout(timer); reject(new Error('EasyTier 本机适配已结束。')); };
    worker.on('error', failed);
    worker.on('exit', () => { failed(); if (!stopped) onEnded(); });
    worker.once('message', value => {
      clearTimeout(timer);
      if (!Number.isInteger(value?.port) || value.port < 1 || value.port > 65535) { void stop(); failed(); return; }
      resolve({ urls: `turn:127.0.0.1:${value.port}?transport=udp`, username, credential });
    });
  });
  return { ready, stop };
}
module.exports = { createCampusAdapter };
