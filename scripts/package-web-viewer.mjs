import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const dist = path.join(root, 'dist');
if (!existsSync(path.join(dist, 'index.html'))) throw new Error('请先完成 npm run build。');
const output = path.join(root, 'release', 'Roomcast-' + version + '-WebViewer');
mkdirSync(output, { recursive: true });
cpSync(dist, output, { recursive: true });
writeFileSync(path.join(output, '.nojekyll'), '');
writeFileSync(path.join(output, 'version.json'), JSON.stringify({ version, peerAuthProtocol: 2 }));
console.log('[web-viewer] ' + output);
