import type { SnapshotNode } from '../api/types'
import { statusLabel } from './colors'

/**
 * A node's full detail: containerlab's own reported state plus each data
 * source's provider-level status (Sakutei, the device plugin) -- the full
 * picture a node's color in the diagram/list is actually derived from.
 * Shared between TopologyDiagram's floating detail panel (clicking a node
 * in the graph) and NodeList's panel (clicking a row in the Nodes tab):
 * the Nodes tab previously had no reaction to a click at all, which made
 * the table close to pointless next to the diagram -- it shows the same
 * detail a diagram click does, not a cut-down version of it.
 */
export function NodeDetail({ node, onClose }: { node: SnapshotNode; onClose?: () => void }) {
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: 12,
        fontSize: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        background: 'var(--surface)',
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.25)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="mono" style={{ fontWeight: 600, flex: 1 }}>
          {node.name}
        </span>
        {onClose && <CloseButton onClick={onClose} />}
      </div>
      <Row label="kind" value={node.kind} />
      <Row label="group" value={node.group} />
      <Row label="containerlab" value={[node.state, node.status].filter(Boolean).join(' / ')} />
      <Row label="status" value={statusLabel(node.color)} />
      {node.sakutei && (
        <Row
          label="sakutei"
          value={[node.sakutei.state, node.sakutei.drifted_fields?.join(', ')].filter(Boolean).join(': ')}
        />
      )}
      {node.plugin && (
        <Row
          label="plugin"
          value={[node.plugin.state, node.plugin.drifted_fields?.join(', ')].filter(Boolean).join(': ')}
        />
      )}
    </div>
  )
}

/** A small "×" close control, shared by every floating detail/legend
 * panel this view pops open over the canvas. */
export function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="close"
      style={{
        background: 'none',
        border: 'none',
        color: 'var(--text-faint)',
        cursor: 'pointer',
        fontSize: 15,
        lineHeight: 1,
        padding: 2,
      }}
    >
      ×
    </button>
  )
}

export function Row({ label, value }: { label: string; value?: string }) {
  if (!value) return null
  return (
    <div>
      <span style={{ color: 'var(--text-faint)' }}>{label}: </span>
      <span>{value}</span>
    </div>
  )
}
