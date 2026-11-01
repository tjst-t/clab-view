// Command example-plugin is a minimal, dependency-free reference
// implementation of the clab-view device plugin contract (see
// docs/plugin-contract.md, version 0.4). It serves static/fake data and a
// toy "disturb"/"fix" demo script, useful for exercising clab-view
// without any real device behind it.
//
// Run:
//
//	go run ./examples/example-plugin
//
// Optionally require a bearer token from callers:
//
//	PLUGIN_TOKEN=secret go run ./examples/example-plugin
//
// Optionally serve GET /plugin/topology (the plugin's containerlab
// passthrough -- see docs/plugin-contract.md) from two files on disk,
// useful for exercising clab-view's CONTAINERLAB_SOURCE=plugin path
// against an arbitrary sample topology without a running
// clab-api-server:
//
//	CLAB_YAML_FILE=topology.clab.yml INSPECT_JSON_FILE=inspect.json \
//	  go run ./examples/example-plugin
//
// Both must be set for the endpoint to be registered at all (and
// advertised in GET /plugin's capabilities) -- this keeps the default,
// no-env-vars behavior exactly as it was before this option existed.
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const contractVersion = "0.4"

// --- state -----------------------------------------------------------------

type resource struct {
	ID            string         `json:"id"`
	Kind          string         `json:"kind"`
	Label         string         `json:"label"`
	State         string         `json:"state"`
	Node          string         `json:"node"`
	Fields        map[string]any `json:"fields"`
	DriftedFields []string       `json:"drifted_fields"`
}

type run struct {
	RunID      string     `json:"run_id"`
	ScriptID   string     `json:"script_id"`
	Action     string     `json:"action"`
	Status     string     `json:"status"` // running | succeeded | failed
	StartedAt  time.Time  `json:"started_at"`
	FinishedAt *time.Time `json:"finished_at"`
	Message    string     `json:"message"`
}

type event struct {
	ID         int64     `json:"-"`
	Kind       string    `json:"kind"`
	Level      string    `json:"level"` // firing | resolved
	ResourceID string    `json:"resource_id,omitempty"`
	Message    string    `json:"message"`
	At         time.Time `json:"at"`
}

type server struct {
	token string

	// clabYAML/inspectJSON back GET /plugin/topology when both are
	// non-empty (see CLAB_YAML_FILE/INSPECT_JSON_FILE in the package doc
	// comment). inspectJSON is kept pre-serialized (read straight off disk)
	// since it is passed through to the client as raw JSON either way.
	clabYAML    string
	inspectJSON json.RawMessage

	mu        sync.Mutex
	resources map[string]*resource
	runs      map[string]*run
	activeRun string // run_id currently in progress, "" if none

	events    []event // ring-ish backlog, append-only for simplicity
	nextEvtID int64
	subs      map[chan event]struct{}
	subsMu    sync.Mutex
}

func newServer(token, clabYAML string, inspectJSON json.RawMessage) *server {
	s := &server{
		token:       token,
		clabYAML:    clabYAML,
		inspectJSON: inspectJSON,
		resources: map[string]*resource{
			"demo-storage-01": {
				ID:     "demo-storage-01",
				Kind:   "storage",
				Label:  "Demo storage array",
				State:  "ok",
				Node:   "storage01",
				Fields: map[string]any{"lun_count": 4, "capacity_gb": 500},
			},
		},
		runs: map[string]*run{},
		subs: map[chan event]struct{}{},
	}
	return s
}

// --- auth --------------------------------------------------------------

func (s *server) checkAuth(w http.ResponseWriter, r *http.Request) bool {
	if s.token == "" {
		return true // no token configured: open, for local demos only
	}
	got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if got == "" || got != s.token {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return false
	}
	return true
}

// --- handlers ------------------------------------------------------------

func (s *server) handlePlugin(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}
	capabilities := []string{"status", "scripts", "events"}
	if s.hasTopology() {
		capabilities = append([]string{"topology"}, capabilities...)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"version":      contractVersion,
		"name":         "example-plugin",
		"capabilities": capabilities,
	})
}

// hasTopology reports whether this plugin was configured (via
// CLAB_YAML_FILE/INSPECT_JSON_FILE) to serve GET /plugin/topology at all.
func (s *server) hasTopology() bool {
	return s.clabYAML != "" && len(s.inspectJSON) > 0
}

