package settings

import (
	"os"
	"path/filepath"
)

type PluginRef struct {
	ID      string `json:"id"`
	Version string `json:"version"`
}
type ManifestRecord struct {
	ID           string  `json:"id"`
	Version      string  `json:"version"`
	InstallPath  string  `json:"installPath"`
	ManifestPath string  `json:"manifestPath"`
	Development  bool    `json:"development"`
	Enabled      bool    `json:"enabled"`
	Manifest     *string `json:"manifest"`
	Error        *string `json:"error"`
}

func SetPluginsEnabled(home string, refs []PluginRef, enabled bool, expected uint64) (Change, error) {
	current, exists, err := Read(home)
	if err != nil {
		return Change{}, err
	}
	if !exists {
		return Change{}, os.ErrNotExist
	}
	next := current
	seen := map[string]bool{}
	for _, ref := range refs {
		if ref.Version != "0.0.1" || seen[ref.ID] {
			return Change{}, os.ErrInvalid
		}
		seen[ref.ID] = true
		value, found := next.Plugins[ref.ID]
		if !found {
			return Change{}, os.ErrNotExist
		}
		value.Enabled = enabled
		next.Plugins[ref.ID] = value
	}
	return Write(home, current, true, next, expected)
}
func SetDevelopment(home, kind, id, path string, enabled bool, expected uint64) (Change, error) {
	if !filepath.IsAbs(path) {
		return Change{}, os.ErrInvalid
	}
	current, exists, err := Read(home)
	if err != nil {
		return Change{}, err
	}
	next := current
	if !exists {
		next = Empty()
	}
	var source *Development
	if enabled {
		source = &Development{Path: path}
	}
	switch kind {
	case "plugin":
		value := next.Plugins[id]
		value.Development = source
		next.Plugins[id] = value
	case "sidecar":
		next.Sidecars[id] = Component{Development: source}
	case "kit":
		next.Kits[id] = Component{Development: source}
	case "contract":
		next.Contracts[id] = Component{Development: source}
	case "spec":
		next.Specs[id] = Component{Development: source}
	default:
		return Change{}, os.ErrInvalid
	}
	return Write(home, current, exists, next, expected)
}
func SetProvider(home, plugin, requirement, sidecar string, expected uint64) (Change, error) {
	current, exists, err := Read(home)
	if err != nil {
		return Change{}, err
	}
	if !exists {
		return Change{}, os.ErrNotExist
	}
	next := current
	value, found := next.Plugins[plugin]
	if !found {
		return Change{}, os.ErrNotExist
	}
	if value.Providers == nil {
		value.Providers = map[string]string{}
	}
	value.Providers[requirement] = sidecar
	next.Plugins[plugin] = value
	return Write(home, current, true, next, expected)
}

func PluginManifests(home string) ([]ManifestRecord, error) {
	preferences, settingsExist, err := Read(home)
	if err != nil {
		return nil, err
	}
	installed, installedExist, err := ReadInstalled(home)
	if err != nil {
		return nil, err
	}
	ids := map[string]bool{}
	if settingsExist {
		for id := range preferences.Plugins {
			ids[id] = true
		}
	}
	if installedExist {
		for id := range installed.Plugins {
			ids[id] = true
		}
	}
	records := []ManifestRecord{}
	for _, id := range sortedKeys(ids) {
		preference := preferences.Plugins[id]
		value, managed := installed.Plugins[id]
		root := value.Path
		development := preference.Development != nil
		if development {
			root = preference.Development.Path
		}
		record := ManifestRecord{ID: id, Version: value.Version, InstallPath: root, ManifestPath: "plugin.json", Development: development, Enabled: preference.Enabled}
		body, readErr := os.ReadFile(filepath.Join(root, "plugin.json"))
		if readErr != nil {
			message := readErr.Error()
			record.Error = &message
		} else {
			manifest := string(body)
			record.Manifest = &manifest
		}
		if !managed && !development {
			record.Error = stringPointer("plugin is not installed and has no development path")
		}
		records = append(records, record)
	}
	return records, nil
}
func stringPointer(value string) *string { return &value }
