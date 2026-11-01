package main

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadTopologyFiles_BothUnset(t *testing.T) {
	t.Setenv("CLAB_YAML_FILE", "")
	t.Setenv("INSPECT_JSON_FILE", "")
	yaml, inspect, err := loadTopologyFiles()
	if err != nil {
		t.Fatalf("loadTopologyFiles: %v", err)
	}
	if yaml != "" || inspect != nil {
		t.Errorf("loadTopologyFiles() = (%q, %v), want (\"\", nil)", yaml, inspect)
	}
}

func TestLoadTopologyFiles_OnlyOneSet(t *testing.T) {
	dir := t.TempDir()
	yamlPath := filepath.Join(dir, "topo.yml")
	if err := os.WriteFile(yamlPath, []byte("name: x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLAB_YAML_FILE", yamlPath)
	t.Setenv("INSPECT_JSON_FILE", "") // deliberately unset

	yaml, inspect, err := loadTopologyFiles()
	if err != nil {
		t.Fatalf("loadTopologyFiles: %v", err)
	}
	if yaml != "" || inspect != nil {
		t.Errorf("loadTopologyFiles() with only CLAB_YAML_FILE set = (%q, %v), want (\"\", nil) -- both must be set together", yaml, inspect)
	}
}

func TestLoadTopologyFiles_BothSet(t *testing.T) {
	dir := t.TempDir()
	yamlPath := filepath.Join(dir, "topo.yml")
	jsonPath := filepath.Join(dir, "inspect.json")
	if err := os.WriteFile(yamlPath, []byte("name: demo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(jsonPath, []byte(`{"demo":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLAB_YAML_FILE", yamlPath)
	t.Setenv("INSPECT_JSON_FILE", jsonPath)

	yaml, inspect, err := loadTopologyFiles()
	if err != nil {
		t.Fatalf("loadTopologyFiles: %v", err)
	}
	if yaml != "name: demo\n" {
		t.Errorf("yaml = %q, want %q", yaml, "name: demo\n")
	}
	if string(inspect) != `{"demo":[]}` {
		t.Errorf("inspect = %s, want %s", inspect, `{"demo":[]}`)
	}
}

func TestLoadTopologyFiles_InvalidJSON(t *testing.T) {
	dir := t.TempDir()
	yamlPath := filepath.Join(dir, "topo.yml")
	jsonPath := filepath.Join(dir, "inspect.json")
	if err := os.WriteFile(yamlPath, []byte("name: demo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(jsonPath, []byte("not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLAB_YAML_FILE", yamlPath)
	t.Setenv("INSPECT_JSON_FILE", jsonPath)

	if _, _, err := loadTopologyFiles(); err == nil {
		t.Fatal("loadTopologyFiles with invalid INSPECT_JSON_FILE: want error, got nil")
	}
}

func TestServer_HandleTopology_NotConfigured(t *testing.T) {
	s := newServer("", "", nil)
	req := httptest.NewRequest("GET", "/plugin/topology", nil)
	w := httptest.NewRecorder()
	s.handleTopology(w, req)
	if w.Code != 404 {
		t.Errorf("status = %d, want 404 when topology not configured", w.Code)
	}
}

func TestServer_HandleTopology_Configured(t *testing.T) {
	s := newServer("", "name: demo\n", json.RawMessage(`{"demo":[]}`))
	req := httptest.NewRequest("GET", "/plugin/topology", nil)
	w := httptest.NewRecorder()
	s.handleTopology(w, req)
	if w.Code != 200 {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	var got struct {
		ClabYAML string          `json:"clab_yaml"`
		Inspect  json.RawMessage `json:"inspect"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	if got.ClabYAML != "name: demo\n" {
		t.Errorf("clab_yaml = %q, want %q", got.ClabYAML, "name: demo\n")
	}
	if strings.TrimSpace(string(got.Inspect)) != `{"demo":[]}` {
		t.Errorf("inspect = %s, want %s", got.Inspect, `{"demo":[]}`)
	}
}

func TestServer_HandlePlugin_CapabilitiesIncludeTopologyOnlyWhenConfigured(t *testing.T) {
	without := newServer("", "", nil)
	req := httptest.NewRequest("GET", "/plugin", nil)
	w := httptest.NewRecorder()
	without.handlePlugin(w, req)
	var info struct {
		Capabilities []string `json:"capabilities"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &info); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	for _, c := range info.Capabilities {
		if c == "topology" {
			t.Error("capabilities should not include \"topology\" when not configured")
		}
	}

	with := newServer("", "name: demo\n", json.RawMessage(`{"demo":[]}`))
	w2 := httptest.NewRecorder()
	with.handlePlugin(w2, req)
	var info2 struct {
		Capabilities []string `json:"capabilities"`
	}
	if err := json.Unmarshal(w2.Body.Bytes(), &info2); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	found := false
	for _, c := range info2.Capabilities {
		if c == "topology" {
			found = true
		}
	}
	if !found {
		t.Error("capabilities should include \"topology\" when configured")
	}
}
