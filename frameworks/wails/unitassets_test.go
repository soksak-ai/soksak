package wails

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

func rootWithUnit(t *testing.T) (string, string) {
	t.Helper()
	// EvalSymlinks because macOS puts TempDir under /var, which is a link to
	// /private/var. Without it the fixture path and the served path differ.
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	unit := filepath.Join(root, "soksak-plugin-terminal-xterm")
	if err := os.MkdirAll(unit, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(unit, "main.js"), []byte("export function activate(){}"), 0o644); err != nil {
		t.Fatal(err)
	}
	return root, unit
}

func get(t *testing.T, roots []string, path string) *httptest.ResponseRecorder {
	t.Helper()
	refused := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("the route passed a unit-file request to the next handler")
		w.WriteHeader(http.StatusNotFound)
	})
	request := httptest.NewRequest(http.MethodGet, PluginFileRoute+"?"+pluginFileQuery+"="+url.QueryEscape(path), nil)
	recorder := httptest.NewRecorder()
	PluginFiles(roots, refused).ServeHTTP(recorder, request)
	return recorder
}

func TestAUnitFileIsServedWithTheTypeAModuleLoaderAccepts(t *testing.T) {
	root, unit := rootWithUnit(t)

	response := get(t, []string{root}, filepath.Join(unit, "main.js"))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if response.Body.String() != "export function activate(){}" {
		t.Errorf("body = %q", response.Body.String())
	}
	// text/plain is refused by the module loader, and the refusal names the
	// MIME type rather than the file.
	if got := response.Header().Get("Content-Type"); got != "text/javascript; charset=utf-8" {
		t.Errorf("Content-Type = %q", got)
	}
	// A rebuilt bundle has to reach the page. A cached one keeps the previous
	// code running with no sign that it did.
	if got := response.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q", got)
	}
}

func TestEverythingOutsideTheUnitRootIsRefused(t *testing.T) {
	root, unit := rootWithUnit(t)
	elsewhere := filepath.Join(t.TempDir(), "secret.txt")
	if err := os.WriteFile(elsewhere, []byte("private"), 0o644); err != nil {
		t.Fatal(err)
	}

	for name, path := range map[string]string{
		"a sibling directory":     elsewhere,
		"an absolute system path": "/etc/passwd",
		"a climb out of the root": filepath.Join(unit, "..", "..", "escaped.js"),
		"a relative path":         "main.js",
		"no path at all":          "",
	} {
		response := get(t, []string{root}, path)
		if response.Code != http.StatusForbidden {
			t.Errorf("%s: status = %d, want 403; body = %s", name, response.Code, response.Body.String())
		}
	}
}

func TestASymlinkOutOfTheRootIsRefused(t *testing.T) {
	// A link inside the root can point anywhere, so containment is checked
	// after the link is resolved, not on the requested string.
	root, unit := rootWithUnit(t)
	target := filepath.Join(t.TempDir(), "outside.js")
	if err := os.WriteFile(target, []byte("stolen"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(unit, "linked.js")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("this filesystem does not make symlinks: %v", err)
	}

	response := get(t, []string{root}, link)
	if response.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403; body = %s", response.Code, response.Body.String())
	}
}

func TestAMissingUnitFileIsNotFoundRatherThanRefused(t *testing.T) {
	// The two send a caller to different places: a wrong path is the caller's,
	// an absent file is the unit's.
	root, unit := rootWithUnit(t)

	response := get(t, []string{root}, filepath.Join(unit, "never-built.js"))
	if response.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404; body = %s", response.Code, response.Body.String())
	}
}

func TestARequestOnAnotherRoutePassesThrough(t *testing.T) {
	root, _ := rootWithUnit(t)
	served := false
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		served = true
		w.WriteHeader(http.StatusOK)
	})

	request := httptest.NewRequest(http.MethodGet, "/index.html", nil)
	PluginFiles([]string{root}, next).ServeHTTP(httptest.NewRecorder(), request)
	if !served {
		t.Error("the application's own assets must still be served")
	}
}

func TestWithNoRootTheRouteRefusesByName(t *testing.T) {
	// An unwired route that answers 404 reads as a missing file, and the unit
	// author looks at their build instead of the host.
	response := get(t, nil, "/anywhere/main.js")
	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", response.Code)
	}
	if body := response.Body.String(); body == "" {
		t.Error("the refusal states nothing")
	}
}

func TestFilesFromEveryDeclaredPluginRootAreServed(t *testing.T) {
	firstRoot, first := rootWithUnit(t)
	secondRoot, second := rootWithUnit(t)
	for _, test := range []struct {
		root string
		path string
	}{{firstRoot, filepath.Join(first, "main.js")}, {secondRoot, filepath.Join(second, "main.js")}} {
		response := get(t, []string{firstRoot, secondRoot}, test.path)
		if response.Code != http.StatusOK {
			t.Fatalf("root=%s status=%d body=%s", test.root, response.Code, response.Body.String())
		}
	}
}
