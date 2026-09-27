import { pathToFileURL } from 'node:url';

export function assertReleaseWritable(status, release) {
  if (status === 404) return;
  if (status !== 200) throw new Error(`检查 Release 失败（HTTP ${status}）；停止发布。`);
  if (release?.draft !== true) throw new Error('该 Release 已公开，保留原附件；请使用新版本号。');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { GH_TOKEN, GITHUB_REPOSITORY, TAG } = process.env;
  if (!GH_TOKEN || !/^[\w.-]+\/[\w.-]+$/.test(GITHUB_REPOSITORY || '') || !/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(TAG || '')) {
    throw new Error('缺少有效的发布目标或授权；停止发布。');
  }
  const response = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/tags/${encodeURIComponent(TAG)}`, {
    headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15_000),
  });
  assertReleaseWritable(response.status, response.status === 200 ? await response.json() : null);
}
