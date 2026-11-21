import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';

export default function Modal({ title, subtitle, children, onClose, wide, busy, cancellable = false, drawer = false }) {
  const blocked = busy && !cancellable;
  const dialog = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement;
    const first = dialog.current?.querySelector('input, button, select');
    first?.focus();
    const key = event => {
      if (event.key === 'Escape' && !blocked) closeRef.current();
      if (event.key === 'Tab') {
        const elements = [...dialog.current.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], textarea:not(:disabled)')];
        if (!elements.length) return;
        const start = elements[0];
        const end = elements.at(-1);
        if (event.shiftKey && document.activeElement === start) {
          event.preventDefault();
          end.focus();
        } else if (!event.shiftKey && document.activeElement === end) {
          event.preventDefault();
          start.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, [blocked]);

  const isDesktopDrawer = drawer && window.roomcast?.desktop;

  return (
    <div
      className={`modal-backdrop ${isDesktopDrawer ? 'drawer-backdrop' : ''}`}
      onMouseDown={event => {
        if (!window.roomcast?.desktop && event.target === event.currentTarget && !blocked) onClose();
      }}
    >
      <section
        className={`modal ${wide ? 'modal-wide' : ''} ${drawer ? 'modal-drawer' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        ref={dialog}
      >
        <header className="modal-header">
          <div>
            <h2 id="modal-title">{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button type="button" className="icon-button" onClick={onClose} disabled={blocked} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
