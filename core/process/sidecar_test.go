package process

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A command with no scheme is what it says it is. Resolution must not turn an
// ordinary program name into a search.
func TestAPlainCommandPassesThrough(t *testing.T) {
	for _, command := range []string{"/bin/sh", "claude"} {
		resolved, err := resolveCommand("/home", command)
		if err != nil {
			t.Fatalf("%s: %v", command, err)
		}
		if resolved != command {
			t.Fatalf("%s resolved to %s", command, resolved)
		}
	}
}

// A name outside ^[a-z0-9][a-z0-9-]*$ can walk out of the sidecars directory,
// so it is refused before anything is spawned.
func TestAnIllegalSidecarNameIsRefused(t *testing.T) {
	for _, command := range []string{"sidecar:", "sidecar:../evil", "sidecar:UPPER", "sidecar:a/b", "sidecar:-lead"} {
		if _, err := resolveCommand("/home", command); err == nil {
			t.Errorf("%s must be refused: the name is the only thing keeping resolution inside the sidecars directory", command)
		}
	}
}

// A sidecar that is not installed fails carrying the whole path that was
// searched, so the operator can see where it was expected.
func TestAMissingSidecarNamesThePathSearched(t *testing.T) {
	_, err := resolveCommand("/home", "sidecar:definitely-not-installed-xyz")
	if err == nil {
		t.Fatal("a missing sidecar must fail")
	}
	want := filepath.Join("/home", "sidecars", "soksak-sidecar-definitely-not-installed-xyz",
		"dist", "soksak-sidecar-definitely-not-installed-xyz")
	if !strings.Contains(err.Error(), want) {
		t.Fatalf("error %q must carry the path searched (%s)", err, want)
	}
}

func stageSidecar(t *testing.T, home, name string) string {
	t.Helper()
	directory := filepath.Join(home, "sidecars", "soksak-sidecar-"+name, "dist")
	if err := os.MkdirAll(directory, 0o755); err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(directory, "soksak-sidecar-"+name)
	if err := os.WriteFile(binary, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return binary
}

func TestAnInstalledSidecarResolvesToItsStagedBinary(t *testing.T) {
	home := t.TempDir()
	binary := stageSidecar(t, home, "probe")
	resolved, err := resolveCommand(home, "sidecar:probe")
	if err != nil {
		t.Fatal(err)
	}
	if resolved != binary {
		t.Fatalf("resolved to %s, want %s", resolved, binary)
	}
}

// A named path wins; nothing slides down a discovery chain. A plain
// used is_file(), which follows links, so an unnamed location could answer for
// the named one — a symlink anywhere below the home is refused, by component.
func TestASymlinkedComponentIsRefusedByName(t *testing.T) {
	home := t.TempDir()
	elsewhere := t.TempDir()
	real := filepath.Join(elsewhere, "dist")
	if err := os.MkdirAll(real, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(real, "soksak-sidecar-probe"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	unit := filepath.Join(home, "sidecars", "soksak-sidecar-probe")
	if err := os.MkdirAll(filepath.Dir(unit), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(elsewhere, unit); err != nil {
		t.Fatal(err)
	}

	_, err := resolveCommand(home, "sidecar:probe")
	if err == nil {
		t.Fatal("a symlinked component must be refused")
	}
	if !strings.Contains(err.Error(), unit) {
		t.Fatalf("error %q must name the component that is a symlink (%s)", err, unit)
	}
}

// The leaf itself is a named path too: a symlink there is refused for the same
// reason, even when it points at a real program.
func TestASymlinkedLeafIsRefused(t *testing.T) {
	home := t.TempDir()
	directory := filepath.Join(home, "sidecars", "soksak-sidecar-probe", "dist")
	if err := os.MkdirAll(directory, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/bin/sh", filepath.Join(directory, "soksak-sidecar-probe")); err != nil {
		t.Fatal(err)
	}
	if _, err := resolveCommand(home, "sidecar:probe"); err == nil {
		t.Fatal("a symlinked sidecar binary must be refused")
	}
}

// A directory where the binary should be is not a program.
func TestASidecarThatIsNotARegularFileIsRefused(t *testing.T) {
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, "sidecars", "soksak-sidecar-probe", "dist", "soksak-sidecar-probe"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := resolveCommand(home, "sidecar:probe"); err == nil {
		t.Fatal("a directory is not a sidecar binary")
	}
}

// Resolution needs a home. With none, the search has no root and every answer
// would be about this process's current directory instead.
func TestASidecarWithNoHomeIsRefused(t *testing.T) {
	if _, err := resolveCommand("", "sidecar:probe"); err == nil {
		t.Fatal("resolving a sidecar with no home must fail rather than search from nowhere")
	}
}
