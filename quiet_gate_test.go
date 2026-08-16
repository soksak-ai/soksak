package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// A running build reports nothing wrong about itself.
//
// Every gate before this one reads source or a stored record, and none of them puts a question to the
// application. A build can therefore be green while it is failing on screen: on 2026-08-16 three `renderer.error`
// entries sat in the activity stream saying `watch_dir has no filesystem watcher in this build`, the
// file tree's live refresh was dead, and `task verify` was clean. The reading existed and nothing
// read it.
//
// So this opens a window, does the ordinary things a person does — a workspace, a terminal, a
// browser — and then reads what the application reports about itself: the error stream, the border
// contract, whether any plugin was rejected, whether the activity ledger is taking writes. A number
// answers each, and any of them being wrong fails here rather than being noticed by eye later.
//
// It runs against a home of its own for the same reason the restore gate does, and it quits through
// `app.shutdown.commit` so the drain and the save happen.
const quietGateHome = "<local-evidence>/soksak-quiet-gate"

const quietGateIdentifier = "com.soksak.quietgate"

func TestARunningBuildReportsNothingWrong(t *testing.T) {
	gate := newQuietGate(t)
	plugins := gate.installPlugins()
	gate.start()
	defer gate.quit()

	window := gate.openWorkspace()
	gate.consentAndEnable(window, plugins)
	for _, program := range gate.programs(window) {
		gate.open(window, program)
	}

	// The error stream. A renderer error is a failure a person will meet; it has no other reader.
	if errors := gate.rendererErrors(window); len(errors) > 0 {
		t.Errorf("the running build holds %d renderer errors:\n%s\n"+
			"Each is something a person meets on screen. Fix it, or state it where it is refused.",
			len(errors), strings.Join(errors, "\n"))
	}

	// A plugin the loader refused. It answers `rejected` and nothing has ever read that either.
	if rejected := gate.rejectedPlugins(window); len(rejected) > 0 {
		t.Errorf("the loader refused %d plugins: %s", len(rejected), strings.Join(rejected, ", "))
	}

	// The border contract, over what is actually on screen.
	if pass, violations := gate.borderContract(window); !pass {
		t.Errorf("the border contract failed: %s", violations)
	}

	// The activity ledger. A publish that never lands means every observation above is blind.
	if healthy, detail := gate.activityHealthy(window); !healthy {
		t.Errorf("the activity ledger is not taking writes: %s", detail)
	}
}

func (gate *quietGate) rendererErrors(window string) []string {
	gate.t.Helper()
	var answer struct {
		Data struct {
			Entries []struct {
				Kind    string `json:"kind"`
				Payload struct {
					Error string `json:"error"`
				} `json:"payload"`
			} `json:"entries"`
		} `json:"data"`
	}
	out := gate.run("activity.recent", "window="+window)
	if err := json.Unmarshal([]byte(out), &answer); err != nil {
		gate.t.Fatalf("activity.recent: %v\n%s", err, out)
	}
	seen := map[string]bool{}
	var found []string
	for _, entry := range answer.Data.Entries {
		if entry.Kind != "renderer.error" || seen[entry.Payload.Error] {
			continue
		}
		seen[entry.Payload.Error] = true
		found = append(found, "  "+entry.Payload.Error)
	}
	return found
}

func (gate *quietGate) rejectedPlugins(window string) []string {
	gate.t.Helper()
	var answer struct {
		Data struct {
			Rejected []struct {
				ID     string `json:"id"`
				Reason string `json:"reason"`
			} `json:"rejected"`
		} `json:"data"`
	}
	out := gate.run("plugin.list", "window="+window)
	if err := json.Unmarshal([]byte(out), &answer); err != nil {
		gate.t.Fatalf("plugin.list: %v\n%s", err, out)
	}
	var found []string
	for _, r := range answer.Data.Rejected {
		found = append(found, r.ID+" ("+r.Reason+")")
	}
	return found
}

func (gate *quietGate) borderContract(window string) (bool, string) {
	gate.t.Helper()
	var answer struct {
		Data struct {
			Pass       bool              `json:"pass"`
			Violations []json.RawMessage `json:"violations"`
		} `json:"data"`
	}
	out := gate.run("ui.validate", "window="+window)
	if err := json.Unmarshal([]byte(out), &answer); err != nil {
		gate.t.Fatalf("ui.validate: %v\n%s", err, out)
	}
	parts := make([]string, 0, len(answer.Data.Violations))
	for _, v := range answer.Data.Violations {
		parts = append(parts, string(v))
	}
	return answer.Data.Pass, strings.Join(parts, "\n")
}

func (gate *quietGate) activityHealthy(window string) (bool, string) {
	gate.t.Helper()
	var answer struct {
		Data struct {
			Activity struct {
				Healthy   bool   `json:"healthy"`
				Attempts  int    `json:"attempts"`
				Failed    int    `json:"failed"`
				LastError string `json:"lastError"`
			} `json:"activity"`
		} `json:"data"`
	}
	out := gate.run("state.health", "window="+window)
	if err := json.Unmarshal([]byte(out), &answer); err != nil {
		gate.t.Fatalf("state.health: %v\n%s", err, out)
	}
	a := answer.Data.Activity
	return a.Healthy, a.LastError
}
