package wails

import (
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/soksak-ai/soksak-core/core/i18n"
)

// The route this host serves plugin files on, and the query it reads the path
// from. The frontend states the same route in
// frontend/src/framework/wails/index.ts.
const (
	PluginFileRoute = "/-/plugin-file"
	pluginFileQuery = "path"
)

// PluginFiles serves one file from the active plugin paths.
//
// A plugin bundle is 400KB and larger. Passing it through a command encodes it
// as a JSON string and decodes it again: measured 2026-08-08, 23.8MB of bundles
// spent 818ms on that encoding alone, and batching 34 reads into one call did
// not change it. The engine loads a URL without any of that, so the bundle
// arrives on the same path an image would.
//
// root is the only directory this route reads from. Every other path is
// refused, including one that starts inside root and climbs out through "..",
// and one that resolves outside through a symlink. Without that check the route
// is a read of the whole filesystem, addressable by any page in the webview.
func PluginFiles(roots func() ([]string, error), next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != PluginFileRoute {
			next.ServeHTTP(writer, request)
			return
		}
		if roots == nil {
			http.Error(writer, "plugin asset roots are not configured", http.StatusInternalServerError)
			return
		}
		declared, err := roots()
		if err != nil {
			http.Error(writer, err.Error(), http.StatusInternalServerError)
			return
		}
		resolved, err := pluginFilePath(declared, request.URL.Query().Get(pluginFileQuery))
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
// the home is under /var, which is a link to /private/var, so an unresolved
// root never contains a resolved path.
func pluginFilePath(roots []string, requested string) (string, error) {
	if len(roots) == 0 {
		return "", i18n.Errorf("wails.pluginFile.noRoots", nil)
	}
	if requested == "" {
		return "", i18n.Errorf("wails.pluginFile.noPath", map[string]string{"field": pluginFileQuery})
	}
	if !filepath.IsAbs(requested) {
		return "", i18n.Errorf("wails.pluginFile.relative", map[string]string{"path": requested})
	}
	resolved, err := filepath.EvalSymlinks(filepath.Clean(requested))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			cleaned := filepath.Clean(requested)
			if _, scopeErr := declaredRoot(roots, cleaned); scopeErr != nil {
				return "", scopeErr
			}
			return cleaned, nil
		}
		return "", fmt.Errorf("%s could not be resolved: %w", requested, err)
	}
	if _, err := declaredRoot(roots, resolved); err != nil {
		return "", err
	}
	return resolved, nil
}

func declaredRoot(roots []string, path string) (string, error) {
	for _, root := range roots {
		resolvedRoot, err := filepath.EvalSymlinks(root)
		if err != nil {
			return "", fmt.Errorf("plugin root %s could not be resolved: %w", root, err)
		}
		if within(resolvedRoot, path) {
			return resolvedRoot, nil
		}
	}
	return "", i18n.Errorf("wails.pluginFile.undeclared", map[string]string{"path": path})
}

func within(root, path string) bool {
	if path == root {
		return true
	}
	return strings.HasPrefix(path, root+string(filepath.Separator))
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
