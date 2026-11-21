import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const cwd = path.join(root, 'native/ice-engine');
const output = path.join(root, 'runtime/native-ice');
const go = process.env.ROOMCAST_GO || 'go';
const options = { cwd, encoding: 'utf8', windowsHide: true,
  env: { ...process.env, GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0' } };
fs.mkdirSync(output, { recursive: true });
execFileSync(go, ['build', '-mod=readonly', '-buildvcs=false', '-trimpath', '-ldflags=-s -w', '-o', path.join(output, 'RoomcastNativeIce.exe'), '.'], options);
const modules = execFileSync(go, ['list', '-mod=readonly', '-deps', '-f', '{{if .Module}}{{.Module.Path}}|{{.Module.Version}}|{{.Module.Dir}}{{end}}', '.'], options);
const goRoot = execFileSync(go, ['env', 'GOROOT'], options).trim();
const notices = ['Go runtime\n' + fs.readFileSync(path.join(goRoot, 'LICENSE'), 'utf8')];
for (const module of new Set(modules.trim().split(/\r?\n/))) {
  if (!module) continue;
  const [name, version, directory] = module.split('|');
  if (!version) continue;
  const files = fs.readdirSync(directory).filter(f => /^(LICENSE|COPYING|NOTICE)(\..*)?$/i.test(f));
  if (!files.length) throw new Error('Missing dependency license for ' + name);
  for (const file of files) notices.push(name + ' ' + version + '\n' + fs.readFileSync(path.join(directory, file), 'utf8'));
}
fs.writeFileSync(path.join(output, 'LICENSES.txt'), notices.join('\n\n'));
console.log('Windows x64 native engine and dependency licenses prepared.');
