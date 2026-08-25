package environment

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
	Source       string  `json:"source"`
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
		if ref.ID == "" || ref.Version == "" || seen[ref.ID] {
			return Change{}, os.ErrInvalid
		}
		seen[ref.ID] = true
		value, found := next.Plugins[ref.ID]
		if !found || value.Version != ref.Version {
			return Change{}, os.ErrNotExist
		}
		value.Enabled = enabled
		next.Plugins[ref.ID] = value
	}
	return Write(home, current, true, next, expected)
}
func PluginManifests(home string) ([]ManifestRecord, error) {
	environment, exists, err := Read(home)
	if err != nil {
		return nil, err
	}
	if !exists {
		return []ManifestRecord{}, nil
	}
	records := []ManifestRecord{}
	for _, id := range sortedKeys(environment.Plugins) {
		value := environment.Plugins[id]
		root := value.Path
		record := ManifestRecord{ID: id, Version: value.Version, InstallPath: root, ManifestPath: "plugin.json", Source: value.Source, Enabled: value.Enabled}
		body, readErr := os.ReadFile(filepath.Join(root, "plugin.json"))
		if readErr != nil {
			message := readErr.Error()
			record.Error = &message
		} else {
			manifest := string(body)
			record.Manifest = &manifest
		}
		records = append(records, record)
	}
	return records, nil
}
func stringPointer(value string) *string { return &value }
