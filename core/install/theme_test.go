package install

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestAThemeLandsWhereTheScanReads is the property that makes this command
// worth serving at all. themes_scan is scan.Directory(<home>/themes, ".json");
// an install that answered a path outside that directory would report success
// and change nothing a user can see.
func TestAThemeLandsWhereTheScanReads(t *testing.T) {
	home := t.TempDir()
	source := filepath.Join(t.TempDir(), "midnight.json")
	if err := os.WriteFile(source, []byte(`{"name":"midnight"}`), 0o644); err != nil {
		t.Fatalf("writing the source: %v", err)
	}

	landed, err := installTheme(home, source)
	if err != nil {
		t.Fatalf("installing: %v", err)
	}
	want := filepath.Join(home, "themes", "midnight.json")
	if landed != want {
		t.Fatalf("landed = %q, want %q", landed, want)
	}
	body, err := os.ReadFile(want)
	if err != nil {
		t.Fatalf("reading it back: %v", err)
	}
	if string(body) != `{"name":"midnight"}` {
		t.Errorf("contents = %q", body)
	}
}

// TestInstallingTheSameNameAgainIsAnUpdate. Replacing is what a user means by
// installing a theme they already have, and refusing would make the second
// install of a corrected file impossible.
func TestInstallingTheSameNameAgainIsAnUpdate(t *testing.T) {
	home := t.TempDir()
	directory := t.TempDir()
	source := filepath.Join(directory, "midnight.json")

	for _, body := range []string{`{"v":1}`, `{"v":2}`} {
		if err := os.WriteFile(source, []byte(body), 0o644); err != nil {
			t.Fatalf("writing the source: %v", err)
		}
		if _, err := installTheme(home, source); err != nil {
			t.Fatalf("installing %s: %v", body, err)
		}
	}

	body, err := os.ReadFile(filepath.Join(home, "themes", "midnight.json"))
	if err != nil {
		t.Fatalf("reading it back: %v", err)
	}
	if string(body) != `{"v":2}` {
		t.Errorf("contents = %q, want the second install", body)
	}
}

// TestTheDestinationNameCannotEscapeTheThemesDirectory. The file name comes
// from the source and nothing else, so however the source is spelled — through
// a real `..` the operating system resolves — the write stays where the scan
// looks.
func TestTheDestinationNameCannotEscapeTheThemesDirectory(t *testing.T) {
	home := t.TempDir()
	directory := t.TempDir()
	if err := os.MkdirAll(filepath.Join(directory, "sub"), 0o755); err != nil {
		t.Fatalf("making the traversal: %v", err)
	}
	if err := os.WriteFile(filepath.Join(directory, "escape.json"), []byte(`{}`), 0o644); err != nil {
		t.Fatalf("writing the source: %v", err)
	}

	// Spelled so the string still holds the `..`: filepath.Join would clean
	// it away and the test would prove nothing.
	landed, err := installTheme(home, directory+"/sub/../escape.json")
	if err != nil {
		t.Fatalf("installing: %v", err)
	}
	if landed != filepath.Join(home, "themes", "escape.json") {
		t.Fatalf("landed = %q, want it inside the themes directory", landed)
	}
}

// TestARefusedInstallLeavesTheThemeThatWasThere. A theme is read by the whole
// application at once, so a half-written file is not a failed install — it is a
// parse error against a theme the user already had.
func TestARefusedInstallLeavesTheThemeThatWasThere(t *testing.T) {
	home := t.TempDir()
	themes := filepath.Join(home, "themes")
	if err := os.MkdirAll(themes, 0o755); err != nil {
		t.Fatalf("making the themes directory: %v", err)
	}
	standing := filepath.Join(themes, "midnight.json")
	if err := os.WriteFile(standing, []byte(`{"v":1}`), 0o644); err != nil {
		t.Fatalf("writing the standing theme: %v", err)
	}

	if _, err := installTheme(home, filepath.Join(t.TempDir(), "midnight.json")); err == nil {
		t.Fatal("a source that does not exist was installed")
	}

	body, err := os.ReadFile(standing)
	if err != nil {
		t.Fatalf("reading the standing theme: %v", err)
	}
	if string(body) != `{"v":1}` {
		t.Errorf("the standing theme changed: %q", body)
	}

	left, err := os.ReadDir(themes)
	if err != nil {
		t.Fatalf("reading the themes directory: %v", err)
	}
	if len(left) != 1 {
		t.Errorf("a refused install left debris: %v", left)
	}
}

// TestOnlyAJsonThemeIsInstalled. The scan reads *.json, so anything else lands
// where nothing looks — a success that installs nothing.
func TestOnlyAJsonThemeIsInstalled(t *testing.T) {
	home := t.TempDir()
	source := filepath.Join(t.TempDir(), "midnight.toml")
	if err := os.WriteFile(source, []byte("name = 'midnight'"), 0o644); err != nil {
		t.Fatalf("writing the source: %v", err)
	}
	if _, err := installTheme(home, source); err == nil {
		t.Fatal("a non-json file was installed")
	}
}

// TestNoHomeIsRefusedByName. Choosing a directory here would put the theme
// somewhere the scan does not read, and the caller would be told a path.
func TestNoHomeIsRefusedByName(t *testing.T) {
	_, err := installTheme("", "/somewhere/midnight.json")
	if err == nil {
		t.Fatal("a build with no home installed a theme somewhere")
	}
	if !strings.Contains(err.Error(), "install.Deps.Home") {
		t.Errorf("the refusal does not name what is missing: %v", err)
	}
}
