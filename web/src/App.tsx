import type { CSSProperties, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { fetchSnapshot, subscribeEvents, type EventStreamStatus } from './api/client'
import type { LiveEvent, Snapshot } from './api/types'
import { EventLog } from './components/EventLog'
import { NodeList } from './components/NodeList'
import { OperationsPanel } from './components/OperationsPanel'
import { summarizeSourceHealth } from './components/colors'
import { SourceHealthPanel } from './components/SourceHealthPanel'
import { StatusDot } from './components/StatusDot'
import { TopologyDiagram } from './components/TopologyDiagram'
import { applyTheme, getInitialTheme, type Theme } from './theme'

// How often to re-fetch GET /api/snapshot in the background. Page (1)'s
// scope is a working read-only poll + SSE loop; a push-driven snapshot
// update (reacting to /api/events instead of a timer) is left for when the
// topology diagram (Backlog item-2) needs it to feel live rather than just
// correct.
const SNAPSHOT_POLL_INTERVAL_MS = 5000
const MAX_EVENTS_SHOWN = 200

type Tab = 'topology' | 'nodes'

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [snapshotError, setSnapshotError] = useState<string | null>(null)
  const [events, setEvents] = useState<LiveEvent[]>([])
  const [streamStatus, setStreamStatus] = useState<EventStreamStatus>('connecting')
  const [theme, setTheme] = useState<Theme>(getInitialTheme)
  const [tab, setTab] = useState<Tab>('topology')
  // Shared across both tabs (it narrows the diagram by dimming non-matches
  // and the Nodes table by hiding rows) rather than being local to
  // TopologyDiagram -- the same filter text should keep applying when
  // switching tabs, not reset.
  const [filter, setFilter] = useState('')

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()

    async function load() {
      try {
        const snap = await fetchSnapshot(controller.signal)
        if (!cancelled) {
          setSnapshot(snap)
          setSnapshotError(null)
        }
      } catch (err) {
        if (!cancelled && !controller.signal.aborted) {
          setSnapshotError(err instanceof Error ? err.message : String(err))
        }
      }
    }

    load()
    const interval = setInterval(load, SNAPSHOT_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      controller.abort()
      clearInterval(interval)
    }
  }, [])

  const eventsRef = useRef<LiveEvent[]>([])
  useEffect(() => {
    const unsubscribe = subscribeEvents(
      (event) => {
        eventsRef.current = [event, ...eventsRef.current].slice(0, MAX_EVENTS_SHOWN)
        setEvents(eventsRef.current)
      },
      setStreamStatus,
    )
    return unsubscribe
  }, [])

  return (
    <div
      style={{
        minHeight: '100%',
        display: 'flex',
        flexDirection: 'column',
        borderTop: '2px solid var(--accent)',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 12,
          padding: '12px 20px',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <h1
          className="mono"
          style={{ fontSize: 17, fontWeight: 600, letterSpacing: 0.2, margin: 0 }}
        >
          clab-view
        </h1>
        {snapshot && (
          <span className="mono" style={{ marginLeft: 'auto', color: 'var(--text-faint)', fontSize: 12 }}>
            generated {new Date(snapshot.generated_at).toLocaleTimeString()}
          </span>
        )}
        <SourcesButton health={snapshot?.health} marginLeft={snapshot ? 14 : 'auto'} />
        <button
          type="button"
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          className="mono"
          style={headerButtonStyle}
        >
          {theme === 'dark' ? 'light theme' : 'dark theme'}
        </button>
      </header>

      {snapshotError && (
        <div
          style={{
            margin: '12px 20px 0',
            padding: 10,
            border: '1px solid var(--status-down)',
            borderRadius: 4,
            color: 'var(--status-down)',
            fontSize: 13,
          }}
        >
          <strong>Couldn't reach the backend:</strong> {snapshotError}
        </div>
      )}

      <main style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '14px 20px', flex: 1 }}>
        <section
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '10px 14px 14px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 18, borderBottom: '1px solid var(--border)' }}>
            <TabButton active={tab === 'topology'} onClick={() => setTab('topology')}>
              Topology
            </TabButton>
            <TabButton active={tab === 'nodes'} onClick={() => setTab('nodes')}>
              Nodes{snapshot ? ` (${snapshot.nodes.length})` : ''}
            </TabButton>
            {/* Filtering is useful regardless of which tab is active (it
                narrows the diagram by dimming non-matches, and narrows the
                node table by hiding rows) -- living at the tab bar's own
                height, at its right edge, keeps it visible and reachable
                no matter which tab someone is on, instead of being stuck
                inside just the Topology tab's own toolbar. */}
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="filter nodes…"
              className="mono"
              style={{
                marginLeft: 'auto',
                marginBottom: 6,
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                color: 'var(--text)',
                fontSize: 12,
                padding: '5px 10px',
                width: 200,
              }}
            />
          </div>
          <div style={{ paddingTop: 14 }}>
            {tab === 'topology' ? (
              snapshot ? (
                <TopologyDiagram nodes={snapshot.nodes} links={snapshot.links} theme={theme} filter={filter} />
              ) : (
                <Loading />
              )
            ) : snapshot ? (
              <NodeList nodes={snapshot.nodes} filter={filter} />
            ) : (
              <Loading />
            )}
          </div>
        </section>

        {snapshot?.actions_enabled && (
          <section
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: 14,
            }}
          >
            <h2 style={sectionTitle}>Operations</h2>
            <OperationsPanel />
          </section>
        )}

        <section
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: 14,
          }}
        >
          <EventLog events={events} streamStatus={streamStatus} />
        </section>

        <details>
          <summary style={{ cursor: 'pointer', color: 'var(--text-muted)', fontSize: 13 }}>
            Raw snapshot JSON
          </summary>
          <pre
            className="mono"
            style={{
              marginTop: 8,
              padding: 12,
              background: 'var(--surface-raised)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              overflowX: 'auto',
              fontSize: 12,
            }}
          >
            {snapshot ? JSON.stringify(snapshot, null, 2) : 'loading…'}
          </pre>
        </details>
      </main>
    </div>
  )
}