func (s *server) handleTopology(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}
	if !s.hasTopology() {
		http.NotFound(w, r)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"inspect":   s.inspectJSON,
		"clab_yaml": s.clabYAML,
	})
}

func (s *server) handleStatus(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	list := make([]*resource, 0, len(s.resources))
	for _, res := range s.resources {
		list = append(list, res)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"generated_at": time.Now().UTC(),
		"resources":    list,
		// sakutei_sources/policy_sources (contract v0.4): optional
		// declaration-source metadata. This example plugin has no Sakutei
		// resources or boundary-firewall rules of its own to attribute (it
		// only reports its own demo-storage-01), so it sends one
		// illustrative entry of each kind, naming a resource/rule a real
		// deployment's own Sakutei intent files would define -- a real
		// plugin would instead report this for the resources/rules it
		// actually knows the source of.
		"sakutei_sources": []map[string]any{
			{
				"resource_id": "storage/node=demo/storage01/lun-count",
				"file":        "storage.yml",
				"key":         "resources[name=storage01]",
				"why":         "the demo storage array must keep exactly 4 LUNs provisioned",
			},
		},
		"policy_sources": []map[string]any{
			{
				"name":  "mgmt-to-storage01-api",
				"from":  "mgmt",
				"to":    "storage01",
				"proto": "tcp",
				"ports": []int{8081},
				"file":  "network.yml",
				"key":   "firewall.rules[name=mgmt-to-storage01-api]",
				"why":   "clab-view's plugin client reaches this example plugin over this port",
			},
		},
	})
}

func (s *server) handleScripts(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"scripts": []map[string]any{
			{
				"id":          "lun-drift",
				"label":       "Change the LUN count",
				"description": "Changes demo-storage-01's LUN count away from what is declared.",
				"actions":     []string{"disturb", "fix"},
			},
		},
	})
}

func (s *server) handleRunAction(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}
	scriptID := r.PathValue("id")
	action := r.PathValue("action")
	if scriptID != "lun-drift" || (action != "disturb" && action != "fix") {
		http.NotFound(w, r)
		return
	}

	s.mu.Lock()
	if s.activeRun != "" {
		if active, ok := s.runs[s.activeRun]; ok && active.Status == "running" {
			s.mu.Unlock()
			// This plugin's own exclusivity is always one of its own runs, so
			// busy_by is always "run" and run_id is always set here. A plugin
			// whose exclusivity can instead be held by something external to
			// its own run-tracking would set busy_by: "external" and omit
			// run_id in that case (see docs/plugin-contract.md's v0.2 section).
			writeJSON(w, http.StatusConflict, map[string]any{
				"accepted": false,
				"reason":   "another run is already in progress",
				"run_id":   s.activeRun,
				"busy_by":  "run",
			})
			return
		}
	}
	runID := fmt.Sprintf("r-%04d", len(s.runs)+1)
	now := time.Now().UTC()
	rn := &run{RunID: runID, ScriptID: scriptID, Action: action, Status: "running", StartedAt: now}
	s.runs[runID] = rn
	s.activeRun = runID
	s.mu.Unlock()

	writeJSON(w, http.StatusAccepted, map[string]any{"accepted": true, "run_id": runID})

	go s.performAction(runID, action)
}

// performAction simulates the device drifting (disturb) or Sakutei fixing
// it (fix); in a real plugin this would call into the actual device.
func (s *server) performAction(runID, action string) {
	time.Sleep(1 * time.Second) // pretend it takes a moment

	s.mu.Lock()
	res := s.resources["demo-storage-01"]
	switch action {
	case "disturb":
		res.State = "drifted"
		res.DriftedFields = []string{"lun_count"}
		res.Fields["lun_count"] = 6
	case "fix":
		res.State = "ok"
		res.DriftedFields = nil
		res.Fields["lun_count"] = 4
	}
	finished := time.Now().UTC()
	s.runs[runID].Status = "succeeded"
	s.runs[runID].FinishedAt = &finished
	s.activeRun = ""
	s.mu.Unlock()

	kind, level, msg := "Disturbed", "firing", "LUN count changed from 4 to 6"
	if action == "fix" {
		kind, level, msg = "Fixed", "resolved", "LUN count restored to 4"
	}
	s.publish(event{Kind: kind, Level: level, ResourceID: "demo-storage-01", Message: msg, At: time.Now().UTC()})
}

