const documents = new WeakMap();

function isToggleKey(event) {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229
    || event.ctrlKey || event.altKey || event.metaKey || event.key?.toLowerCase() !== 'n') return false;
  return !event.composedPath().some(node => node.isContentEditable
    || node.matches?.('input, textarea, select, [role="textbox"]'));
}

// A single handler chooses one watching surface, including when several shares are open.
export function bindLaserShortcut(surface, { canToggle, onToggle }) {
  const doc = surface.ownerDocument;
  let state = documents.get(doc);
  if (!state) {
    state = { entries: new Set(), key: null };
    state.key = event => {
      if (!isToggleKey(event) || doc.querySelector('[aria-modal="true"], dialog[open]')) return;
      const entries = [...state.entries].filter(entry => entry.surface.isConnected && entry.canToggle());
      const full = doc.fullscreenElement;
      const target = full
        ? entries.find(entry => full.contains(entry.surface) || entry.surface.contains(full))
        : entries.find(entry => entry.surface.matches(':hover'))
          || entries.find(entry => entry.surface.contains(doc.activeElement))
          || (entries.length === 1 ? entries[0] : null);
      if (!target) return;
      event.preventDefault();
      target.onToggle();
    };
    documents.set(doc, state);
    doc.addEventListener('keydown', state.key);
  }
  const entry = { surface, canToggle, onToggle };
  state.entries.add(entry);
  return () => {
    state.entries.delete(entry);
    if (!state.entries.size) {
      doc.removeEventListener('keydown', state.key);
      documents.delete(doc);
    }
  };
}
