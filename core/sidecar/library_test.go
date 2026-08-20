package sidecar

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A unit that ships a library is refused by a host that loads none.
//
// A release declares its artefacts and how each one is opened — `process[]` is spawned, `library[]`
// is loaded across a C ABI (SIDECARS.md S3). This host spawns; nothing here loads anything, and
// S7 records that no host in this build does.
//
// Until 2026-08-20 the question was asked of the plugin's permission list instead: a manifest
// holding the `sidecar` permission and any `sidecars[]` entry was read as needing a loader, which
// refused every consumer of a spawned unit for a requirement it did not have. That is grading a
// unit by a label, which is the move S3 forbids — the label is on the wrong side, since the plugin
// declares which unit it wants and the unit declares what it is made of.
//
// So the reading moved here, to the release the open already reads.
func TestAUnitThatShipsALibraryIsRefused(t *testing.T) {
	home := t.TempDir()
	stageRelease(t, home, "chromium", map[string]any{
		"id":        "soksak-sidecar-chromium",
		"version":   "0.0.1",
		"interface": map[string]string{"id": "soksak-spec-sidecar-browser", "version": "0.0.1"},
		"library":   []string{"libchromium.dylib"},
	})

	_, err := ProvidedFromRelease(home)("chromium")
	if err == nil {
		t.Fatal("a unit declaring a library opened on a host that loads none.\n" +
			"Nothing would load it, and the plugin would run with the half of itself that draws missing " +
			"— which reads as a blank pane rather than as a unit this build cannot open.")
	}
	if !strings.Contains(err.Error(), "libchromium.dylib") {
		t.Fatalf("the refusal is %q and does not name the artefact.\n"+
			"A reader cannot tell which of a unit's artefacts this build has no place for.", err)
	}
}

// A unit that ships only processes opens.
//
// This is the case the permission rule refused. It is stated separately because a refusal that
// catches everything passes the test above while shipping nothing that works.
func TestAUnitThatShipsOnlyProcessesOpens(t *testing.T) {
	home := t.TempDir()
	stageRelease(t, home, "pty", map[string]any{
		"id":        "soksak-sidecar-pty",
		"version":   "0.0.1",
		"interface": map[string]string{"id": "soksak-spec-sidecar-pty", "version": "0.0.1"},
		"process":   []string{"soksak-sidecar-pty"},
	})

	provided, err := ProvidedFromRelease(home)("pty")
	if err != nil {
		t.Fatalf("a spawned unit was refused: %v", err)
	}
	if provided.ID != "soksak-spec-sidecar-pty" {
		t.Fatalf("it answered %q", provided.ID)
	}
}

// A release that declares no artefact at all still opens.
//
// Every unit installed before the artefact fields existed is this shape, and refusing them would
// take a build that works today and stop it on a field nothing wrote yet.
func TestAReleaseWithNoArtefactsOpens(t *testing.T) {
	home := t.TempDir()
	stageRelease(t, home, "quiet", map[string]any{
		"id":        "soksak-sidecar-quiet",
		"version":   "0.0.1",
		"interface": map[string]string{"id": "soksak-spec-sidecar-quiet", "version": "0.0.1"},
	})

	if _, err := ProvidedFromRelease(home)("quiet"); err != nil {
		t.Fatalf("a release naming no artefact was refused: %v", err)
	}
}

func stageRelease(t *testing.T, home, unit string, release map[string]any) {
	t.Helper()
	dir := filepath.Join(home, "sidecars", "soksak-sidecar-"+unit, "release")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(release)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "unit.json"), body, 0o600); err != nil {
		t.Fatal(err)
	}
}
