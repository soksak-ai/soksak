package scan

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

func write(t *testing.T, base, name string, manifest, state *string) {
	t.Helper()
	dir := filepath.Join(base, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if manifest != nil {
		if err := os.WriteFile(filepath.Join(dir, "plugin.json"), []byte(*manifest), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if state != nil {
		if err := os.WriteFile(filepath.Join(dir, ".soksak.json"), []byte(*state), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func text(s string) *string { return &s }

func TestUnitsAreDirectoriesListedByName(t *testing.T) {
	base := t.TempDir()
	write(t, base, "zeta", text(`{"id":"zeta"}`), nil)
	write(t, base, "alpha", text(`{"id":"alpha"}`), text(`{"version":"0.0.1"}`))

	found, err := Units(base)
	if err != nil {
		t.Fatal(err)
	}
	if len(found) != 2 {
		t.Fatalf("found %d units, want 2", len(found))
	}
	if found[0].DirName != "alpha" || found[1].DirName != "zeta" {
		t.Errorf("order = %q, %q; want alpha, zeta", found[0].DirName, found[1].DirName)
	}
	if found[0].Dir != filepath.Join(base, "alpha") {
		t.Errorf("dir = %q", found[0].Dir)
	}
	if found[0].State == nil || *found[0].State != `{"version":"0.0.1"}` {
		t.Errorf("state = %v, want the install record", found[0].State)
	}
	if found[1].State != nil {
		t.Errorf("state = %v, want nil for a unit with no install record", *found[1].State)
	}
}

func TestAUnitWithNoManifestIsReportedNotDropped(t *testing.T) {
	// Dropping it shows the user "not installed", and that wrong answer is
	// silent. The reason goes in the entry instead.
	base := t.TempDir()
	write(t, base, "broken", nil, nil)

	found, err := Units(base)
	if err != nil {
		t.Fatal(err)
	}
	if len(found) != 1 {
		t.Fatalf("found %d units, want 1", len(found))
	}
	if found[0].Manifest != nil {
		t.Error("manifest must be nil when plugin.json is absent")
	}
	if found[0].Error == nil {
		t.Fatal("the entry must state why the manifest is missing")
	}
}

func TestFilesAndDotNamesAreNotUnits(t *testing.T) {
	// .tmp-* is an install staging directory. A file is not a unit at all.
	base := t.TempDir()
	write(t, base, ".tmp-1234", text(`{"id":"x"}`), nil)
	write(t, base, "real", text(`{"id":"real"}`), nil)
	if err := os.WriteFile(filepath.Join(base, "readme.md"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	found, err := Units(base)
	if err != nil {
		t.Fatal(err)
	}
	if len(found) != 1 || found[0].DirName != "real" {
		t.Fatalf("found %+v, want only real", found)
	}
}

func TestUnitAbsenceAndUnreadableStayDifferentAnswers(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "never-created")
	found, err := Units(missing)
	if err != nil {
		t.Fatalf("absence must be an empty list: %v", err)
	}
	if found == nil {
		t.Fatal("the result must be an empty slice, never nil")
	}
	if len(found) != 0 {
		t.Errorf("found %d units in a missing base", len(found))
	}

	notADir := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(notADir, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Units(notADir); err == nil {
		t.Error("a base that cannot be read must be an error")
	}
}

func TestUnitIDCharsetForbidsEscape(t *testing.T) {
	// The charset itself is the defence: neither "." nor "/" is a legal
	// character, so "..", "a/b" and absolute paths are refused before any
	// path rule runs. This check must not exist twice — one looser copy opens
	// the home on that side only, and the difference is invisible from the
	// side that refused.
	for _, ok := range []string{"memo", "git-2", "soksak-plugin-terminal-xterm", "a"} {
		if err := ValidUnitID(ok); err != nil {
			t.Errorf("ValidUnitID(%q) = %v, want accepted", ok, err)
		}
	}
	for _, bad := range []string{"", "-a", "A", "a/b", "a..b", "../x", "한글", "a_b", "/abs"} {
		if err := ValidUnitID(bad); err == nil {
			t.Errorf("ValidUnitID(%q) = nil, want refused", bad)
		}
	}
}

func TestTheWireShapeIsWhatTheFrontendReads(t *testing.T) {
	// frontend/src/state/plugins.ts declares PluginScanEntry with exactly these
	// keys. A renamed key here is not a compile error on either side: the
	// frontend reads undefined, treats the unit as manifest-less, and skips it
	// without a message (measured 2026-08-15 — every unit was dropped this way).
	base := t.TempDir()
	write(t, base, "one", text(`{"id":"one"}`), text(`{}`))
	found, err := Units(base)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(found[0])
	if err != nil {
		t.Fatal(err)
	}
	var keyed map[string]any
	if err := json.Unmarshal(encoded, &keyed); err != nil {
		t.Fatal(err)
	}
	want := []string{"dir", "dir_name", "error", "manifest", "state"}
	got := make([]string, 0, len(keyed))
	for key := range keyed {
		got = append(got, key)
	}
	sort.Strings(got)
	if !reflect.DeepEqual(got, want) {
		t.Errorf("wire keys = %v, want %v", got, want)
	}

	// Absence arrives as null, never as a missing key or "".
	write(t, base, "two", nil, nil)
	found, err = Units(base)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ = json.Marshal(found[1])
	if !strings.Contains(string(encoded), `"state":null`) {
		t.Errorf("an absent install record must encode as null: %s", encoded)
	}
}

func TestRemovingAUnitTakesItsDirectoryAndNothingElse(t *testing.T) {
	base := t.TempDir()
	write(t, base, "memo", text(`{"id":"memo"}`), nil)
	write(t, base, "keep", text(`{"id":"keep"}`), nil)
	// The unit's private data is outside base. A reinstall that starts empty is
	// a loss the user sees as default settings, not as an error.
	data := filepath.Join(t.TempDir(), "memo")
	if err := os.MkdirAll(data, 0o755); err != nil {
		t.Fatal(err)
	}

	if err := RemoveUnit(base, "memo"); err != nil {
		t.Fatalf("removing an installed unit: %v", err)
	}
	if _, err := os.Stat(filepath.Join(base, "memo")); !os.IsNotExist(err) {
		t.Error("the unit directory is still there")
	}
	if _, err := os.Stat(filepath.Join(base, "keep")); err != nil {
		t.Errorf("another unit was taken with it: %v", err)
	}
	if _, err := os.Stat(data); err != nil {
		t.Errorf("the unit's data directory was deleted: %v", err)
	}
}

func TestRemovingWhatIsNotInstalledIsRefused(t *testing.T) {
	// Reporting success would let a typo pass as a removal that never happened.
	base := t.TempDir()
	if err := RemoveUnit(base, "ghost"); err == nil {
		t.Error("removing an absent unit answered success")
	}
	if err := RemoveUnit(base, "../etc"); err == nil {
		t.Error("an id that climbs out of the base was accepted")
	}
}