func (s *server) handleRunStatus(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}
	runID := r.PathValue("run_id")
	s.mu.Lock()
	rn, ok := s.runs[runID]
	s.mu.Unlock()
	if !ok {
		http.NotFound(w, r)
		return
	}
	writeJSON(w, http.StatusOK, rn)
}

func (s *server) publish(e event) {
	s.mu.Lock()
	s.nextEvtID++
	e.ID = s.nextEvtID
	s.events = append(s.events, e)
	s.mu.Unlock()

	s.subsMu.Lock()
	for ch := range s.subs {
		select {
		case ch <- e:
		default: // slow subscriber: drop rather than block
		}
	}
	s.subsMu.Unlock()
}

func (s *server) handleEvents(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	var lastID int64
	if v := r.Header.Get("Last-Event-ID"); v != "" {
		lastID, _ = strconv.ParseInt(v, 10, 64)
	}

	s.mu.Lock()
	backlog := make([]event, 0, len(s.events))
	for _, e := range s.events {
		if e.ID > lastID {
			backlog = append(backlog, e)
		}
	}
	s.mu.Unlock()
	for _, e := range backlog {
		writeSSE(w, e)
	}
	flusher.Flush()

	ch := make(chan event, 16)
	s.subsMu.Lock()
	s.subs[ch] = struct{}{}
	s.subsMu.Unlock()
	defer func() {
		s.subsMu.Lock()
		delete(s.subs, ch)
		s.subsMu.Unlock()
	}()

	for {
		select {
		case e := <-ch:
			writeSSE(w, e)
			flusher.Flush()
		case <-r.Context().Done():
			return
		}
	}
}

func writeSSE(w http.ResponseWriter, e event) {
	body, _ := json.Marshal(e)
	fmt.Fprintf(w, "id: %d\ndata: %s\n\n", e.ID, body)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// --- main ------------------------------------------------------------------

// loadTopologyFiles reads CLAB_YAML_FILE/INSPECT_JSON_FILE if both are set,
// returning ("", nil, nil) if either is unset (topology serving stays off,
// matching behavior from before this option existed) or an error if a
// file is set but unreadable.
func loadTopologyFiles() (clabYAML string, inspectJSON json.RawMessage, err error) {
	yamlPath := os.Getenv("CLAB_YAML_FILE")
	jsonPath := os.Getenv("INSPECT_JSON_FILE")
	if yamlPath == "" || jsonPath == "" {
		return "", nil, nil
	}
	yamlBytes, err := os.ReadFile(yamlPath)
	if err != nil {
		return "", nil, fmt.Errorf("reading CLAB_YAML_FILE: %w", err)
	}
	jsonBytes, err := os.ReadFile(jsonPath)
	if err != nil {
		return "", nil, fmt.Errorf("reading INSPECT_JSON_FILE: %w", err)
	}
	if !json.Valid(jsonBytes) {
		return "", nil, fmt.Errorf("INSPECT_JSON_FILE (%s) is not valid JSON", jsonPath)
	}
	return string(yamlBytes), json.RawMessage(jsonBytes), nil
}

func main() {
	addr := os.Getenv("LISTEN_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8081"
	}
	clabYAML, inspectJSON, err := loadTopologyFiles()
	if err != nil {
		log.Fatal(err)
	}
	s := newServer(os.Getenv("PLUGIN_TOKEN"), clabYAML, inspectJSON)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /plugin", s.handlePlugin)
	if s.hasTopology() {
		mux.HandleFunc("GET /plugin/topology", s.handleTopology)
	}
	mux.HandleFunc("GET /plugin/status", s.handleStatus)
	mux.HandleFunc("GET /plugin/scripts", s.handleScripts)
	mux.HandleFunc("POST /plugin/scripts/{id}/actions/{action}", s.handleRunAction)
	mux.HandleFunc("GET /plugin/runs/{run_id}", s.handleRunStatus)
	mux.HandleFunc("GET /plugin/events", s.handleEvents)

	if s.hasTopology() {
		log.Printf("serving GET /plugin/topology from %s / %s", os.Getenv("CLAB_YAML_FILE"), os.Getenv("INSPECT_JSON_FILE"))
	}
	log.Printf("example-plugin (contract v%s) listening on %s", contractVersion, addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}
