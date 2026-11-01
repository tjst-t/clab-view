package aggregate

import (
	"reflect"
	"testing"

	"github.com/tjst-t/clab-view/internal/source/containerlab"
)

func nodeNames(names ...string) []containerlab.Node {
	out := make([]containerlab.Node, len(names))
	for i, n := range names {
		out[i] = containerlab.Node{Name: n}
	}
	return out
}

func link(a, b string) containerlab.Link {
	return containerlab.Link{A: containerlab.LinkEndpoint{Node: a}, B: containerlab.LinkEndpoint{Node: b}}
}

func TestComputeTiers_Chain(t *testing.T) {
	// border -- fw -- spine -- leaf -- compute: a simple 5-node path. The
	// three middle nodes (fw, spine, leaf) all tie at degree 2, which is
	// the max in this component, so all three become tier-0 roots
	// together; the two endpoints (border, compute, degree 1) are each one
	// hop from their nearest root and land on tier 1. This mainly pins
	// that a plain path with no single clear hub does not produce a
	// nonsensical result (e.g. a monotonically increasing tier per hop) --
	// the spine-leaf-firewall-compute test below is the one that matters
	// for the real target shape, where the hub is unambiguous.
	nodes := nodeNames("border", "fw", "spine", "leaf", "compute")
	links := []containerlab.Link{
		link("border", "fw"),
		link("fw", "spine"),
		link("spine", "leaf"),
		link("leaf", "compute"),
	}
	tiers := computeTiers(nodes, links)

	want := map[string]int{"border": 1, "fw": 0, "spine": 0, "leaf": 0, "compute": 1}
	if !reflect.DeepEqual(tiers, want) {
		t.Errorf("tiers = %+v, want %+v", tiers, want)
	}
}

func TestComputeTiers_SpineLeafFirewallCompute(t *testing.T) {
	// The shape this feature actually targets: two spines (full mesh to 2
	// leaves and 2 firewalls), each leaf uplinked to 2 computes, each
	// firewall only uplinked to the spines (no further hop below). Each
	// spine's degree is 4 (2 leaves + 2 firewalls); giving each leaf 2
	// computes on top of its 2 spine uplinks would tie leaf degree with
	// spine degree too (a trap I hit once while writing this test), so
	// leaves here get only 1 compute each, keeping degree 3 < 4 and the
	// spines the unique max-degree (hence tier-0) nodes.
	nodes := nodeNames("spine1", "spine2", "leaf1", "leaf2", "fw1", "fw2", "c1", "c2")
	links := []containerlab.Link{
		link("spine1", "leaf1"), link("spine1", "leaf2"), link("spine1", "fw1"), link("spine1", "fw2"),
		link("spine2", "leaf1"), link("spine2", "leaf2"), link("spine2", "fw1"), link("spine2", "fw2"),
		link("leaf1", "c1"),
		link("leaf2", "c2"),
	}
	tiers := computeTiers(nodes, links)

	want := map[string]int{
		"spine1": 0, "spine2": 0,
		"leaf1": 1, "leaf2": 1, "fw1": 1, "fw2": 1,
		"c1": 2, "c2": 2,
	}
	if !reflect.DeepEqual(tiers, want) {
		t.Errorf("tiers = %+v, want %+v", tiers, want)
	}
}

func TestComputeTiers_ParallelLinksDoNotBreakHubTie(t *testing.T) {
	// Same shape as TestComputeTiers_SpineLeafFirewallCompute, except
	// spine1 has a *second*, parallel link to fw1 (a link-aggregation
	// bundle -- two links between the same node pair). Raw link count would
	// give spine1 degree 5 and spine2 degree 4, breaking the tie and
	// leaving spine2 to be BFS'd in from its leaves -- landing it on tier 2,
	// the same tier as c1/c2, instead of beside spine1 on tier 0. Counting
	// distinct neighbors (both spines reach the same 4 other devices either
	// way) keeps them tied.
	nodes := nodeNames("spine1", "spine2", "leaf1", "leaf2", "fw1", "fw2", "c1", "c2")
	links := []containerlab.Link{
		link("spine1", "leaf1"), link("spine1", "leaf2"), link("spine1", "fw1"), link("spine1", "fw2"),
		link("spine1", "fw1"), // parallel/bundled link, same pair as above
		link("spine2", "leaf1"), link("spine2", "leaf2"), link("spine2", "fw1"), link("spine2", "fw2"),
		link("leaf1", "c1"),
		link("leaf2", "c2"),
	}
	tiers := computeTiers(nodes, links)

	want := map[string]int{
		"spine1": 0, "spine2": 0,
		"leaf1": 1, "leaf2": 1, "fw1": 1, "fw2": 1,
		"c1": 2, "c2": 2,
	}
	if !reflect.DeepEqual(tiers, want) {
		t.Errorf("tiers = %+v, want %+v", tiers, want)
	}
}

func TestComputeTiers_SingleIsolatedNode(t *testing.T) {
	nodes := nodeNames("solo")
	tiers := computeTiers(nodes, nil)
	want := map[string]int{"solo": 0}
	if !reflect.DeepEqual(tiers, want) {
		t.Errorf("tiers = %+v, want %+v", tiers, want)
	}
}

