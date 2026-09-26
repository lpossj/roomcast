const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };
const DEFAULT_WEB_VIEWER_URL = 'https://lpossj.github.io/roomcast/';
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

// The web entry is a separately hosted static build. Creating an invite must not
// require the host to publish a local server or connect to a tunnel edge.
function createWebInvite({ viewerUrl = DEFAULT_WEB_VIEWER_URL, onState = () => {} } = {}) {
  async function start() {
    let url;
    try { url = new URL(viewerUrl); } catch { throw new Error('网页入口地址无效。'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) {
      throw new Error('网页入口必须是无账号、端口、查询和片段的 HTTPS 地址。');
    }
    onState({ url: url.href });
    return { url: url.href };
  }
  async function stop() { onState({ url: '' }); }
  return { start, stop };
}

module.exports = { createStaticViewer, createWebInvite, DEFAULT_WEB_VIEWER_URL };
