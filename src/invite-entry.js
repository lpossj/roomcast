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
    if (new URLSearchParams(page.location.hash.slice(1)).has('room')) {
      try { page.history.replaceState(null, '', page.location.pathname + page.location.search); } catch { }
    }
    return invite;
  }
  if (useRemembered) {
    try { return page.sessionStorage.getItem('roomcast:invite') || ''; } catch { }
  }
  return '';
}
