import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Keep the desktop server implementation intact while sharing its room rules with web hosts.
// The rewrite is textual, so it must fail the build instead of silently shipping node:crypto
// (which would only break at runtime in the browser) when server/rooms.mjs is reformatted.
const browserRoomCrypto = {
  name: 'browser-room-crypto',
  transform(source, id) {
    if (!id.replaceAll('\\', '/').endsWith('/server/rooms.mjs')) return null;
    const rewritten = source
      .replace("import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';", "import { Buffer, createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from '../src/browser-node-crypto.js';")
      .replace("import { promisify } from 'node:util';", "import { promisify } from '../src/browser-node-crypto.js';");
    if (rewritten === source || /(?:from|require\()\s*['"]node:(?:crypto|util)['"]/.test(rewritten)) {
      throw new Error('browser-room-crypto: 未能替换 server/rooms.mjs 的 node:crypto / node:util 导入；浏览器房间服务会静默打包 Node 内置模块。请同步更新 vite.config.js 与 src/browser-node-crypto.js。');
    }
    return rewritten;
  },
};
export default defineConfig({
  plugins: [react(), browserRoomCrypto],
  server: { proxy: { '/api': 'http://127.0.0.1:3210', '/socket.io': { target: 'http://127.0.0.1:3210', ws: true }, '/media': 'http://127.0.0.1:3210' } },
  build: { outDir: 'dist', sourcemap: false },
});