const sectionTitle: CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  letterSpacing: 0.1,
  margin: '0 0 12px',
}

const headerButtonStyle: CSSProperties = {
  background: 'var(--surface-raised)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  color: 'var(--text-muted)',
  fontSize: 12,
  padding: '5px 10px',
  cursor: 'pointer',
}

/**
 * Tab buttons for the Topology/Nodes switcher that replaced stacking the
 * node table below the diagram: an underline-style tab (active = accent
 * underline, matching the header's own accent-colored top border) rather
 * than a boxed/pill tab, so switching views doesn't also redraw a card
 * border around whichever is active — one less visual change competing
 * with the content swap itself.
 */
function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: 'none',
        border: 'none',
        borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
        color: active ? 'var(--text)' : 'var(--text-muted)',
        fontWeight: active ? 600 : 500,
        fontSize: 14,
        padding: '6px 2px',
        marginBottom: -1,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  )
}

/**
 * The always-visible sidebar this replaced (a 260px-wide column showing
 * every source's health, all the time, whether or not anything was wrong)
 * cost real width on every screen for information that is almost always
 * "reachable, nothing to see" — see Memory on the whitespace-reduction
 * pass this came out of. The collapsed state is just a status dot plus a
 * word; the detail (SourceHealthPanel: which source, when it last
 * succeeded, what the last error was) is one click away in a popover,
 * open only when there's a reason to check it.
 */
function SourcesButton({
  health,
  marginLeft,
}: {
  health: Snapshot['health'] | undefined
  marginLeft: number | 'auto'
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    function onPointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const summary = summarizeSourceHealth(health)

  return (
    <div ref={rootRef} style={{ position: 'relative', marginLeft }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="mono"
        style={{ ...headerButtonStyle, display: 'flex', alignItems: 'center', gap: 7 }}
        aria-expanded={open}
        title={summary.label}
      >
        <StatusDot color={summary.color} />
        Sources
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            right: 0,
            top: 'calc(100% + 6px)',
            width: 280,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: 14,
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.25)',
            zIndex: 10,
          }}
        >
          {health ? <SourceHealthPanel health={health} /> : <Loading />}
        </div>
      )}
    </div>
  )
}

function Loading() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)' }}>
      <StatusDot color="var(--status-drift)" />
      loading…
    </div>
  )
}
