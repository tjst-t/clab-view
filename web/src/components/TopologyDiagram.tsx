import cytoscape from 'cytoscape'
import dagre from 'cytoscape-dagre'
import type { Core, ElementDefinition, NodeSingular, StylesheetJsonBlock } from 'cytoscape'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SnapshotLink, SnapshotNode } from '../api/types'
import { statusColorHex, statusLabel } from './colors'
import { StatusDot } from './StatusDot'

cytoscape.use(dagre)

// Literal hex twins of this palette's dark-surface tokens (see
// statusColorHex's doc comment for why Cytoscape needs literals, not
// var(--x) references).
const SURFACE_RAISED = '#1b2227'
const BORDER = '#262f35'
const TEXT = '#e4e9ec'
const TEXT_FAINT = '#5a656b'

// A small chip/device glyph, shown as a corner badge on nodes that carry a
// device-plugin overlay (internal/aggregate's PluginOverlay) — i.e. a
// resource the plugin itself reports on, distinct from what containerlab or
// Sakutei see. Drawn as a tiny inline SVG so it tracks the dark palette
// exactly rather than pulling in an icon font/library for one glyph.
const PLUGIN_BADGE = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">` +
    `<rect x="7" y="7" width="10" height="10" rx="1.5" fill="none" stroke="${TEXT}" stroke-width="2"/>` +
    `<path d="M9 7V3M15 7V3M9 21v-4M15 21v-4M7 9H3M7 15H3M21 9h-4M21 15h-4" stroke="${TEXT}" stroke-width="2" stroke-linecap="round"/>` +
    `</svg>`,
)}`

// Device role, used only to pick the node's shape -- a visual hint drawn
// from the same place network diagrams conventionally put it (shape =
// function, color = status; see the diagram's Legend). Derived from
// containerlab's own `labels.role` when the topology sets it, and
// otherwise guessed from `kind`/`image` so a topology that hasn't bothered
// with `labels` still gets reasonable shapes. "unknown" is a legitimate,
// common result (most containerlab kinds say nothing about function) and
// renders identically to "switch" -- it is not treated as an error.
type Role = 'switch' | 'router' | 'firewall' | 'server' | 'unknown'

const ROLE_ALIASES: Record<string, Role> = {
  switch: 'switch',
  router: 'router',
  firewall: 'firewall',
  server: 'server',
  host: 'server',
}

function inferRole(n: SnapshotNode): Role {
  const explicit = n.labels?.role?.toLowerCase()
  if (explicit && explicit in ROLE_ALIASES) return ROLE_ALIASES[explicit]
  const hay = `${n.kind ?? ''} ${n.image ?? ''}`.toLowerCase()
  if (/firewall|\bfw\b/.test(hay)) return 'firewall'
  if (/srl|ceos|eos|nxos|\bios\b|junos|\bvr-|router|switch/.test(hay)) return 'switch'
  if (/linux|alpine|ubuntu|debian|host|server/.test(hay)) return 'server'
  return 'unknown'
}

const ROLE_SHAPE: Record<Role, string> = {
  switch: 'round-rectangle',
  router: 'hexagon',
  firewall: 'diamond',
  server: 'rectangle',
  unknown: 'round-rectangle',
}

// Shapes without a flat top/bottom edge (diamond, hexagon) swallow a label
// drawn through their own center, so those roles get a fixed small glyph
// size with the label placed underneath instead of a label-sized box.
const COMPACT_ROLES = new Set<Role>(['router', 'firewall'])

function nodeElement(n: SnapshotNode): ElementDefinition {
  const role = inferRole(n)
  return {
    group: 'nodes',
    data: {
      id: n.name,
      label: n.name,
      borderColor: statusColorHex(n.color),
      statusLabel: statusLabel(n.color),
      hasPlugin: Boolean(n.plugin),
      kind: n.kind ?? '',
      state: n.state ?? '',
      role,
      compact: COMPACT_ROLES.has(role),
    },
  }
}

function linkId(l: SnapshotLink, i: number): string {
  // containerlab links have no natural id of their own; the endpoint pair
  // is stable across polls as long as the topology itself doesn't change,
  // which is what the diff below relies on. Fall back to the index only if
  // an endpoint is missing a node name (shouldn't happen in practice).
  if (l.a.node && l.b.node) {
    return [l.a.node, l.a.interface ?? '', l.b.node, l.b.interface ?? ''].join('|')
  }
  return `link-${i}`
}

// Orients the link for the layout engine only (source = the lower-tier /
// hub-ward endpoint): dagre ranks nodes from a directed graph, and the
// diagram's layering is computed independently in internal/aggregate's
// layout.go, not by dagre itself. The visual style never draws an
// arrowhead, so this directionality is invisible -- containerlab links
// have no inherent direction. Equal-tier endpoints (e.g. two hubs linked
// to each other) are ordered by name só the choice is deterministic.
function linkElement(
  l: SnapshotLink,
  i: number,
  tierOf: Map<string, number>,
): ElementDefinition | null {
  if (!l.a.node || !l.b.node) return null
  const tierA = tierOf.get(l.a.node) ?? 0
  const tierB = tierOf.get(l.b.node) ?? 0
  const [source, target] =
    tierA < tierB || (tierA === tierB && l.a.node <= l.b.node)
      ? [l.a.node, l.b.node]
      : [l.b.node, l.a.node]
  return {
    group: 'edges',
    data: {
      id: linkId(l, i),
      source,
      target,
      tierDelta: Math.abs(tierA - tierB),
      label: [l.a.interface, l.b.interface].filter(Boolean).join(' ↔ '),
    },
  }
}

const STYLE: StylesheetJsonBlock[] = [
  {
    selector: 'node',
    style: {
      shape: 'data(shape)' as unknown as cytoscape.Css.NodeShape,
      width: 'label',
      height: 34,
      padding: '10px',
      'background-color': SURFACE_RAISED,
      'border-width': 3,
      'border-color': 'data(borderColor)',
      label: 'data(label)',
      color: TEXT,
      'font-family': 'ui-monospace, Consolas, monospace',
      'font-size': 12,
      'text-valign': 'center',
      'text-halign': 'center',
    },
  },
  {
    selector: 'node[?compact]',
    style: {
      width: 30,
      height: 30,
      padding: '0px',
      'text-valign': 'bottom',
      'text-margin-y': 6,
    },
  },
  {
    selector: 'node[?hasPlugin]',
    style: {
      'background-image': PLUGIN_BADGE,
      'background-width': 14,
      'background-height': 14,
      'background-position-x': '100%',
      'background-position-y': '100%',
      'background-offset-x': -2,
      'background-offset-y': -2,
      'background-fit': 'none',
      'background-clip': 'none',
      'background-repeat': 'no-repeat',
      'padding-right': '20px',
    },
  },
  {
    selector: 'node[?compact][?hasPlugin]',
    style: {
      'padding-right': '0px',
      'background-offset-x': 0,
      'background-offset-y': 0,
      'background-position-x': '100%',
      'background-position-y': '0%',
    },
  },
  {
    selector: 'node:selected',
    style: {
      'border-width': 4,
      'overlay-color': TEXT,
      'overlay-opacity': 0.12,
      'overlay-padding': 6,
    },
  },
  {
    selector: 'node.dimmed',
    style: { opacity: 0.2 },
  },
  {
    selector: 'edge',
    style: {
      // Straight lines over curved/orthogonal ones: per 「ネットワーク図の描き方入門」
      // (ch. 4 on link rendering), curved or bent links make a fan-out pattern
      // harder to trace back to its source than straight lines do, even though
      // straight lines cross more often -- the crossings themselves are easier
      // to read through than a bend is.
      width: 1.5,
      'line-color': BORDER,
      'curve-style': 'straight',
      'target-arrow-shape': 'none',
      label: 'data(label)',
      'font-size': 9,
      color: TEXT_FAINT,
      'font-family': 'ui-monospace, Consolas, monospace',
      'text-background-color': '#0d1013',
      'text-background-opacity': 0.85,
      'text-background-padding': '2px',
    },
  },
  {
    selector: 'edge.dimmed',
    style: { opacity: 0.08 },
  },
]

interface Props {
  nodes: SnapshotNode[]
  links: SnapshotLink[]
}

/**
 * The topology diagram: containerlab's nodes and links, rendered with
 * Cytoscape.js in a hierarchical layering driven by the backend's computed
 * `tier` (internal/aggregate/layout.go), node shape hinting function
 * (switch/router/firewall/server, from `labels.role` or a `kind` guess),
 * node borders colored by the same ok/drift/down vocabulary as the rest of
 * the app (see colors.ts), and a small corner badge on nodes the device
 * plugin also reports on.
 *
 * Keeps one persistent cytoscape.Core across snapshot updates (does not
 * tear down and recreate it on every poll): node/edge data is patched
 * in-place, and layout only re-runs when the set of node/edge ids actually
 * changes, so a color flip (e.g. a disturb/fix demo action) never resets
 * the user's pan/zoom or reshuffles the layout.
 */
export function TopologyDiagram({ nodes, links }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const cyRef = useRef<Core | null>(null)
  const [selected, setSelected] = useState<SnapshotNode | null>(null)
  const [filter, setFilter] = useState('')

  const roles = useMemo(() => {
    const present = new Set((nodes ?? []).map(inferRole))
    return (['switch', 'router', 'firewall', 'server'] as const).filter((r) => present.has(r))
  }, [nodes])

  // Create the cytoscape instance once.
  useEffect(() => {
    if (!containerRef.current) return
    const cy = cytoscape({
      container: containerRef.current,
      style: STYLE,
      elements: [],
      wheelSensitivity: 0.25,
      minZoom: 0.3,
      maxZoom: 2.5,
    })
    cyRef.current = cy
    return () => {
      cy.destroy()
      cyRef.current = null
    }
  }, [])

  // Keep the "selected node" side panel in sync with clicks, independent of
  // the snapshot-diffing effect below.
  useEffect(() => {
    const cy = cyRef.current
    if (!cy) return
    const handler = (evt: cytoscape.EventObject) => {
      const n = evt.target as NodeSingular
      const found = (nodes ?? []).find((x) => x.name === n.id())
      setSelected(found ?? null)
    }
    const clearHandler = () => setSelected(null)
    cy.on('tap', 'node', handler)
    cy.on('tap', (evt) => {
      if (evt.target === cy) clearHandler()
    })
    return () => {
      cy.removeListener('tap')
    }
    // Re-bind whenever `nodes` changes so the closure's lookup stays fresh;
    // this is cheap (cytoscape's own element set is untouched here).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes])

  // Keep the detail panel current when the snapshot refreshes a node that's
  // already selected (e.g. a disturb/fix action changing its state) —
  // without this, clicking a node once would freeze its panel at that
  // moment's data.
  useEffect(() => {
    setSelected((prev) => {
      if (!prev) return prev
      return (nodes ?? []).find((n) => n.name === prev.name) ?? null
    })
  }, [nodes])

  // Diff the new snapshot into the existing cytoscape graph.
  useEffect(() => {
    const cy = cyRef.current
    if (!cy) return

    const tierOf = new Map((nodes ?? []).map((n) => [n.name, n.tier]))
    const wantNodes = new Map((nodes ?? []).map((n) => [n.name, n]))
    const wantEdges = new Map(
      (links ?? [])
        .map((l, i) => [linkId(l, i), l] as const)
        .filter(([, l]) => l.a.node && l.b.node),
    )

    let structureChanged = false

    cy.batch(() => {
      // Remove stale elements.
      cy.nodes().forEach((el) => {
        if (!wantNodes.has(el.id())) {
          el.remove()
          structureChanged = true
        }
      })
      cy.edges().forEach((el) => {
        if (!wantEdges.has(el.id())) {
          el.remove()
          structureChanged = true
        }
      })

      // Add/update nodes.
      for (const [id, n] of wantNodes) {
        const role = inferRole(n)
        const existing = cy.getElementById(id)
        if (existing.nonempty()) {
          existing.data({
            borderColor: statusColorHex(n.color),
            statusLabel: statusLabel(n.color),
            hasPlugin: Boolean(n.plugin),
            kind: n.kind ?? '',
            state: n.state ?? '',
            role,
            compact: COMPACT_ROLES.has(role),
            shape: ROLE_SHAPE[role],
          })
        } else {
          const el = nodeElement(n)
          el.data.shape = ROLE_SHAPE[role]
          cy.add(el)
          structureChanged = true
        }
      }

      // Add/update edges (links carry no mutable state today, but keep the
      // same add-if-missing shape as nodes for consistency).
      for (const [id, l] of wantEdges) {
        if (cy.getElementById(id).empty()) {
          const el = linkElement(l, 0, tierOf)
          if (el) {
            el.data.id = id
            cy.add(el)
            structureChanged = true
          }
        }
      }
    })

    if (structureChanged) {
      cy.layout({
        name: 'dagre',
        animate: false,
        fit: true,
        padding: 40,
        rankDir: 'TB',
        nodeSep: 36,
        rankSep: 70,
        align: 'UL',
        nodeDimensionsIncludeLabels: true,
        minLen: (edge: cytoscape.EdgeSingular) => (edge.data('tierDelta') as number) || 0,
      } as cytoscape.LayoutOptions).run()
    }
  }, [nodes, links])

  // Dim nodes/edges that don't match the filter text, instead of removing
  // them -- keeps the layout stable while narrowing attention.
  useEffect(() => {
    const cy = cyRef.current
    if (!cy) return
    const q = filter.trim().toLowerCase()
    cy.batch(() => {
      if (!q) {
        cy.elements().removeClass('dimmed')
        return
      }
      cy.nodes().forEach((n) => {
        const hay = `${n.id()} ${n.data('kind') ?? ''} ${n.data('role') ?? ''}`.toLowerCase()
        n.toggleClass('dimmed', !hay.includes(q))
      })
      cy.edges().forEach((e) => {
        const dim = e.source().hasClass('dimmed') || e.target().hasClass('dimmed')
        e.toggleClass('dimmed', dim)
      })
    })
  }, [filter, nodes, links])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="filter nodes…"
        className="mono"
        style={{
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          color: 'var(--text)',
          fontSize: 12,
          padding: '6px 10px',
          width: 220,
        }}
      />
      <div style={{ display: 'flex', gap: 16 }}>
        <div
          ref={containerRef}
          style={{
            flex: 1,
            height: 420,
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: 6,
          }}
        />
        <div
          style={{
            width: 220,
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <Legend roles={roles} />
          {selected ? <NodeDetail node={selected} /> : null}
        </div>
      </div>
    </div>
  )
}

const LEGEND_COLORS = ['ok', 'drift', 'down', 'workflow', 'unknown'] as const

const ROLE_LABEL: Record<Role, string> = {
  switch: 'switch',
  router: 'router',
  firewall: 'firewall',
  server: 'server',
  unknown: 'unknown',
}

function Legend({ roles }: { roles: readonly Role[] }) {
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        fontSize: 12,
      }}
    >
      {LEGEND_COLORS.map((c) => (
        <div key={c} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <StatusDot color={statusColorHex(c)} />
          <span style={{ color: 'var(--text-muted)' }}>{statusLabel(c)}</span>
        </div>
      ))}
      {roles.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            marginTop: 4,
            paddingTop: 6,
            borderTop: '1px solid var(--border)',
          }}
        >
          {roles.map((r) => (
            <div key={r} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <ShapeGlyph shape={ROLE_SHAPE[r]} />
              <span style={{ color: 'var(--text-muted)' }}>{ROLE_LABEL[r]}</span>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
        <span
          className="mono"
          style={{
            display: 'inline-block',
            width: 9,
            height: 9,
            border: '1.5px solid var(--text)',
            borderRadius: 2,
          }}
        />
        <span style={{ color: 'var(--text-muted)' }}>has a device-plugin overlay</span>
      </div>
    </div>
  )
}

const SHAPE_BORDER_RADIUS: Record<string, number> = {
  'round-rectangle': 3,
  rectangle: 0,
}

function ShapeGlyph({ shape }: { shape: string }) {
  const base = {
    display: 'inline-block',
    width: 10,
    height: 10,
    border: '1.5px solid var(--text-muted)',
    flexShrink: 0,
  } as const
  if (shape === 'diamond') {
    return <span style={{ ...base, transform: 'rotate(45deg)' }} />
  }
  if (shape === 'hexagon') {
    return (
      <span
        style={{
          ...base,
          clipPath: 'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)',
        }}
      />
    )
  }
  return <span style={{ ...base, borderRadius: SHAPE_BORDER_RADIUS[shape] ?? 2 }} />
}

function NodeDetail({ node }: { node: SnapshotNode }) {
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
      }}
    >
      <div className="mono" style={{ fontWeight: 600 }}>
        {node.name}
      </div>
      <Row label="kind" value={node.kind} />
      <Row label="containerlab" value={[node.state, node.status].filter(Boolean).join(' / ')} />
      <Row label="status" value={statusLabel(node.color)} />
      {node.sakutei && (
        <Row
          label="sakutei"
          value={[node.sakutei.state, node.sakutei.drifted_fields?.join(', ')]
            .filter(Boolean)
            .join(': ')}
        />
      )}
      {node.plugin && (
        <Row
          label="plugin"
          value={[node.plugin.state, node.plugin.drifted_fields?.join(', ')]
            .filter(Boolean)
            .join(': ')}
        />
      )}
    </div>
  )
}

function Row({ label, value }: { label: string; value?: string }) {
  if (!value) return null
  return (
    <div>
      <span style={{ color: 'var(--text-faint)' }}>{label}: </span>
      <span>{value}</span>
    </div>
  )
}
