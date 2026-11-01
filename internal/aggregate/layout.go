package aggregate

import (
	"sort"

	"github.com/tjst-t/clab-view/internal/source/containerlab"
)

// computeTiers assigns a layered "tier" (vertical level, 0 = topmost) to
// every node name, purely from the link graph's structure -- no knowledge
// of role/group names is used, so this works for an arbitrary containerlab
// topology, not just ones that happen to use familiar naming conventions.
//
// Algorithm, per connected component (processed independently --
// components with no links between them are unrelated and should not
// influence each other's tiering):
//
//  1. The node(s) with the highest degree (link-endpoint count) within the
//     component become tier 0 ("hub(s)"). Ties all become tier 0 together
//     -- this is what makes a two-spine design put both spines at the same
//     top level, rather than arbitrarily picking one.
//  2. Every other node's tier is its shortest-path distance (in link
//     hops) from the nearest tier-0 hub, via breadth-first search from all
//     tier-0 nodes at once.
//
// A node with no links at all (isolated) is its own component and gets
// tier 0 (it has nothing to be "below").
//
// This was chosen over a k-core/onion-peeling layering (repeatedly
// stripping degree-1 nodes) because peeling is symmetric: on a simple
// chain (e.g. border -- firewall -- spine -- leaf -- compute) it puts
// *both* ends of the chain at the outermost tier and the middle at the
// innermost, which is wrong for a genuine top-to-bottom hierarchy where
// one end (the core) belongs at the top and the other (the edge) at the
// bottom. Max-degree-rooted BFS does not have this problem: the single
// highest-degree node naturally anchors tier 0 at one end.
//
// Link endpoints naming a node not present in nodes are ignored (that
// node's existence is not known to this view, so it cannot sensibly
// anchor or extend a tier). A self-link (a == b) is likewise ignored.
//
// Degree, for both the max-degree hub search and the per-node tier a node
// ends up at, is counted in *distinct neighbors*, not raw link count: two
// (or more) parallel links between the same pair of nodes (a
// link-aggregation bundle -- see TopologyDiagram.tsx's edgeGroupKey on the
// frontend, which draws exactly this as one merged "LAG ×N" edge) reach
// exactly as many other devices as a single link would. Counting raw link
// count here would let a node's cabling redundancy alone -- not how many
// distinct other devices it actually reaches -- decide whether it ties for
// hub, which previously split a symmetric two-hub design (e.g. two spines,
// one of which happens to have one bundled link somewhere the other
// doesn't) into only one of them becoming tier 0: the other was then BFS'd
// in from its leaves, landing it on the same tier as those leaves'
// children instead of beside its twin.
func computeTiers(nodes []containerlab.Node, links []containerlab.Link) map[string]int {
	names := make([]string, 0, len(nodes))
	known := make(map[string]bool, len(nodes))
	for _, n := range nodes {
		if known[n.Name] {
			continue
		}
		known[n.Name] = true
		names = append(names, n.Name)
	}

	neighbors := make(map[string]map[string]bool, len(names))
	for _, name := range names {
		neighbors[name] = map[string]bool{} // every known node gets an entry, even isolated ones
	}
	for _, l := range links {
		a, b := l.A.Node, l.B.Node
		if !known[a] || !known[b] || a == b {
			continue
		}
		neighbors[a][b] = true
		neighbors[b][a] = true
	}
	adj := make(map[string][]string, len(names))
	for name, set := range neighbors {
		for nb := range set {
			adj[name] = append(adj[name], nb)
		}
	}

	tiers := make(map[string]int, len(names))
	componentVisited := make(map[string]bool, len(names))

	// Deterministic component discovery order: iterate names in the order
	// given (the order nodes was built in).
	for _, start := range names {
		if componentVisited[start] {
			continue
		}

		// Collect this component's members via plain BFS over adj.
		members := []string{start}
		componentVisited[start] = true
		queue := []string{start}
		for len(queue) > 0 {
			cur := queue[0]
			queue = queue[1:]
			for _, nb := range adj[cur] {
				if componentVisited[nb] {
					continue
				}
				componentVisited[nb] = true
				members = append(members, nb)
				queue = append(queue, nb)
			}
		}

		// Find the max degree within the component, and every node tied
		// at it -- those become this component's tier-0 roots.
		maxDegree := -1
		for _, m := range members {
			if d := len(adj[m]); d > maxDegree {
				maxDegree = d
			}
		}
		var roots []string
		for _, m := range members {
			if len(adj[m]) == maxDegree {
				roots = append(roots, m)
			}
		}
		sort.Strings(roots) // deterministic when multiple nodes tie

		// Multi-source BFS from all roots at once -- tier = shortest-path
		// distance (in hops) from the nearest root. Members outside this
		// component can never be reached from adj here, so there is no
		// risk of this BFS leaking tiers across components.
		bfsQueue := make([]string, 0, len(members))
		for _, r := range roots {
			tiers[r] = 0
			bfsQueue = append(bfsQueue, r)
		}
		for len(bfsQueue) > 0 {
			cur := bfsQueue[0]
			bfsQueue = bfsQueue[1:]
			for _, nb := range adj[cur] {
				if _, done := tiers[nb]; done {
					continue
				}
				tiers[nb] = tiers[cur] + 1
				bfsQueue = append(bfsQueue, nb)
			}
		}
	}

	return tiers
}
