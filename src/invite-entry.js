// Reading an invitation only fills the join form; it must never join a room.
export function roomInviteFromUrl(value) {
  const text = String(value || '').trim();
  if (/^roomcast:\/\/join\//i.test(text)) return text;
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return new URLSearchParams(url.hash.slice(1)).get('room') || url.searchParams.get('room') || '';
  } catch { return ''; }
}

export function readPageInvite(page, useRemembered = true) {
  const invite = roomInviteFromUrl(page.location.href);
  if (invite) {
    try { page.sessionStorage.setItem('roomcast:invite', invite); } catch { }
    // Storage denial must not discard the invitation or prevent showing the form.
    try {
      const clean = new URL(page.location.href);
      const fragment = new URLSearchParams(clean.hash.slice(1));
      if (clean.searchParams.has('room') || fragment.has('room')) {
        clean.searchParams.delete('room');
        fragment.delete('room');
        clean.hash = fragment.toString();
        page.history.replaceState(null, '', clean.pathname + clean.search + clean.hash);
      }
    } catch { }
    return invite;
  }
  if (useRemembered) {
    try { return page.sessionStorage.getItem('roomcast:invite') || ''; } catch { }
  }
  return '';
}
