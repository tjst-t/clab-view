import cytoscape from 'cytoscape'
import dagre from 'cytoscape-dagre'
import type { Core, EdgeSingular, ElementDefinition, NodeSingular, StylesheetJsonBlock } from 'cytoscape'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SnapshotLink, SnapshotNode } from '../api/types'
import type { Theme } from '../theme'
import { statusColorHex, statusLabel } from './colors'
import { CloseButton, NodeDetail, Row } from './NodeDetail'
import { StatusDot } from './StatusDot'

cytoscape.use(dagre)

// Literal hex twins of this palette's --bg/--surface-raised/--border/--text
// tokens (see statusColorHex's doc comment for why Cytoscape needs
// literals, not var(--x) references): Cytoscape renders to its own canvas
// and never sees the page's CSS custom properties. Kept distinct per theme
// for the same reason colors.ts's STATUS_HEX is -- a tone tuned to read as
// "subtle structure" against a near-black canvas can be nearly invisible
// against a near-black canvas's lighter cousin, and vice versa for light.
const THEME_HEX: Record<
  Theme,
  { bg: string; surfaceRaised: string; linkColor: string; text: string; textFaint: string; accent: string }
> = {
  dark: {
    bg: '#0d1013',
    surfaceRaised: '#202830',
    linkColor: '#5b6a75',
    text: '#f0f3f5',
    textFaint: '#8d9aa2',
    accent: '#5fd4d0',
  },
  light: {
    bg: '#f5f6f7',
    surfaceRaised: '#eef1f3',
    linkColor: '#7b8793',
    text: '#14181b',
    textFaint: '#55616b',
    accent: '#0d7d78',
  },
}

// A sans-serif, UI-matching font for on-canvas text (node/edge labels):
// Cytoscape renders to its own canvas and can't read the page's
// var(--font-ui), so this is a literal twin of it (same reasoning as
// THEME_HEX). Chosen over the app's monospace font specifically for the
// diagram's labels -- at the small sizes a busy topology forces labels
// down to, a UI sans-serif reads more legibly than a fixed-width font
// (which trades legibility for alignment, useful for the detail panels'
// "mono" identifiers elsewhere in the app, not for prose-like device
// names here).
const FONT_UI = '-apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif'

// A categorical palette for containerlab `group:` frames -- distinct from
// both the five-color status vocabulary (ok/drift/down/workflow/neutral)
// and the one brand accent, so a group's color is never mistaken for a
// status signal. A group's color is assigned by buildGroupColors below,
// by each group name's position in alphabetical order, not by a hash of
// the name: a short-string hash mod a small palette collides often in
// practice (an earlier version of this used hashString, which put 3 of 4
// groups in a real topology on the exact same color -- defeating the
// point of a categorical palette), while alphabetical order guarantees
// every group gets a *distinct* color as long as there are no more groups
// than palette entries, and is still fully deterministic (same group set
// -> same assignment, every render/reload) without needing any
// content-addressed hash to get there. Light-theme entries are darkened
// versions of the same hues (same reasoning as the status/STATUS_HEX
// palettes), not a plain invert, so each still clears a readable contrast
// ratio against a near-white surface.
const GROUP_PALETTE: Record<Theme, string[]> = {
  dark: ['#a78bfa', '#f472b6', '#67c9a3', '#60a5fa', '#e879f9', '#c9976b'],
  light: ['#6d43d1', '#c2255c', '#0f7a5c', '#1d4ed8', '#a21caf', '#8a5a2b'],
}

function buildGroupColors(theme: Theme, groupNames: Iterable<string>): Map<string, string> {
  const palette = GROUP_PALETTE[theme]
  const sorted = [...groupNames].sort()
  const map = new Map<string, string>()
  sorted.forEach((g, i) => map.set(g, palette[i % palette.length]))
  return map
}

