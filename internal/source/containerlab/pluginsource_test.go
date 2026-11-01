package containerlab

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tjst-t/clab-view/internal/source/plugin"
)

// pluginTopologyFixture mirrors GET /plugin/topology's response, whose
// "inspect" field is exactly containerlab's own `inspect --format json`
// output: an object keyed by lab name, value an array of container objects
// (confirmed against containerlab.dev/cmd/inspect/). Note the absence of
// group/mgmt_network/nodeName/ports here, unlike clab-api-server's shape.
// clab_yaml's topology.links is this source's only way to get link data
// (the inspect output above carries none) -- see pluginsource.go.
const pluginTopologyFixture = `{
  "inspect": {
    "mylab": [
      {
        "lab_name": "mylab",
        "labPath": "mylab.clab.yml",
        "absLabPath": "/home/user/mylab.clab.yml",
        "name": "clab-mylab-node1",
        "container_id": "abcd1234",
        "image": "ghcr.io/nokia/srlinux",
        "kind": "nokia_srlinux",
        "state": "running",
        "status": "Up 2 hours",
        "ipv4_address": "172.20.20.2/24",
        "ipv6_address": "",
        "owner": "user"
      },
      {
        "lab_name": "mylab",
        "labPath": "mylab.clab.yml",
        "absLabPath": "/home/user/mylab.clab.yml",
        "name": "clab-mylab-node2",
        "container_id": "ef567890",
        "image": "ghcr.io/nokia/srlinux",
        "kind": "nokia_srlinux",
        "state": "running",
        "status": "Up 2 hours",
        "ipv4_address": "172.20.20.3/24",
        "ipv6_address": "",
        "owner": "user"
      }
    ]
  },
  "clab_yaml": "name: mylab\ntopology:\n  nodes:\n    node1:\n      kind: nokia_srlinux\n    node2:\n      kind: nokia_srlinux\n  links:\n    - endpoints: [\"node1:e1-1\", \"node2:e1-1\"]\n"
}`

func TestPluginSource_Topology(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /plugin/topology", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(pluginTopologyFixture))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	src := NewPluginSource(plugin.NewClient(srv.URL, nil))
	topo, err := src.Topology(context.Background())
	if err != nil {
		t.Fatalf("Topology: %v", err)
	}

	if len(topo.Nodes) != 2 {
		t.Fatalf("Nodes = %d, want 2", len(topo.Nodes))
	}
	n := topo.Nodes[0]
	if n.Name != "node1" || n.ContainerName != "clab-mylab-node1" || n.Kind != "nokia_srlinux" || n.State != "running" ||
		n.IPv4 != "172.20.20.2/24" || n.Owner != "user" || n.LabName != "mylab" || n.Group != "" {
		t.Errorf("Nodes[0] = %+v, unexpected", n)
	}

	if len(topo.Links) != 1 {
		t.Fatalf("Links = %d, want 1 (from clab_yaml's topology.links)", len(topo.Links))
	}
	l0 := topo.Links[0]
	if l0.Type != "veth" || l0.A.Node != "node1" || l0.A.Interface != "e1-1" ||
		l0.B.Node != "node2" || l0.B.Interface != "e1-1" {
		t.Errorf("Links[0] = %+v, unexpected", l0)
	}
}

// pluginTopologyFixtureGroupLabelsJSON is like pluginTopologyFixture, but
// its clab_yaml declares group/labels per node (one of inspect's own nodes
// also sets "group", to check that inspect's own value wins -- see
// PluginSource.Topology's merge comment), to exercise
// TestPluginSource_Topology_GroupAndLabels.
var pluginTopologyFixtureGroupLabelsJSON = func() string {
	clabYAML := "name: mylab\n" +
		"topology:\n" +
		"  nodes:\n" +
		"    spine1:\n" +
		"      kind: linux\n" +
		"      group: spine\n" +
		"      labels:\n" +
		"        role: switch\n" +
		"    leaf1:\n" +
		"      kind: linux\n" +
		"      group: leaf\n" +
		"  links:\n" +
		"    - endpoints: [\"spine1:e1\", \"leaf1:e1\"]\n"
	clabYAMLJSON, _ := json.Marshal(clabYAML)
	return `{
  "inspect": {
    "mylab": [
      {"lab_name": "mylab", "name": "clab-mylab-spine1", "kind": "linux", "state": "running"},
      {"lab_name": "mylab", "name": "clab-mylab-leaf1", "kind": "linux", "state": "running", "group": "from-inspect"}
    ]
  },
  "clab_yaml": ` + string(clabYAMLJSON) + `
}`
}()

func TestPluginSource_Topology_GroupAndLabels(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /plugin/topology", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(pluginTopologyFixtureGroupLabelsJSON))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	src := NewPluginSource(plugin.NewClient(srv.URL, nil))
	topo, err := src.Topology(context.Background())
	if err != nil {
		t.Fatalf("Topology: %v", err)
	}

	byName := make(map[string]Node, len(topo.Nodes))
	for _, n := range topo.Nodes {
		byName[n.Name] = n
	}

	spine1, ok := byName["spine1"]
	if !ok {
		t.Fatalf("no node named spine1 in %+v", topo.Nodes)
	}
	if spine1.Group != "spine" {
		t.Errorf("spine1.Group = %q, want %q", spine1.Group, "spine")
	}
	if spine1.Labels["role"] != "switch" {
		t.Errorf("spine1.Labels = %+v, want role=switch", spine1.Labels)
	}

	leaf1, ok := byName["leaf1"]
	if !ok {
		t.Fatalf("no node named leaf1 in %+v", topo.Nodes)
	}
	// inspect's own group ("from-inspect") wins over clab_yaml's ("leaf"):
	// clab_yaml only fills in Group when inspect didn't already have one.
	if leaf1.Group != "from-inspect" {
		t.Errorf("leaf1.Group = %q, want %q (inspect's own value should win)", leaf1.Group, "from-inspect")
	}
}