func TestComputeTiers_NoLinksMultipleNodes(t *testing.T) {
	// No structure at all: every node is its own component, each gets
	// tier 0 (nothing to be "below").
	nodes := nodeNames("a", "b", "c")
	tiers := computeTiers(nodes, nil)
	want := map[string]int{"a": 0, "b": 0, "c": 0}
	if !reflect.DeepEqual(tiers, want) {
		t.Errorf("tiers = %+v, want %+v", tiers, want)
	}
}

func TestComputeTiers_DisconnectedComponents(t *testing.T) {
	// Two unrelated star-shaped components (each hub has strictly higher
	// degree than its own leaves, so each component has an unambiguous
	// single root). Each must be tiered independently of the other (the
	// second component's hub must not be pulled down/up by the first
	// component's size or shape).
	nodes := nodeNames("hub1", "leaf1a", "leaf1b", "hub2", "leaf2a", "leaf2b")
	links := []containerlab.Link{
		link("hub1", "leaf1a"), link("hub1", "leaf1b"),
		link("hub2", "leaf2a"), link("hub2", "leaf2b"),
	}
	tiers := computeTiers(nodes, links)
	want := map[string]int{
		"hub1": 0, "leaf1a": 1, "leaf1b": 1,
		"hub2": 0, "leaf2a": 1, "leaf2b": 1,
	}
	if !reflect.DeepEqual(tiers, want) {
		t.Errorf("tiers = %+v, want %+v", tiers, want)
	}
}

func TestComputeTiers_TiedMaxDegreeBothBecomeRoots(t *testing.T) {
	// Two nodes of equal (and maximum) degree, each with their own
	// distinct leaf -- both must become tier 0 together, not just one of
	// them with the other pushed to tier 1.
	nodes := nodeNames("hubA", "hubB", "leafA", "leafB", "bridge")
	links := []containerlab.Link{
		link("hubA", "leafA"),
		link("hubA", "bridge"),
		link("hubB", "leafB"),
		link("hubB", "bridge"),
	}
	// hubA, hubB, bridge all have degree 2; leafA, leafB have degree 1.
	// All three degree-2 nodes tie for max and become tier 0 together.
	tiers := computeTiers(nodes, links)
	want := map[string]int{
		"hubA": 0, "hubB": 0, "bridge": 0,
		"leafA": 1, "leafB": 1,
	}
	if !reflect.DeepEqual(tiers, want) {
		t.Errorf("tiers = %+v, want %+v", tiers, want)
	}
}

func TestComputeTiers_Ring(t *testing.T) {
	// A ring: every node has degree 2, so every node ties for max degree
	// and becomes tier 0 (a ring has no natural hierarchy -- this pins
	// that this is handled without panicking/looping forever, not that
	// tier 0 is a particularly meaningful answer for a ring).
	nodes := nodeNames("r1", "r2", "r3", "r4")
	links := []containerlab.Link{
		link("r1", "r2"), link("r2", "r3"), link("r3", "r4"), link("r4", "r1"),
	}
	tiers := computeTiers(nodes, links)
	want := map[string]int{"r1": 0, "r2": 0, "r3": 0, "r4": 0}
	if !reflect.DeepEqual(tiers, want) {
		t.Errorf("tiers = %+v, want %+v", tiers, want)
	}
}

func TestComputeTiers_IgnoresLinksToUnknownNodes(t *testing.T) {
	// a--b--c, plus a link from a to a node that isn't in the node list at
	// all ("ghost", e.g. a stale/partial topology). If that link were not
	// filtered out it would inflate a's degree to 2, tying with b (which
	// would wrongly make a a root too) -- filtering it keeps b the sole,
	// unambiguous root.
	nodes := nodeNames("a", "b", "c")
	links := []containerlab.Link{
		link("a", "b"),
		link("b", "c"),
		link("a", "ghost"), // "ghost" is not in nodes -- must be ignored
	}
	tiers := computeTiers(nodes, links)
	want := map[string]int{"a": 1, "b": 0, "c": 1}
	if !reflect.DeepEqual(tiers, want) {
		t.Errorf("tiers = %+v, want %+v", tiers, want)
	}
	if _, ok := tiers["ghost"]; ok {
		t.Error("tiers[ghost] should not be present")
	}
}

func TestComputeTiers_IgnoresSelfLink(t *testing.T) {
	// a--b--c, plus a self-link on a. If the self-link were not filtered
	// out it would inflate a's degree to 2 (counted as both endpoints of
	// its own edge), tying with b -- filtering it keeps b the sole root.
	nodes := nodeNames("a", "b", "c")
	links := []containerlab.Link{
		link("a", "a"), // self-link, must not inflate a's degree
		link("a", "b"),
		link("b", "c"),
	}
	tiers := computeTiers(nodes, links)
	want := map[string]int{"a": 1, "b": 0, "c": 1}
	if !reflect.DeepEqual(tiers, want) {
		t.Errorf("tiers = %+v, want %+v", tiers, want)
	}
}
