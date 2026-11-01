import type { SourceHealth, SourceName } from '../api/types'
import { StatusDot } from './StatusDot'

const LABELS: Record<SourceName, string> = {
  containerlab: 'containerlab',
  sakutei: 'Sakutei',
  plugin: 'Device plugin',
}

const ORDER: SourceName[] = ['containerlab', 'sakutei', 'plugin']

function describe(h: SourceHealth): { color: string; text: string } {
  if (!h.configured) {
    return { color: 'var(--text-faint)', text: 'not configured' }
  }
  if (h.ok) {
    return { color: 'var(--status-ok)', text: 'reachable' }
  }
  return { color: 'var(--status-down)', text: 'unreachable' }
}

function formatTime(iso?: string): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString()
}

/**
 * A plain list of each data source's reachability. Deliberately has no
 * heading of its own — every caller (currently just the header's Sources
 * popover, see App.tsx) already supplies its own context for what this
 * list is, and a redundant "Sources" label inside a panel whose trigger
 * button already says "Sources" was exactly the kind of avoidable
 * vertical space this component was pulled out of the always-visible
 * sidebar to stop costing.
 */
export function SourceHealthPanel({
  health,
}: {
  health: Record<SourceName, SourceHealth>
}) {
  return (
    <section>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {ORDER.map((name) => {
          const h = health[name]
          if (!h) return null
          const { color, text } = describe(h)
          const lastSuccess = formatTime(h.last_success)
          return (
            <li
              key={name}
              style={{
                padding: '10px 0',
                borderTop: '1px solid var(--border)',
              }}
            >
              <div
                style={{ display: 'flex', alignItems: 'center', gap: 8 }}
              >
                <StatusDot color={color} />
                <span style={{ fontWeight: 500 }}>{LABELS[name]}</span>
                <span style={{ color: 'var(--text-muted)', marginLeft: 'auto' }}>
                  {text}
                </span>
              </div>
              {h.configured && lastSuccess && (
                <div
                  className="mono"
                  style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 4 }}
                >
                  last read ok: {lastSuccess}
                </div>
              )}
              {h.configured && !h.ok && h.last_error && (
                <div
                  className="mono"
                  style={{
                    fontSize: 12,
                    color: 'var(--status-down)',
                    marginTop: 4,
                    wordBreak: 'break-word',
                  }}
                >
                  {h.last_error}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
