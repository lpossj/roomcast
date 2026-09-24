const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };
const PUBLIC_URL = /https:\/\/(?:[a-z0-9]+-){2,}[a-z0-9]+\.trycloudflare\.com\b/i;
const PUBLIC_FILE = /^[A-Za-z0-9_.-]+\.(?:js|css|svg|png|ico|woff|woff2|txt|webmanifest)$/;

// The public entry serves only files the Vite build actually emitted, discovered at
// start time. Every other path (desktop APIs, Socket.IO, server modules, traversal)
// is a 404 by construction instead of by a hand-maintained allowlist.
function collectPublicFiles(distDir) {
  const files = new Map([['/', 'index.html']]);
  for (const [prefix, directory] of [['', distDir], ['/assets', path.join(distDir, 'assets')]]) {
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory)) {
      if (!PUBLIC_FILE.test(name)) continue;
      const relative = prefix ? `${prefix.slice(1)}/${name}` : name;
      if (fs.statSync(path.join(distDir, relative)).isFile()) files.set(`${prefix}/${name}`, relative);
    }
  }
  return files;
}

function createStaticViewer(distDir) {
  const publicFiles = collectPublicFiles(distDir);
  return http.createServer((request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' https: wss:; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return;
    }
    let pathname;
    try { pathname = new URL(request.url, 'http://localhost').pathname; } catch { pathname = ''; }
    const relative = publicFiles.get(pathname);
    if (!relative) {
      response.writeHead(404);
      response.end();
      return;
    }
    const file = path.join(distDir, relative);
    fs.stat(file, (error, stats) => {
      if (error || !stats.isFile()) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { 'Content-Type': TYPES[path.extname(file)], 'Content-Length': stats.size });
      if (request.method === 'HEAD') response.end();
      else fs.createReadStream(file).pipe(response);
    });
  });
}

function createWebInvite({ distDir, executablePath, onState = () => {} }) {
  let server = null;
  let child = null;
  let startPromise = null;
  let cancelStart = null;
  let publicUrl = '';
  let generation = 0;

  async function stop() {
    generation += 1;
    publicUrl = '';
    cancelStart?.();
    if (child) { child.kill(); child = null; }
    if (server) {
      const closing = server;
      server = null;
      closing.closeAllConnections();
      await new Promise(resolve => closing.close(resolve));
    }
    onState({ url: '' });
  }

  async function start() {
    if (publicUrl) return { url: publicUrl };
    if (startPromise) return startPromise;
    const current = ++generation;
    startPromise = (async () => {
      if (!fs.existsSync(executablePath)) throw new Error('网页入口组件缺失，请重新安装完整安装包。');
      server = createStaticViewer(distDir);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const port = server.address().port;
      return new Promise((resolve, reject) => {
        const process = spawn(executablePath, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        child = process;
        let output = '';
        let candidateUrl = '';
        let registered = false;
        const timeout = setTimeout(() => finish(new Error('网页入口连接超时，请检查网络后重试。')), 45000);
        let settled = false;
        const finish = (error, url) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          cancelStart = null;
          if (error) reject(error);
          else resolve({ url });
        };
        cancelStart = () => finish(new Error('网页入口已关闭。'));
        const receive = chunk => {
          output = (output + chunk.toString('utf8')).slice(-4096);
          const match = output.match(PUBLIC_URL);
          if (match) candidateUrl = match[0];
          if (/registered tunnel connection/i.test(output)) registered = true;
          if (candidateUrl && registered && current === generation && !publicUrl) {
            publicUrl = candidateUrl;
            onState({ url: publicUrl });
            finish(null, publicUrl);
          }
        };
        process.stdout.on('data', receive);
        process.stderr.on('data', receive);
        process.once('error', error => { if (!publicUrl) finish(new Error(`网页入口无法启动：${error.message}`)); });
        process.once('exit', () => {
          if (child !== process) return;
          child = null;
          if (!publicUrl) finish(new Error('网页入口连接失败，请检查网络后重试。'));
          else void stop();
        });
      });
    })().catch(async error => { if (current === generation) await stop(); throw error; }).finally(() => { startPromise = null; });
    return startPromise;
  }

  return { start, stop };
}

module.exports = { createStaticViewer, createWebInvite };
