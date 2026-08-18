package main

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"
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

	// The catalogue. Every registry answers a status and an error, and nothing has ever read either:
	// a stamp renamed in this repository made the served index unreadable and `task verify` stayed
	// green while 54 published units were invisible.
	if unreadable := gate.unreadableRegistries(window); len(unreadable) > 0 {
		t.Errorf("the build cannot read %d registries:\n%s\n"+
			"A registry that does not read is a catalogue nobody can install from.",
			len(unreadable), strings.Join(unreadable, "\n"))
	}

	// Overlays held with nothing open. A native surface is composited above the document, so an open
	// overlay parks every view — two modals App mounts for the whole session registered
	// unconditionally, `state.health` answered `overlays: 2` at rest, and the window went blank the
	// moment that count was read (measured 2026-08-17).
	if held := gate.overlaysHeld(window); held > 0 {
		t.Errorf("%d overlays are held with nothing open.\n"+
			"Every view is parked while one is, so the window draws nothing and no command says why.",
			held)
	}

	// The document's own account of its start. A boot failure was recorded on the document element
	// and in the console, and neither was a reading: measured 2026-08-17, `<html>` carried
	// data-boot-status="failed" while the renderer error stream held nothing, and the way it was
	// found was a person opening an inspector.
	if status, detail := gate.bootStatus(window); status != "" && status != "ready" {
		t.Errorf("the document reports its start as %q: %s\n"+
			"A window that did not start is not one anybody should be reading numbers from.",
			status, detail)
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

// A ledger with no attempt yet is unconfirmed, not healthy — `activityHealth` states this — and the
// gate read it before the first publish landed on 1 run in 5, failing with an empty reason. So it
// waits for the ledger to have answered at all, and a ledger that never answers fails as itself.
func (gate *quietGate) activityHealthy(window string) (bool, string) {
	gate.t.Helper()
	var a struct {
		Healthy            bool   `json:"healthy"`
		OK                 int    `json:"ok"`
		Attempts           int    `json:"attempts"`
		ConsecutiveFailure int    `json:"consecutiveFailures"`
		StampRegressions   int    `json:"stampRegressions"`
		LedgerSwitches     int    `json:"ledgerSwitches"`
		LastError          string `json:"lastError"`
	}
	for attempt := 0; attempt < 50; attempt++ {
		var answer struct {
			Data struct {
				Activity json.RawMessage `json:"activity"`
			} `json:"data"`
		}
		out := gate.run("state.health", "window="+window)
		if err := json.Unmarshal([]byte(out), &answer); err != nil {
			gate.t.Fatalf("state.health: %v\n%s", err, out)
		}
		if err := json.Unmarshal(answer.Data.Activity, &a); err != nil {
			gate.t.Fatalf("state.health activity: %v\n%s", err, out)
		}
		if a.Attempts > 0 {
			break
		}
		// Polled: the ledger is written as a side effect of whatever runs, and nothing announces
		// that it has been written to for the first time. What is being asked is whether the
		// observation wiring records at all, which has no edge of its own to wait on.
		time.Sleep(100 * time.Millisecond)
	}
	if a.Attempts == 0 {
		return false, "the ledger was never written to, so nothing observed here was recorded"
	}
	return a.Healthy, a.LastError + " (ok " + strconv.Itoa(a.OK) + " of " + strconv.Itoa(a.Attempts) +
		" attempts, " + strconv.Itoa(a.ConsecutiveFailure) + " consecutive failures, " +
		strconv.Itoa(a.StampRegressions) + " stamp regressions, " + strconv.Itoa(a.LedgerSwitches) + " ledger switches)"
}

func (gate *quietGate) unreadableRegistries(window string) []string {
	gate.t.Helper()
	var answer struct {
		Data struct {
			Registries []struct {
				ID        string `json:"id"`
				Status    string `json:"status"`
				UnitCount int    `json:"unitCount"`
				Error     string `json:"error"`
			} `json:"registries"`
		} `json:"data"`
	}
	out := gate.run("plugin.catalog", "window="+window, "refresh=true")
	if err := json.Unmarshal([]byte(out), &answer); err != nil {
		gate.t.Fatalf("plugin.catalog: %v\n%s", err, out)
	}
	// No registries at all reads as nothing wrong, which is how a gate passes over an empty answer.
	if len(answer.Data.Registries) == 0 {
		return []string{"  no registries are configured, so there is nothing to install from"}
	}
	var found []string
	for _, r := range answer.Data.Registries {
		if r.Status == "live" && r.UnitCount > 0 {
			continue
		}
		found = append(found, "  "+r.ID+" -> "+r.Status+" ("+r.Error+"), "+strconv.Itoa(r.UnitCount)+" units")
	}
	return found
}

func (gate *quietGate) overlaysHeld(window string) int {
	gate.t.Helper()
	var answer struct {
		Data struct {
			Overlays int `json:"overlays"`
		} `json:"data"`
	}
	out := gate.run("state.health", "window="+window)
	if err := json.Unmarshal([]byte(out), &answer); err != nil {
		gate.t.Fatalf("state.health: %v\n%s", err, out)
	}
	return answer.Data.Overlays
}

func (gate *quietGate) bootStatus(window string) (status string, detail string) {
	gate.t.Helper()
	var answer struct {
		Data struct {
			Boot struct {
				Status       string `json:"status"`
				Error        string `json:"error"`
				RuntimeError string `json:"runtimeError"`
			} `json:"boot"`
		} `json:"data"`
	}
	out := gate.run("state.health", "window="+window)
	if err := json.Unmarshal([]byte(out), &answer); err != nil {
		gate.t.Fatalf("state.health: %v\n%s", err, out)
	}
	boot := answer.Data.Boot
	return boot.Status, strings.TrimSpace(boot.Error + "\n" + boot.RuntimeError)
}
