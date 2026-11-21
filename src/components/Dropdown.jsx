import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

export default function Dropdown({ label, value, options, onChange, disabled = false, description = '', className = '' }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const selected = options.find(option => option.value === value) || options[0];

  useEffect(() => {
    if (!open) return undefined;
    const close = event => {
      if (!root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  return (
    <div
      className={`app-select-field standalone-label compact-select ${className}`}
      ref={root}
      onKeyDown={event => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <span className="app-select-label">{label}</span>
      <button
        type="button"
        className="app-select-trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(current => !current)}
      >
        <span>{selected?.label || ''}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <div className="app-select-menu" role="listbox" aria-label={`${label}选项`}>
          {options.map(option => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={option.value === value ? 'selected' : ''}
              key={option.value}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              <span>{option.label}</span>
              {option.value === value && <Check size={15} />}
            </button>
          ))}
        </div>
      )}
      {description && <small>{description}</small>}
    </div>
  );
}
