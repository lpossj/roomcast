import { mkdir, readFile, readdir, copyFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';

// Stage public files only. Never deploy dist wholesale: updater files are desktop-only.
const root = process.cwd();
const dist = path.join(root, 'dist');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const output = path.join(root, '.test', `viewer-site-${version}-${Date.now()}`);
await mkdir(path.dirname(output), { recursive: true });
await mkdir(output, { recursive: false });
const allowed = /\.(?:js|css|svg|png|ico|woff|woff2|txt|webmanifest)$/;
const copied = [];
for (const directory of ['', 'assets']) {
  const target = path.join(output, directory);
  if (directory) await mkdir(target);
  for (const item of await readdir(path.join(dist, directory), { withFileTypes: true })) {
    if (!item.isFile()) continue;
    if (item.name.startsWith('updater.') || !(item.name === 'index.html' || allowed.test(item.name))) continue;
    const relative = path.join(directory, item.name);
    await copyFile(path.join(dist, relative), path.join(output, relative));
    copied.push(relative);
  }
}
await access(path.join(output, 'index.html'));
// A 404 page disables Pages' implicit SPA fallback, so desktop API/update paths
// cannot even appear to exist on the public viewer origin.
await writeFile(path.join(output, '404.html'), '<!doctype html><meta charset="utf-8"><title>404</title><p>页面不存在</p>');
await writeFile(path.join(output, 'version.json'), JSON.stringify({ version, peerAuthProtocol: 2 }, null, 2));
await writeFile(path.join(output, '_headers'), `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  X-Frame-Options: DENY
  Content-Security-Policy: frame-ancestors 'none'
/version.json
  Cache-Control: no-store
/index.html
  Cache-Control: no-cache
/
  Cache-Control: no-cache
`);
console.log(JSON.stringify({ output, version, publicFiles: copied.length }));
