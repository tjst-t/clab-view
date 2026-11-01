package containerlab

import "testing"

func TestParseClabYAMLLinks(t *testing.T) {
	data := `
name: mylab
topology:
  nodes:
    leaf1:
      kind: nokia_srlinux
    spine1:
      kind: nokia_srlinux
    fw1:
      kind: linux
  links:
    - endpoints: ["leaf1:e1-1", "spine1:e1-1"]
    - type: veth
      endpoints: ["leaf1:e1-2", "fw1:eth1"]
    - endpoints: ["spine1:mgmt0"]
`
	labName, links, err := parseClabYAMLLinks(data)
	if err != nil {
		t.Fatalf("parseClabYAMLLinks: %v", err)
	}
	if labName != "mylab" {
		t.Errorf("labName = %q, want %q", labName, "mylab")
	}
	// The third entry (a single endpoint) is skipped rather than erroring --
	// an unrecognized/partial link shape should not fail the whole parse.
	if len(links) != 2 {
		t.Fatalf("links = %d, want 2: %+v", len(links), links)
	}
	if links[0].Type != "veth" || links[0].A.Node != "leaf1" || links[0].A.Interface != "e1-1" ||
		links[0].B.Node != "spine1" || links[0].B.Interface != "e1-1" {
		t.Errorf("links[0] = %+v, unexpected", links[0])
	}
	if links[1].Type != "veth" || links[1].A.Node != "leaf1" || links[1].A.Interface != "e1-2" ||
		links[1].B.Node != "fw1" || links[1].B.Interface != "eth1" {
		t.Errorf("links[1] = %+v, unexpected", links[1])
	}
}

func TestParseClabYAMLLinks_Empty(t *testing.T) {
	labName, links, err := parseClabYAMLLinks("")
	if err != nil {
		t.Fatalf("parseClabYAMLLinks(\"\"): %v", err)
	}
	if labName != "" || links != nil {
		t.Errorf("parseClabYAMLLinks(\"\") = (%q, %v), want (\"\", nil)", labName, links)
	}
}

func TestParseClabYAMLLinks_NoLinksSection(t *testing.T) {
	data := "name: mylab\ntopology:\n  nodes:\n    node1:\n      kind: linux\n"
	labName, links, err := parseClabYAMLLinks(data)
	if err != nil {
		t.Fatalf("parseClabYAMLLinks: %v", err)
	}
	if labName != "mylab" {
		t.Errorf("labName = %q, want %q", labName, "mylab")
	}
	if len(links) != 0 {
		t.Errorf("links = %+v, want empty", links)
	}
}

func TestParseClabYAMLLinks_Malformed(t *testing.T) {
	if _, _, err := parseClabYAMLLinks("not: [valid"); err == nil {
		t.Fatal("parseClabYAMLLinks(malformed): want error, got nil")
	}
}

func TestParseClabYAMLNodeMeta(t *testing.T) {
	data := `
name: mylab
topology:
  nodes:
    leaf1:
      kind: nokia_srlinux
      group: leaf
      labels:
        role: switch
        rack: a1
    spine1:
      kind: nokia_srlinux
      group: spine
    fw1:
      kind: linux
`
	meta, err := parseClabYAMLNodeMeta(data)
	if err != nil {
		t.Fatalf("parseClabYAMLNodeMeta: %v", err)
	}
	if len(meta) != 3 {
		t.Fatalf("meta = %d entries, want 3: %+v", len(meta), meta)
	}
	if meta["leaf1"].Group != "leaf" || meta["leaf1"].Labels["role"] != "switch" || meta["leaf1"].Labels["rack"] != "a1" {
		t.Errorf("meta[leaf1] = %+v, unexpected", meta["leaf1"])
	}
	if meta["spine1"].Group != "spine" || meta["spine1"].Labels != nil {
		t.Errorf("meta[spine1] = %+v, unexpected", meta["spine1"])
	}
	// fw1 declares neither group nor labels: still present in the map with a
	// zero nodeMeta, distinguishing "declared but empty" from "not declared
	// at all" (a node name absent from the map entirely).
	if meta["fw1"].Group != "" || meta["fw1"].Labels != nil {
		t.Errorf("meta[fw1] = %+v, want zero value", meta["fw1"])
	}
	if _, ok := meta["no-such-node"]; ok {
		t.Error("meta[no-such-node] should be absent")
	}
}

func TestParseClabYAMLNodeMeta_Empty(t *testing.T) {
	meta, err := parseClabYAMLNodeMeta("")
	if err != nil {
		t.Fatalf("parseClabYAMLNodeMeta(\"\"): %v", err)
	}
	if meta != nil {
		t.Errorf("parseClabYAMLNodeMeta(\"\") = %+v, want nil", meta)
	}
}

func TestParseClabYAMLNodeMeta_Malformed(t *testing.T) {
	if _, err := parseClabYAMLNodeMeta("not: [valid"); err == nil {
		t.Fatal("parseClabYAMLNodeMeta(malformed): want error, got nil")
	}
}
