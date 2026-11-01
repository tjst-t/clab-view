/**
 * The view's two color themes. Kept as the single source of truth for
 * "which themes exist" so index.css's `[data-theme]` selectors, this
 * module's persistence, and colors.ts's Cytoscape-literal palettes can't
 * drift out of sync with each other.
 */
export type Theme = 'dark' | 'light'

const STORAGE_KEY = 'clab-view-theme'

function isTheme(value: string | null): value is Theme {
  return value === 'dark' || value === 'light'
}

/**
 * The theme to start with: whatever the person picked last time (if
 * anything), otherwise the OS/browser's own light-or-dark preference.
 * Read once at startup — switching the OS preference afterward doesn't
 * retroactively override an explicit choice made in this app.
 */
export function getInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'dark'
  const stored = window.localStorage.getItem(STORAGE_KEY)
  if (isTheme(stored)) return stored
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

/** Applies a theme to the document and remembers the choice for next time. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
  window.localStorage.setItem(STORAGE_KEY, theme)
}
