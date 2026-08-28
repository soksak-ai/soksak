package environment

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/soksak-ai/soksak-core/core/i18n"
)

// SetPluginDevelopment registers path as the development source for plugin id.
// plugin.json is read once (readRecordManifest): a directory whose manifest
// cannot be read or parsed, or declares another id, is refused with
// environment.develop.directoryUnavailable. An existing record for id is
// replaced; its Enabled flag is kept. Installed artifact directories are not
// removed.
func SetPluginDevelopment(home, id, path string, expected uint64) (Change, error) {
	if err := validateDevelopmentPath(path); err != nil {
		return Change{}, err
	}
	record := Component{Path: path, Source: DevelopmentSource}
	manifest, err := readRecordManifest("plugin", id, record)
	if err != nil {
		return Change{}, err
	}
	entry, err := manifestEntry(id, manifest.Entry)
	if err != nil {
		return Change{}, err
	}
	if entry != "" {
		if err := validateRegularPath(path, entry); err != nil {
			return Change{}, err
		}
	}
	current, exists, err := Read(home)
	if err != nil {
		return Change{}, err
	}
	if !exists {
		return Change{}, os.ErrNotExist
	}
	next := Clone(current)
	record.Version = manifest.Version
	next.Plugins[id] = Plugin{Component: record, Enabled: current.Plugins[id].Enabled}
	if err := validateDependencies(current, next, nil, map[recordKey]recordManifest{{"plugin", id}: manifest}); err != nil {
		return Change{}, err
	}
	return Write(home, current, true, next, expected)
}

// SetSidecarDevelopment registers path as the development source for sidecar id.
// sidecar.json is read once under the same rule as SetPluginDevelopment.
// target is the host artifact triple. dist/<id> must exist as a regular file.
func SetSidecarDevelopment(home, id, path, target, project string, expected uint64) (Change, error) {
	if err := validateDevelopmentPath(path); err != nil {
		return Change{}, err
	}
	record := Component{Path: path, Source: DevelopmentSource, Target: target}
	manifest, err := readRecordManifest("sidecar", id, record)
	if err != nil {
		return Change{}, err
	}
	process, err := MaterializedSidecarProcess(project, manifest.ProcessRole, manifest.Process)
	if err != nil {
		return Change{}, err
	}
	if err := validateRegularPath(path, process); err != nil {
		return Change{}, err
	}
	record.Process = filepath.Join(path, process)
	current, exists, err := Read(home)
	if err != nil {
		return Change{}, err
	}
	if !exists {
		return Change{}, os.ErrNotExist
	}
	next := Clone(current)
	record.Version = manifest.Version
	next.Sidecars[id] = record
	if err := validateDependencies(current, next, nil, map[recordKey]recordManifest{{"sidecar", id}: manifest}); err != nil {
		return Change{}, err
	}
	return Write(home, current, true, next, expected)
}

func validateDevelopmentPath(path string) error {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return i18n.Errorf("environment.develop.pathAbsolute", map[string]string{"path": path})
	}
	return nil
}

// manifestEntry applies the spec entry rule (plugin-spec parseManifest) to the
// raw "entry" value of plugin id: absent → "main.js"; null → "" (no entry
// file); a string → trimmed, a relative path inside the directory ending in
// ".js" or ".mjs". A blank string, a leading separator, a drive letter, a ".."
// segment, another suffix, and a non-string are refused with
// environment.develop.entryInvalid.
func manifestEntry(id string, raw json.RawMessage) (string, error) {
	if len(raw) == 0 {
		return "main.js", nil
	}
	if string(raw) == "null" {
		return "", nil
	}
	var entry string
	if json.Unmarshal(raw, &entry) != nil {
		return "", i18n.Errorf("environment.develop.entryInvalid", map[string]string{"id": id, "entry": string(raw)})
	}
	trimmed := strings.TrimSpace(entry)
	invalid := trimmed == "" || strings.HasPrefix(trimmed, "/") || strings.HasPrefix(trimmed, "\\") || driveLetter(trimmed) ||
		!(strings.HasSuffix(trimmed, ".js") || strings.HasSuffix(trimmed, ".mjs"))
	for _, segment := range strings.FieldsFunc(trimmed, func(r rune) bool { return r == '/' || r == '\\' }) {
		invalid = invalid || segment == ".."
	}
	if invalid {
		return "", i18n.Errorf("environment.develop.entryInvalid", map[string]string{"id": id, "entry": entry})
	}
	return trimmed, nil
}

// driveLetter reports whether entry starts with an ASCII letter and a colon.
func driveLetter(entry string) bool {
	if len(entry) < 2 || entry[1] != ':' {
		return false
	}
	letter := entry[0]
	return (letter >= 'a' && letter <= 'z') || (letter >= 'A' && letter <= 'Z')
}
