export const DEFAULT_THEME_COLOR = '#78ddbd';
export const THEME_MODE_CUSTOM = 'custom';
export const THEME_MODE_WINDOWS = 'windows';
export const THEME_PRESETS = ['#78ddbd', '#5b9dff', '#a78bfa', '#f472b6', '#f5b041', '#4ade80'];

export const normalizeThemeColor = value =>
  /^#[0-9a-f]{6}$/i.test(String(value || '').trim())
    ? String(value).trim().toLowerCase()
    : DEFAULT_THEME_COLOR;

export const normalizeThemeMode = value =>
  value === THEME_MODE_WINDOWS ? THEME_MODE_WINDOWS : THEME_MODE_CUSTOM;

export const themeLuminance = color => {
  const raw = normalizeThemeColor(color).slice(1);
  const red = Number.parseInt(raw.slice(0, 2), 16);
  const green = Number.parseInt(raw.slice(2, 4), 16);
  const blue = Number.parseInt(raw.slice(4, 6), 16);
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
};

export const themeForegroundFor = color =>
  themeLuminance(color) >= 150 ? '#091017' : '#ffffff';

export function loadThemeSettings() {
  try {
    const saved = window.roomcast?.getThemeSettings?.();
    if (saved && typeof saved === 'object') {
      return {
        mode: normalizeThemeMode(saved.mode),
        color: normalizeThemeColor(saved.color),
      };
    }
  } catch { }
  return { mode: THEME_MODE_CUSTOM, color: DEFAULT_THEME_COLOR };
}

export function loadWindowsAccentColor() {
  try {
    return normalizeThemeColor(window.roomcast?.getSystemAccentColor?.() || DEFAULT_THEME_COLOR);
  } catch {
    return DEFAULT_THEME_COLOR;
  }
}

export function applyThemeColor(value) {
  const color = normalizeThemeColor(value);
  const root = document.documentElement;
  root.style.setProperty('--accent', color);
  root.style.setProperty('--green', color);
  root.style.setProperty('--accent-foreground', themeForegroundFor(color));
  root.style.setProperty('--titlebar-foreground', themeForegroundFor(color));
  return color;
}
