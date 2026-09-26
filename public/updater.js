// Update progress window. State is owned by the main process; this page only renders it,
// so it can be reopened (or missed events recovered) by asking for the current state once
// on load.
const byId = id => document.getElementById(id);
const nodes = {
  version: byId('version'),
  phase: byId('phase'),
  bar: byId('bar'),
  fill: byId('fill'),
  left: byId('detail-left'),
  right: byId('detail-right'),
  steps: byId('steps'),
  error: byId('error'),
  actions: byId('actions'),
};

const PHASE_TEXT = {
  starting: '正在准备更新…',
  connecting: '正在连接下载服务器…',
  downloading: '正在下载更新包',
  verifying: '正在校验 SHA256',
  extracting: '正在解压并准备替换文件',
  closing: '正在关闭正在运行的程序…',
  restarting: '程序即将退出，替换完成后会自动重新打开',
  failed: '更新失败',
};

const STEPS = [
  ['download', '下载更新包'],
  ['verify', 'SHA256 校验'],
  ['extract', '解压到临时目录'],
  ['replace', '退出后覆盖程序文件并重启'],
];

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function currentStep(state) {
  if (state.phase === 'connecting' || state.phase === 'downloading') return 0;
  if (state.phase === 'verifying') return 1;
  if (state.phase === 'extracting') return 2;
  if (state.phase === 'closing' || state.phase === 'restarting') return 3;
  return -1;
}

function renderSteps(state) {
  const step = currentStep(state);
  nodes.steps.innerHTML = '';
  STEPS.forEach(([, label], index) => {
    const line = document.createElement('div');
    if (index < step) line.innerHTML = `✓ <b>${label}</b>`;
    else if (index === step) line.innerHTML = `● ${label}`;
    else line.textContent = `· ${label}`;
    nodes.steps.appendChild(line);
  });
}

function render(state) {
  if (!state || typeof state !== 'object') return;
  const failed = state.status === 'failed';
  nodes.version.textContent = state.version ? `新版本 ${state.version}${state.asset ? ` · ${state.asset}` : ''}` : '正在准备更新…';
  nodes.phase.textContent = failed ? (state.error || '更新失败') : (PHASE_TEXT[state.phase] || '正在更新…');
  nodes.error.classList.toggle('hidden', !failed);
  nodes.actions.classList.toggle('hidden', !failed);
  nodes.error.textContent = failed ? String(state.error || '更新失败') : '';
  nodes.bar.classList.remove('indeterminate');
  nodes.left.textContent = '';
  nodes.right.textContent = '';

  if (failed) {
    nodes.fill.style.width = '0%';
    renderSteps({});
    return;
  }

  if (state.phase === 'downloading' && state.total > 0) {
    const percent = Math.min(100, Math.round((Number(state.received) / Number(state.total)) * 100));
    nodes.fill.style.width = `${percent}%`;
    nodes.left.textContent = `${formatBytes(state.received)} / ${formatBytes(state.total)}`;
    nodes.right.textContent = `${percent}%`;
  } else if (state.phase === 'extracting' && state.files > 0) {
    const percent = Math.min(100, Math.round((Number(state.done) / Number(state.files)) * 100));
    nodes.fill.style.width = `${percent}%`;
    nodes.left.textContent = `已解压 ${state.done} / ${state.files} 个文件`;
    nodes.right.textContent = `${percent}%`;
  } else if (state.phase === 'restarting' || state.phase === 'closing') {
    nodes.fill.style.width = '100%';
    nodes.right.textContent = state.phase === 'restarting' ? '100%' : '等待程序退出';
  } else if (state.phase === 'downloading' || state.phase === 'connecting') {
    nodes.bar.classList.add('indeterminate');
    nodes.left.textContent = formatBytes(state.received);
    nodes.right.textContent = '';
  } else if (state.phase === 'verifying') {
    nodes.fill.style.width = '100%';
    nodes.right.textContent = '校验中';
  } else {
    nodes.bar.classList.add('indeterminate');
  }
  renderSteps(state);
}

byId('retry').addEventListener('click', () => {
  render({ status: 'running', phase: 'starting' });
  Promise.resolve(window.roomcastUpdater?.retry?.()).catch(error => {
    render({ status: 'failed', phase: 'failed', error: String(error?.message || '无法重试更新。') });
  });
});
byId('page').addEventListener('click', () => { void window.roomcastUpdater?.openReleasePage?.(); });
// On failure the program is still installed and usable: bring it back rather than leaving
// the user with no window at all.
byId('quit').addEventListener('click', () => { void window.roomcastUpdater?.relaunch?.(); });

void window.roomcastUpdater?.onState?.(render);
// Recover the state if the window finished loading after the download had already started.
Promise.resolve(window.roomcastUpdater?.status?.()).then(render).catch(() => { });
