package wails

import (
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// The route this host serves unit files on, and the query it reads the path
// from. The frontend states the same route in
// frontend/src/framework/wails/index.ts.
const (
	UnitFileRoute = "/-/unit-file"
	unitFileQuery = "path"
)

// UnitFiles serves one file out of the unit root to the webview.
//
// A plugin bundle is 400KB and larger. Passing it through a command encodes it
// as a JSON string and decodes it again: measured 2026-08-08, 23.8MB of bundles
// spent 818ms on that encoding alone, and batching 34 reads into one call did
// not change it. The engine loads a URL without any of that, so the bundle
// arrives on the same path an image would.
//
// root is the only directory this route reads from. Every other path is
// refused, including one that starts inside root and climbs out through "..",
// and one that reaches outside through a symlink. Without that check the route
// is a read of the whole filesystem, addressable by any page in the webview.
func UnitFiles(root string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != UnitFileRoute {
			next.ServeHTTP(writer, request)
			return
		}
		resolved, err := unitFilePath(root, request.URL.Query().Get(unitFileQuery))
		if err != nil {
			http.Error(writer, err.Error(), http.StatusForbidden)
			return
		}
		contents, err := os.ReadFile(resolved)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				http.Error(writer, fmt.Sprintf("no file at %s", resolved), http.StatusNotFound)
				return
			}
			http.Error(writer, err.Error(), http.StatusInternalServerError)
			return
		}
		writer.Header().Set("Content-Type", contentType(resolved))
		// A unit's files change when the unit is reinstalled or rebuilt, and a
		// cached bundle would keep the previous code running after that.
		writer.Header().Set("Cache-Control", "no-store")
		_, _ = writer.Write(contents)
	})
}

// unitFilePath resolves a requested path against the root, or states why it is
// refused.
//
// Symlinks are resolved before the containment check, because a link inside
// root can point anywhere. EvalSymlinks also resolves the root itself: on macOS
// the home sits under /var, which is a link to /private/var, so an unresolved
// root never contains a resolved path.
func unitFilePath(root, requested string) (string, error) {
	if root == "" {
		return "", errors.New("this build serves no unit root, so no unit file can be read")
	}
	if requested == "" {
		return "", fmt.Errorf("the request carries no %q, so there is nothing to read", unitFileQuery)
	}
	if !filepath.IsAbs(requested) {
		return "", fmt.Errorf("%q is relative; a unit file is addressed by its absolute path", requested)
	}
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", fmt.Errorf("the unit root %s could not be resolved: %w", root, err)
	}
	resolved, err := filepath.EvalSymlinks(filepath.Clean(requested))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			// A missing file still has to pass the scope check, or absence
			// becomes a way to ask about paths outside the root.
			cleaned := filepath.Clean(requested)
			if !within(resolvedRoot, cleaned) {
				return "", outside(cleaned, resolvedRoot)
			}
			return cleaned, nil
		}
		return "", fmt.Errorf("%s could not be resolved: %w", requested, err)
	}
	if !within(resolvedRoot, resolved) {
		return "", outside(resolved, resolvedRoot)
	}
	return resolved, nil
}

func within(root, path string) bool {
	if path == root {
		return true
	}
	return strings.HasPrefix(path, root+string(filepath.Separator))
}

func outside(path, root string) error {
	return fmt.Errorf("%s is outside %s; this route reads unit files and nothing else", path, root)
}

// contentType is what the engine needs to execute a bundle.
//
// A module served as text/plain is refused by the module loader, and the
// refusal names the MIME type rather than the file, so the cause is not in the
// message.
func contentType(path string) string {
	switch filepath.Ext(path) {
	case ".js", ".mjs":
		return "text/javascript; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".json":
		return "application/json; charset=utf-8"
	case ".wasm":
		return "application/wasm"
	default:
		return "application/octet-stream"
	}
}
