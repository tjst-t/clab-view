import { useMemo, useState, type CSSProperties } from 'react'
import type { SnapshotNode } from '../api/types'
import { statusColor, statusLabel } from './colors'
import { NodeDetail } from './NodeDetail'
import { StatusDot } from './StatusDot'

/**
 * The Nodes tab's table. Row click used to do nothing at all -- a table
 * that shows the same handful of columns the diagram's own node labels
 * already imply, with no way to drill into anything beyond them, isn't
 * much of a second view on the same data. Clicking a row now opens the
 * same NodeDetail panel the topology diagram's node-click already shows,
 * so the table earns its place as a real alternative to the diagram
 * (sortable/scannable by name) rather than a flatter restatement of it.
 */
export function NodeList({ nodes, filter }: { nodes: SnapshotNode[]; filter: string }) {
  const [selected, setSelected] = useState<SnapshotNode | null>(null)

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return nodes
    return nodes.filter((n) => {
      const hay = `${n.name} ${n.kind ?? ''} ${n.group ?? ''}`.toLowerCase()
      return hay.includes(q)
    })
  }, [nodes, filter])

  // Keep the open detail panel in sync with a refreshed snapshot (e.g. a
  // disturb/fix action changing the selected node's state), and drop it if
  // the selected node disappeared or got filtered out -- same reasoning as
  // TopologyDiagram's own "keep the panel current" effect.
  const selectedCurrent = selected ? filtered.find((n) => n.name === selected.name) ?? null : null

  if (nodes.length === 0) {
    return <p style={{ color: 'var(--text-muted)' }}>No nodes in the current topology.</p>
  }

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--text-muted)' }}>
            <th style={th}>Node</th>
            <th style={th}>Kind</th>
            <th style={th}>containerlab</th>
            <th style={th}>Status</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((n) => {
            const isSelected = selectedCurrent?.name === n.name
            return (
              <tr
                key={n.name}
                onClick={() => setSelected((prev) => (prev?.name === n.name ? null : n))}
                style={{
                  borderTop: '1px solid var(--border)',
                  cursor: 'pointer',
                  background: isSelected ? 'var(--surface-raised)' : undefined,
                }}
              >
                <td className="mono" style={td}>
                  {n.name}
                </td>
                <td style={{ ...td, color: 'var(--text-muted)' }}>{n.kind ?? '—'}</td>
                <td style={{ ...td, color: 'var(--text-muted)' }}>
                  {n.state ?? '—'}
                  {n.status ? ` (${n.status})` : ''}
                </td>
                <td style={td}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <StatusDot color={statusColor(n.color)} />
                    {statusLabel(n.color)}
                    {n.sakutei?.drifted_fields?.length ? (
                      <span className="mono" style={{ color: 'var(--text-faint)', fontSize: 12 }}>
                        ({n.sakutei.drifted_fields.join(', ')})
                      </span>
                    ) : null}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {filtered.length === 0 && (
        <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No nodes match the current filter.</p>
      )}
      {selectedCurrent && (
        <div style={{ width: 230, flexShrink: 0 }}>
          <NodeDetail node={selectedCurrent} onClose={() => setSelected(null)} />
        </div>
      )}
    </div>
  )
}
const th: CSSProperties = { padding: '6px 10px 6px 0', fontWeight: 500 }
const td: CSSProperties = { padding: '8px 10px 8px 0' }
