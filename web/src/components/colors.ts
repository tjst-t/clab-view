import type { NodeColor, SourceHealth, SourceName } from '../api/types'
import type { Theme } from '../theme'

type StatusKey = 'ok' | 'drift' | 'down' | 'workflow' | 'neutral'

function statusKey(color: NodeColor): StatusKey {
  switch (color) {
    case 'ok':
      return 'ok'
    case 'drift':
      return 'drift'
    case 'down':
    case 'apply_failed':
      return 'down'
    case 'workflow':
      return 'workflow'
    case 'unobservable':
    case 'unmanaged':
    case 'unknown':
    default:
      return 'neutral'
  }
}

/**
 * Maps the backend's Color vocabulary to this palette's status colors and
 * a short human label. Kept in one place so every view (the node list, the
 * topology diagram, the DAG later) reads a node's state the same way.
 */
export function statusColor(color: NodeColor): string {
  switch (statusKey(color)) {
    case 'ok':
      return 'var(--status-ok)'
    case 'drift':
      return 'var(--status-drift)'
    case 'down':
      return 'var(--status-down)'
    case 'workflow':
      return 'var(--status-progress)'
    default:
      return 'var(--status-neutral)'
  }
}

const STATUS_HEX: Record<Theme, Record<StatusKey, string>> = {
  dark: {
    ok: '#3ddb8f',
    drift: '#eec25a',
    down: '#f25e55',
    workflow: '#5fb0ea',
    neutral: '#9aa7b0',
  },
  light: {
    ok: '#1f7a4c',
    drift: '#8a5b00',
    down: '#b3261e',
    workflow: '#1a5a9e',
    neutral: '#525f69',
  },
}

/**
 * Same mapping as statusColor, but as a literal hex value rather than a CSS
 * custom-property reference. Cytoscape.js renders to a canvas element and
 * evaluates its own style sheet independently of the page's CSS engine, so
 * `var(--status-ok)` is not a color it can resolve — it needs the literal
 * value. Takes a theme because the two palettes need different lightness
 * for the same status to stay readable against their own background (a
 * light-theme green has to be considerably darker than a dark-theme green
 * to clear the same contrast bar against a light surface). Kept in sync
 * with the --status-* tokens in index.css by hand; there are only five of
 * each.
 */
export function statusColorHex(color: NodeColor, theme: Theme = 'dark'): string {
  return STATUS_HEX[theme][statusKey(color)]
}

/**
 * Maps a plugin.Run.status (running/succeeded/failed/rejected/cancelled,
 * contract v0.2, plus any value a future contract version adds) to the
 * same five-color status vocabulary used everywhere else in this view.
 */
export function runStatusColor(status: string): string {
  switch (status) {
    case 'running':
      return 'var(--status-progress)'
    case 'succeeded':
      return 'var(--status-ok)'
    case 'failed':
    case 'rejected':
    case 'cancelled':
      return 'var(--status-down)'
    default:
      return 'var(--status-neutral)'
  }
}

/** Human label for a plugin.Run.status; falls back to the raw value for a
 * status this view does not recognize, so a future contract version's new
 * status still reads as something rather than a blank. */
export function runStatusLabel(status: string): string {
  switch (status) {
    case 'running':
      return 'Running'
    case 'succeeded':
      return 'Succeeded'
    case 'failed':
      return 'Failed'
    case 'rejected':
      return 'Rejected'
    case 'cancelled':
      return 'Cancelled'
    default:
      return status || 'Unknown'
  }
}

const SOURCE_ORDER: SourceName[] = ['containerlab', 'sakutei', 'plugin']

/**
 * Collapses every data source's health into the one status dot shown on
 * the header's always-visible Sources button (see App.tsx's
 * SourcesButton) — the per-source detail (which one, when it last
 * succeeded, what the last error was) only needs to exist once the
 * popover showing SourceHealthPanel is actually open. Any
 * configured-but-unreachable source wins (down is the one state worth
 * noticing without opening anything); otherwise ok if at least one source
 * is configured and reachable; otherwise neutral (nothing configured yet,
 * or the snapshot hasn't loaded).
 */
export function summarizeSourceHealth(
  health: Record<SourceName, SourceHealth> | undefined,
): { color: string; label: string } {
  if (!health) return { color: 'var(--text-faint)', label: 'sources' }
  const values = SOURCE_ORDER.map((n) => health[n]).filter((h): h is SourceHealth => Boolean(h))
  if (values.some((h) => h.configured && !h.ok)) {
    return { color: 'var(--status-down)', label: 'sources: unreachable' }
  }
  if (values.some((h) => h.configured && h.ok)) {
    return { color: 'var(--status-ok)', label: 'sources: ok' }
  }
  return { color: 'var(--text-faint)', label: 'sources' }
}

export function statusLabel(color: NodeColor): string {
  switch (color) {
    case 'ok':
      return 'OK'
    case 'drift':
      return 'Drift'
    case 'down':
      return 'Down'
    case 'apply_failed':
      return 'Apply failed'
    case 'workflow':
      return 'Workflow'
    case 'unobservable':
      return 'Unobservable'
    case 'unmanaged':
      return 'Unmanaged'
    case 'unknown':
    default:
      return 'Unknown'
  }
}