// A small chip/device glyph, shown as a corner badge on nodes that carry a
// device-plugin overlay (internal/aggregate's PluginOverlay) — i.e. a
// resource the plugin itself reports on, distinct from what containerlab or
// Sakutei see. Drawn as a tiny inline SVG so it tracks the active theme's
// text color exactly rather than pulling in an icon font/library for one
// glyph.
function pluginBadge(textHex: string): string {
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">` +
      `<rect x="7" y="7" width="10" height="10" rx="1.5" fill="none" stroke="${textHex}" stroke-width="2"/>` +
      `<path d="M9 7V3M15 7V3M9 21v-4M15 21v-4M7 9H3M7 15H3M21 9h-4M21 15h-4" stroke="${textHex}" stroke-width="2" stroke-linecap="round"/>` +
      `</svg>`,
  )}`
}

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

// A node's on-diagram label: the hostname, plus -- when containerlab
// reports a `kind` -- a second line underneath it. This mirrors a
// convention that shows up throughout 「ネットワーク図の描き方入門」's physical
// diagrams (every device box is drawn as "hostname" over "vendor + model"):
// containerlab has no vendor/model of its own, but `kind` (e.g.
// "nokia_srlinux", "linux", "ceos") is the closest honest equivalent --
// what kind of thing this box actually is, not just its name. `image` is
// deliberately not used here (registry paths are often long enough to blow
// up the node's width for no real readability gain); `kind` alone is
// enough to tell boxes apart in a busy diagram.
function nodeLabel(n: SnapshotNode): string {
  return n.kind ? `${n.name}\n${n.kind}` : n.name
}

function nodeElement(n: SnapshotNode, theme: Theme): ElementDefinition {
  const role = inferRole(n)
  return {
    group: 'nodes',
    data: {
      id: n.name,
      label: nodeLabel(n),
      borderColor: statusColorHex(n.color, theme),
      statusLabel: statusLabel(n.color),
      hasPlugin: Boolean(n.plugin),
      kind: n.kind ?? '',
      state: n.state ?? '',
      group: n.group ?? '',
      role,
      compact: COMPACT_ROLES.has(role),
      // The backend's own tier number (internal/aggregate/layout.go),
      // not re-derived from the node's rendered/layout position --
      // compactRanks below buckets nodes into "the same rank" by this
      // value rather than by rounding position().y, because dagre's
      // 'UL' alignment does not give every node in a rank the exact same
      // rendered y once node heights differ (e.g. a compact firewall
      // glyph vs. a normal-height switch box both on tier 1): rounding
      // the rendered y split what was conceptually one rank into two,
      // silently defeating both of clusterRanksByGroup's passes for any
      // rank mixing compact and non-compact nodes.
      tier: n.tier,
    },
  }
}

// Per-link-type line styling, applied as Cytoscape edge selectors in
// buildStyle -- the diagram's equivalent of a physical diagram's
// connector/cable legend. containerlab's own link `type` discriminator
// ("veth", "macvlan", "mgmt-net", "host", "dummy", "vxlan", ...) is used
// as-is: this deliberately does not invent physical connector names
// (RJ45/SFP/...) that containerlab's virtual links have no real analog
// for. "veth" (by far the most common case, and the implicit default for
// any classic-form link) and any type this table doesn't recognize both
// render as a plain solid line -- the same as before this existed -- so a
// topology that only ever uses veth links looks unchanged.
const LINK_TYPE_VISUALS: Record<string, { lineStyle: 'dashed' | 'dotted'; dashPattern?: number[] }> = {
  macvlan: { lineStyle: 'dotted' }, // shares a host NIC rather than a dedicated point-to-point link
  host: { lineStyle: 'dashed', dashPattern: [2, 2] }, // attaches to a host interface, not another node
  'mgmt-net': { lineStyle: 'dashed', dashPattern: [2, 2] }, // attaches to containerlab's shared mgmt bridge
  vxlan: { lineStyle: 'dashed', dashPattern: [8, 4] }, // an overlay/tunnel, not a direct link
  dummy: { lineStyle: 'dashed', dashPattern: [1, 2] }, // a placeholder/reserved interface
}

// edgeGroupKey identifies the *unordered pair of nodes plus link type* a
// link belongs to, not the individual link -- two (or more) links of the
// same type between the same two nodes are containerlab's way of
// expressing a bundle (a link-aggregation group in the physical world),
// and are merged into a single drawn edge by buildEdgeGroups/
// edgeElementFromGroup below, same as a physical diagram draws one line
// with a link-aggregation symbol instead of N crossing parallel lines.
// Returns null for a link missing an endpoint node name (nothing to key
// it by).
function edgeGroupKey(l: SnapshotLink): string | null {
  if (!l.a.node || !l.b.node) return null
  const type = l.type || 'veth'
  const pair = [l.a.node, l.b.node].sort()
  return `${type}|${pair[0]}|${pair[1]}`
}

function buildEdgeGroups(links: SnapshotLink[] | undefined): Map<string, SnapshotLink[]> {
  const groups = new Map<string, SnapshotLink[]>()
  for (const l of links ?? []) {
    const key = edgeGroupKey(l)
    if (!key) continue
    const arr = groups.get(key)
    if (arr) {
      arr.push(l)
    } else {
      groups.set(key, [l])
    }
  }
  return groups
}

function lagLabel(count: number): string {
  return `LAG ×${count}`
}

function linkLabel(l: SnapshotLink): string {
  return [l.a.interface, l.b.interface].filter(Boolean).join(' ↔ ')
}

// Orients the edge for the layout engine only (source = the lower-tier /
// hub-ward endpoint): dagre ranks nodes from a directed graph, and the
// diagram's layering is computed independently in internal/aggregate's
// layout.go, not by dagre itself. The visual style never draws an
// arrowhead, so this directionality is invisible -- containerlab links
// have no inherent direction. Equal-tier endpoints (e.g. two hubs linked
// to each other) are ordered by name só the choice is deterministic.
function edgeElementFromGroup(
  key: string,
  group: SnapshotLink[],
  tierOf: Map<string, number>,
): ElementDefinition | null {
  const first = group[0]
  if (!first.a.node || !first.b.node) return null
  const tierA = tierOf.get(first.a.node) ?? 0
  const tierB = tierOf.get(first.b.node) ?? 0
  const [source, target] =
    tierA < tierB || (tierA === tierB && first.a.node <= first.b.node)
      ? [first.a.node, first.b.node]
      : [first.b.node, first.a.node]
  const isLag = group.length > 1
  return {
    group: 'edges',
    data: {
      id: key,
      source,
      target,
      tierDelta: Math.abs(tierA - tierB),
      // Only a LAG bundle's label is drawn on the canvas by default (the
      // "LAG ×N" pill, which already carries its own background and is a
      // single label per bundle, not one per raw link). A plain single
      // link's interface pair is still computed (ifacePair) but left out
      // of the on-canvas label -- with dozens of links radiating from a
      // hub node, labeling every one of them is what caused the diagram's
      // text to pile up illegibly; that detail is available on click
      // instead (see LinkDetail), the same click-for-detail pattern nodes
      // already use.
      label: isLag ? lagLabel(group.length) : '',
      linkType: first.type || 'veth',
      isLag,
      lagCount: group.length,
      ifacePair: linkLabel(first),
      members: group.map(linkLabel),
    },
  }
}

function buildStyle(theme: Theme): StylesheetJsonBlock[] {
  const hex = THEME_HEX[theme]
  return [
    {
      selector: 'node',
      style: {
        shape: 'data(shape)' as unknown as cytoscape.Css.NodeShape,
        width: 'label',
        height: 34,
        padding: '12px',
        'background-color': hex.surfaceRaised,
        'border-width': 3,
        'border-color': 'data(borderColor)',
        label: 'data(label)',
        color: hex.text,
        'font-family': FONT_UI,
        'font-size': 13,
        'font-weight': 600,
        'text-valign': 'center',
        'text-halign': 'center',
        'text-wrap': 'wrap',
        'text-max-width': '170px',
        'line-height': 1.3,
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
        'background-image': pluginBadge(hex.text),
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
        'overlay-color': hex.text,
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
        width: 1.75,
        'line-color': hex.linkColor,
        'curve-style': 'straight',
        'target-arrow-shape': 'none',
        label: 'data(label)',
        'font-size': 10,
        color: hex.text,
        'font-family': FONT_UI,
        'text-background-color': hex.bg,
        'text-background-opacity': 0.9,
        'text-background-padding': '2px',
      },
    },
    // Per-link-type line styles (see LINK_TYPE_VISUALS's doc comment) --
    // one selector per known type, each only touching line-style/
    // line-dash-pattern so everything else (color, label, width) still
    // comes from the base 'edge' rule above.
    ...Object.entries(LINK_TYPE_VISUALS).map(([type, v]) => ({
      selector: `edge[linkType = "${type}"]`,
      style: {
        'line-style': v.lineStyle,
        ...(v.dashPattern ? { 'line-dash-pattern': v.dashPattern } : {}),
      },
    })),
    {
      // A link-aggregation bundle (edgeGroupKey merged 2+ same-type links
      // between the same node pair): drawn thicker, with its "LAG ×N"
      // label styled as a bordered pill -- the diagram's equivalent of a
      // physical diagram's oval link-aggregation symbol.
      selector: 'edge[?isLag]',
      style: {
        width: 3,
        'font-weight': 'bold',
        'text-background-shape': 'roundrectangle',
        'text-background-opacity': 1,
        'text-background-padding': '4px',
        'text-border-width': 1,
        'text-border-color': hex.linkColor,
        'text-border-opacity': 1,
      },
    },
    {
      selector: 'edge.dimmed',
      style: { opacity: 0.08 },
    },
  ]
}

interface Props {
  nodes: SnapshotNode[]
  links: SnapshotLink[]
  theme: Theme
  filter: string
}

/** The side panel's view of a clicked link/LAG-bundle -- read straight off
 * the tapped edge element's own data (set by edgeElementFromGroup), not
 * re-derived from the `links` prop. */
interface SelectedLink {
  source: string
  target: string
  linkType: string
  isLag: boolean
  members: string[]
}

/** A group-frame box's current on-screen position, in the same (rendered,
 * container-relative) pixel space the overlay <div> draws in. */
interface GroupBox {
  id: string
  label: string
  color: string
  x: number
  y: number
  w: number
  h: number
}

// How far a group frame extends beyond its outermost member's own
// bounding box -- shared between computeGroupBoxes (which draws the
// frame) and clusterRanksByGroup (which, during layout, needs to know
// this same distance to keep two different groups' frames from touching).
const GROUP_FRAME_PAD = 18

// computeGroupBoxes derives each group's bounding frame from its members'
// *current* rendered positions -- recomputed live (see the 'render'
// listener below) rather than laid out itself, so dragging a node, panning,
// or zooming keeps every frame glued to its members without needing its
// own layout pass. A group with fewer than two currently-present members
// draws no frame: a box around a single node would just duplicate that
// node's own border.
function computeGroupBoxes(cy: Core, groups: Map<string, string[]>, theme: Theme): GroupBox[] {
  const colors = buildGroupColors(theme, groups.keys())
  const boxes: GroupBox[] = []
  for (const [group, memberIds] of groups) {
    let col = cy.collection()
    for (const id of memberIds) {
      const el = cy.getElementById(id)
      if (el.nonempty()) col = col.union(el)
    }
    if (col.length < 2) continue
    const bb = col.renderedBoundingBox()
    boxes.push({
      id: group,
      label: group,
      color: colors.get(group) ?? THEME_HEX[theme].text,
      x: bb.x1 - GROUP_FRAME_PAD,
      y: bb.y1 - GROUP_FRAME_PAD,
      w: bb.w + GROUP_FRAME_PAD * 2,
      h: bb.h + GROUP_FRAME_PAD * 2,
    })
  }
  return boxes
}

// Minimum clear space enforced between two *different* clusters' frames
// (containerlab `group:` boundaries) when they land on the same rank --
// independent of GROUP_FRAME_PAD itself, so two frames are never left
// merely touching edge-to-edge.
const GROUP_FRAME_MIN_GAP = 20

// dagre's own x-coordinate assignment can leave a sparse rank (few nodes
// feeding many more below -- e.g. two tier-0 hubs fanning out to a dozen
// descendants) spread far wider than the nodes themselves need: dagre
// balances each node's x against the median of everything it connects to,
// which for a 2-node rank sitting above a wide fan can place the two
// nodes at opposite extremes of the whole diagram even though nothing
// requires that much space between them (this is exactly what a real
// two-spine fabric surfaced -- both spines tied for tier 0, each pushed
// to a far edge of the canvas instead of sitting together).
//
// compactRanks repacks every rank's x-coordinates from scratch after
// layout: same left-to-right order dagre produced, except containerlab
// `group:` members that landed on the same rank are pulled adjacent to
// each other first (the same intent an earlier, reorder-only version of
// this pass had), then the whole rank is packed tightly using each
// node's own rendered width plus a uniform gap (the layout's own nodeSep,
// converted to model space by the current zoom) -- widened only at a
// cluster boundary where at least one side is a real (2+ member) framed
// group, so two different groups' dashed frames still never touch. The
// repacked rank is then shifted so its mean x matches the *original*
// mean x dagre computed for that rank: a rank's rough horizontal
// position relative to the ranks above/below it is preserved, only the
// wasted internal spacing collapses.
function compactRanks(cy: Core, groups: Map<string, string[]>): void {
  const memberOfGroup = new Map<string, string>()
  for (const [g, members] of groups) {
    for (const m of members) memberOfGroup.set(m, g)
  }

  // Bucketed by the backend's own tier number (see nodeElement's doc
  // comment on why this isn't derived from position().y): two nodes
  // dagre placed on the same rank can still end up at slightly different
  // rendered y once their heights differ (e.g. a compact firewall glyph
  // next to a normal-height switch box), which silently split one real
  // rank into two separately-keyed buckets when this rounded y instead.
  const byRank = new Map<number, NodeSingular[]>()
  cy.nodes().forEach((n) => {
    const tier = n.data('tier') as number
    const arr = byRank.get(tier)
    if (arr) arr.push(n)
    else byRank.set(tier, [n])
  })

  // GROUP_FRAME_PAD/GROUP_FRAME_MIN_GAP are rendered-pixel quantities --
  // computeGroupBoxes applies them to renderedBoundingBox() output, i.e.
  // *after* zoom. Node .position().x, by contrast, is model space (before
  // zoom). Converting the target gap into model units via the current
  // zoom (captured once, before this pass's own shifts can change it)
  // keeps the gaps this pass enforces meaningful at whatever scale the
  // diagram ended up fit to.
  const zoom = cy.zoom()
  const baseGap = 56 / zoom
  const clusterGapExtra = (GROUP_FRAME_PAD * 2 + GROUP_FRAME_MIN_GAP) / zoom

  cy.batch(() => {
    for (const rankNodes of byRank.values()) {
      if (rankNodes.length < 2) continue
      const sorted = [...rankNodes].sort((a, b) => a.position().x - b.position().x)
      const originalMean = sorted.reduce((s, n) => s + n.position().x, 0) / sorted.length

      // A group only clusters within a rank where 2+ of its members
      // actually landed on that rank -- a lone member is just its own
      // one-node "cluster", same as an ungrouped node.
      const countInRank = new Map<string, number>()
      for (const n of sorted) {
        const g = memberOfGroup.get(n.id())
        if (!g) continue
        countInRank.set(g, (countInRank.get(g) ?? 0) + 1)
      }
      const clusterKeyOf = (n: NodeSingular): string => {
        const g = memberOfGroup.get(n.id())
        return g && (countInRank.get(g) ?? 0) >= 2 ? g : `__single:${n.id()}`
      }
      const isFramedKey = (key: string) => !key.startsWith('__single:')

      // Clusters are collected in the order their first (leftmost, since
      // `sorted` is x-ascending) member is encountered -- so clusterOrder
      // already reflects each cluster's original left-to-right position,
      // without a separate sort/anchor computation.
      const clusters = new Map<string, NodeSingular[]>()
      const clusterOrder: string[] = []
      for (const n of sorted) {
        const k = clusterKeyOf(n)
        const arr = clusters.get(k)
        if (arr) {
          arr.push(n)
        } else {
          clusters.set(k, [n])
          clusterOrder.push(k)
        }
      }

      // Flatten into one ordered node list (same-cluster members
      // adjacent) with the gap to use after each node: baseGap within a
      // cluster, baseGap + clusterGapExtra across a cluster boundary where
      // at least one side is a real framed group.
      const orderedNodes: NodeSingular[] = []
      const gapAfter: number[] = []
      for (let ci = 0; ci < clusterOrder.length; ci++) {
        const members = clusters.get(clusterOrder[ci]) ?? []
        for (let mi = 0; mi < members.length; mi++) {
          orderedNodes.push(members[mi])
          if (mi < members.length - 1) gapAfter.push(baseGap)
        }
        if (ci < clusterOrder.length - 1) {
          const boundary = isFramedKey(clusterOrder[ci]) || isFramedKey(clusterOrder[ci + 1])
          gapAfter.push(boundary ? baseGap + clusterGapExtra : baseGap)
        }
      }

      // Pack tightly left-to-right from an arbitrary anchor (0), then
      // shift the whole rank so its new mean lands back on originalMean --
      // this is what keeps a sparse rank's overall position roughly where
      // dagre put it while collapsing its internal, often-pointless gaps.
      const widths = orderedNodes.map((n) => n.outerWidth())
      const xs: number[] = []
      let x = 0
      for (let i = 0; i < orderedNodes.length; i++) {
        if (i > 0) x += widths[i - 1] / 2 + gapAfter[i - 1] + widths[i] / 2
        xs.push(x)
      }
      const packedMean = xs.reduce((s, v) => s + v, 0) / xs.length
      const offset = originalMean - packedMean
      orderedNodes.forEach((n, i) => n.position('x', xs[i] + offset))
    }
  })
}

/**
 * The topology diagram: containerlab's nodes and links, rendered with
 * Cytoscape.js in a hierarchical layering driven by the backend's computed
 * `tier` (internal/aggregate/layout.go), node shape hinting function
 * (switch/router/firewall/server, from `labels.role` or a `kind` guess),
 * node borders colored by the same ok/drift/down vocabulary as the rest of
 * the app (see colors.ts), a small corner badge on nodes the device plugin
 * also reports on, a dashed frame around nodes that share a containerlab
 * `group:`, per-link-type line styling, and link-aggregation bundles
 * (2+ same-type links between the same node pair) merged into one "LAG ×N"
 * edge -- see 「ネットワーク図の描き方入門」's physical-diagram conventions this
 * mirrors (connector/cable legend, link-aggregation symbol, rack/floor
 * grouping boxes), which is the one of its three diagram kinds
 * containerlab's own data genuinely describes.
 *
 * Keeps one persistent cytoscape.Core across snapshot updates (does not
 * tear down and recreate it on every poll): node/edge data is patched
 * in-place, and layout only re-runs when the set of node/edge ids actually
 * changes, so a color flip (e.g. a disturb/fix demo action) never resets
 * the user's pan/zoom or reshuffles the layout.
 */
export function TopologyDiagram({ nodes, links, theme, filter }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const cyRef = useRef<Core | null>(null)
  const [selected, setSelected] = useState<SnapshotNode | null>(null)
  const [selectedLink, setSelectedLink] = useState<SelectedLink | null>(null)
  const [legendOpen, setLegendOpen] = useState(false)
  const [groupBoxes, setGroupBoxes] = useState<GroupBox[]>([])

  const roles = useMemo(() => {
    const present = new Set((nodes ?? []).map(inferRole))
    return (['switch', 'router', 'firewall', 'server'] as const).filter((r) => present.has(r))
  }, [nodes])

  // Node names sharing a containerlab `group:`, two-or-more only (see
  // computeGroupBoxes). Mirrored into a ref so the persistent 'render'
  // listener below (bound once, at mount) always reads the latest value
  // instead of whatever was current when it was bound.
  const nodeGroups = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const n of nodes ?? []) {
      if (!n.group) continue
      const arr = m.get(n.group)
      if (arr) {
        arr.push(n.name)
      } else {
        m.set(n.group, [n.name])
      }
    }
    for (const [k, v] of m) {
      if (v.length < 2) m.delete(k)
    }
    return m
  }, [nodes])
  const nodeGroupsRef = useRef(nodeGroups)
  useEffect(() => {
    nodeGroupsRef.current = nodeGroups
  }, [nodeGroups])
  // Mirrored the same way as nodeGroupsRef, for the same reason: the
  // persistent 'render' listener bound once at mount must read the
  // *current* theme (to color group frames correctly), not whatever theme
  // was active the instant the listener was created.
  const themeRef = useRef(theme)
  useEffect(() => {
    themeRef.current = theme
  }, [theme])

  // Link types present in this snapshot that LINK_TYPE_VISUALS actually
  // draws distinctly (i.e. excluding "veth"/unrecognized, which render as
  // a plain line identical to before this existed) -- used to decide
  // whether the legend's line-style section has anything worth showing.
  const presentLinkTypes = useMemo(() => {
    const s = new Set<string>()
    for (const l of links ?? []) {
      if (l.type && l.type !== 'veth' && l.type in LINK_TYPE_VISUALS) s.add(l.type)
    }
    return [...s].sort()
  }, [links])
  const hasLag = useMemo(() => {
    for (const group of buildEdgeGroups(links).values()) {
      if (group.length > 1) return true
    }
    return false
  }, [links])

  // Create the cytoscape instance once. The theme it starts with is
  // whatever's current at mount time; later theme switches are applied by
  // the effect below rather than by recreating the instance, so switching
  // themes never resets pan/zoom or the layout.
  useEffect(() => {
    if (!containerRef.current) return
    const cy = cytoscape({
      container: containerRef.current,
      style: buildStyle(theme),
      elements: [],
      wheelSensitivity: 0.25,
      minZoom: 0.3,
      maxZoom: 2.5,
    })
    cyRef.current = cy
    // Keeps every group frame glued to its members through pan/zoom/drag,
    // without this effect needing to know when any of those happen --
    // 'render' fires on all of them (see computeGroupBoxes's doc comment).
    const onRender = () => {
      setGroupBoxes(computeGroupBoxes(cy, nodeGroupsRef.current, themeRef.current))
    }
    cy.on('render', onRender)
    return () => {
      cy.destroy()
      cyRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-skin the existing graph when the theme changes, without touching
  // elements, pan, zoom, or layout.
  useEffect(() => {
    cyRef.current?.style(buildStyle(theme))
  }, [theme])

  // Keep the "selected node" side panel in sync with clicks, independent of
  // the snapshot-diffing effect below.
  useEffect(() => {
    const cy = cyRef.current
    if (!cy) return
    const nodeHandler = (evt: cytoscape.EventObject) => {
      const n = evt.target as NodeSingular
      const found = (nodes ?? []).find((x) => x.name === n.id())
      setSelected(found ?? null)
      setSelectedLink(null)
    }
    const edgeHandler = (evt: cytoscape.EventObject) => {
      const e = evt.target as EdgeSingular
      setSelected(null)
      setSelectedLink({
        source: e.data('source') as string,
        target: e.data('target') as string,
        linkType: (e.data('linkType') as string) || 'veth',
        isLag: Boolean(e.data('isLag')),
        members: (e.data('members') as string[] | undefined) ?? [],
      })
    }
    const clearHandler = () => {
      setSelected(null)
      setSelectedLink(null)
    }
    cy.on('tap', 'node', nodeHandler)
    cy.on('tap', 'edge', edgeHandler)
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
    // Links are grouped by (type, unordered node pair) before diffing --
    // 2+ links in the same group become one drawn "LAG ×N" edge (see
    // edgeGroupKey's doc comment), so cytoscape's edge set is keyed by
    // group, not by individual link.
    const edgeGroups = buildEdgeGroups(links)

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
        if (!edgeGroups.has(el.id())) {
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
            label: nodeLabel(n),
            borderColor: statusColorHex(n.color, theme),
            statusLabel: statusLabel(n.color),
            hasPlugin: Boolean(n.plugin),
            kind: n.kind ?? '',
            state: n.state ?? '',
            group: n.group ?? '',
            role,
            compact: COMPACT_ROLES.has(role),
            shape: ROLE_SHAPE[role],
            tier: n.tier,
          })
        } else {
          const el = nodeElement(n, theme)
          el.data.shape = ROLE_SHAPE[role]
          cy.add(el)
          structureChanged = true
        }
      }

      // Add/update edges. A group's link count can change between polls
      // (e.g. a second parallel link appearing turns a plain edge into a
      // LAG bundle), so an already-present group still gets its
      // label/isLag/lagCount refreshed even when no edge is added/removed.
      for (const [key, group] of edgeGroups) {
        const existing = cy.getElementById(key)
        if (existing.empty()) {
          const el = edgeElementFromGroup(key, group, tierOf)
          if (el) {
            cy.add(el)
            structureChanged = true
          }
        } else {
          const first = group[0]
          const isLag = group.length > 1
          existing.data({
            label: isLag ? lagLabel(group.length) : '',
            linkType: first.type || 'veth',
            isLag,
            lagCount: group.length,
            ifacePair: linkLabel(first),
            members: group.map(linkLabel),
          })
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
        nodeSep: 56,
        rankSep: 100,
        edgeSep: 24,
        align: 'UL',
        nodeDimensionsIncludeLabels: true,
        minLen: (edge: cytoscape.EdgeSingular) => (edge.data('tierDelta') as number) || 0,
      } as cytoscape.LayoutOptions).run()
      // Dagre's own crossing-minimization has no notion of containerlab
      // `group:` -- pull each rank's group members back together
      // (see compactRanks's doc comment) so the frame drawn around
      // a group never has to stretch to cover an unrelated node dagre
      // happened to interleave in between.
      compactRanks(cy, nodeGroups)
      // compactRanks can change a rank's total width relative to what the
      // layout's own `fit: true` already accounted for (it ran before
      // this pass existed) -- re-fit with the same padding so nothing
      // ends up partly outside the visible canvas.
      cy.fit(undefined, 40)
    }
    // Group frames are keyed off the same elements this effect just
    // settled (new positions after a layout re-run, or just-updated
    // group membership even without one) -- recompute them here rather
    // than waiting for the next 'render' event, so a structural change
    // never shows a stale frame even for a single tick.
    setGroupBoxes(computeGroupBoxes(cy, nodeGroups, theme))
  }, [nodes, links, theme, nodeGroups])

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
        const hay = `${n.id()} ${n.data('kind') ?? ''} ${n.data('role') ?? ''} ${n.data('group') ?? ''}`.toLowerCase()
        n.toggleClass('dimmed', !hay.includes(q))
      })
      cy.edges().forEach((e) => {
        const dim = e.source().hasClass('dimmed') || e.target().hasClass('dimmed')
        e.toggleClass('dimmed', dim)
      })
    })
  }, [filter, nodes, links])

  return (
    <div
      style={{
        height: 440,
        position: 'relative',
        overflow: 'hidden',
        background: 'var(--bg)',
        border: '1px solid var(--border)',
        borderRadius: 6,
      }}
    >
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        {groupBoxes.map((b) => (
          <div
            key={b.id}
            style={{
              position: 'absolute',
              left: b.x,
              top: b.y,
              width: b.w,
              height: b.h,
              border: `1.5px dashed ${b.color}`,
              borderRadius: 8,
            }}
          >
            {/* Label sits *inside* the frame's own top-left corner
                (not below/outside it) so it can never be clipped by
                the diagram's overflow:hidden, and a group near the
                canvas edge never produces a line that visually
                "leaks" past the diagram's own border. */}
            <span
              style={{
                position: 'absolute',
                left: 6,
                top: 4,
                fontSize: 11,
                fontWeight: 600,
                fontFamily: 'var(--font-ui)',
                color: b.color,
                background: 'var(--bg)',
                padding: '1px 5px',
                borderRadius: 4,
                whiteSpace: 'nowrap',
              }}
            >
              {b.label}
            </span>
          </div>
        ))}
      </div>
      {/* The legend used to be a permanently-visible 220px column next to
          the canvas -- most of the time nothing in it needs checking, so
          it's now a map-style corner control: a small button, open only
          while someone wants it (same on-demand pattern as the header's
          Sources popover). */}
      <LegendButton
        open={legendOpen}
        onToggle={() => setLegendOpen((o) => !o)}
        onClose={() => setLegendOpen(false)}
        roles={roles}
        theme={theme}
        linkTypes={presentLinkTypes}
        hasLag={hasLag}
      />
      {(selected || selectedLink) && (
        <div style={{ position: 'absolute', top: 10, right: 10, width: 230, zIndex: 5 }}>
          {selectedLink ? (
            <LinkDetail link={selectedLink} onClose={() => setSelectedLink(null)} />
          ) : selected ? (
            <NodeDetail node={selected} onClose={() => setSelected(null)} />
          ) : null}
        </div>
      )}
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

function Legend({
  roles,
  theme,
  linkTypes,
  hasLag,
  onClose,
}: {
  roles: readonly Role[]
  theme: Theme
  linkTypes: readonly string[]
  hasLag: boolean
  onClose?: () => void
}) {
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
        background: 'var(--surface)',
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.25)',
      }}
    >
      {onClose && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: -4 }}>
          <CloseButton onClick={onClose} />
        </div>
      )}
      {LEGEND_COLORS.map((c) => (
        <div key={c} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <StatusDot color={statusColorHex(c, theme)} />
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
      {(linkTypes.length > 0 || hasLag) && (
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
          {linkTypes.map((t) => (
            <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <LinkTypeGlyph type={t} theme={theme} />
              <span style={{ color: 'var(--text-muted)' }} className="mono">
                {t}
              </span>
            </div>
          ))}
          {hasLag && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <LagGlyph theme={theme} />
              <span style={{ color: 'var(--text-muted)' }}>parallel links (same pair)</span>
            </div>
          )}
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

// A small line sample matching one LINK_TYPE_VISUALS entry's dash/dot
// pattern -- SVG rather than a CSS border so an arbitrary dash array (not
// just CSS's own dashed/dotted) renders exactly as Cytoscape will draw it.
function LinkTypeGlyph({ type, theme }: { type: string; theme: Theme }) {
  const v = LINK_TYPE_VISUALS[type]
  const color = THEME_HEX[theme].linkColor
  const dash = v?.lineStyle === 'dotted' ? '1,3' : (v?.dashPattern ?? []).join(',')
  return (
    <svg width="20" height="10" style={{ flexShrink: 0 }}>
      <line
        x1="1"
        y1="5"
        x2="19"
        y2="5"
        stroke={color}
        strokeWidth="2"
        strokeDasharray={dash || undefined}
        strokeLinecap={v?.lineStyle === 'dotted' ? 'round' : 'butt'}
      />
    </svg>
  )
}

// A small sample of the diagram's link-aggregation pill badge (see the
// 'edge[?isLag]' style rule), for the legend.
function LagGlyph({ theme }: { theme: Theme }) {
  const hex = THEME_HEX[theme]
  return (
    <svg width="28" height="12" style={{ flexShrink: 0 }}>
      <line x1="1" y1="6" x2="27" y2="6" stroke={hex.linkColor} strokeWidth="3" />
      <rect x="5" y="1" width="18" height="10" rx="5" fill={hex.surfaceRaised} stroke={hex.linkColor} />
      <text x="14" y="9" fontSize="7" textAnchor="middle" fill={hex.text} fontFamily="ui-monospace, monospace">
        ×N
      </text>
    </svg>
  )
}

function LinkDetail({ link, onClose }: { link: SelectedLink; onClose?: () => void }) {
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
          {link.source} ↔ {link.target}
        </span>
        {onClose && <CloseButton onClick={onClose} />}
      </div>
      <Row label="type" value={link.linkType} />
      {link.isLag && <Row label="bundle" value={`${link.members.length} links`} />}
      {link.members.map((m, i) => (
        <Row key={i} label={link.isLag ? `link ${i + 1}` : 'interfaces'} value={m} />
      ))}
    </div>
  )
}

/** The map-style corner control that opens the Legend on demand -- the
 * Legend used to sit permanently in a side column, which spent space on
 * something rarely needed; this follows the same open/close-on-outside-
 * click/Escape pattern the header's Sources button already established
 * (see App.tsx's SourcesButton). */
function LegendButton({
  open,
  onToggle,
  onClose,
  roles,
  theme,
  linkTypes,
  hasLag,
}: {
  open: boolean
  onToggle: () => void
  onClose: () => void
  roles: readonly Role[]
  theme: Theme
  linkTypes: readonly string[]
  hasLag: boolean
}) {
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onClose])

  return (
    <div ref={rootRef} style={{ position: 'absolute', top: 10, left: 10, zIndex: 5 }}>
      <button
        type="button"
        onClick={onToggle}
        className="mono"
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          color: 'var(--text-muted)',
          fontSize: 12,
          padding: '6px 10px',
          cursor: 'pointer',
          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.2)',
        }}
      >
        Legend
      </button>
      {open && (
        <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 6, width: 200 }}>
          <Legend roles={roles} theme={theme} linkTypes={linkTypes} hasLag={hasLag} onClose={onClose} />
        </div>
      )}
    </div>
  )
}
