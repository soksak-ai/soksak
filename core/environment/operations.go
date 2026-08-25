package environment

import (
	"os"
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

// SetPluginsEnabled sets Enabled for every plugin in refs. Each ref must name
// a record at its effective version (os.ErrNotExist otherwise). Enabling a
// broken development record (readRecordManifest) is refused with
// environment.develop.directoryUnavailable; disabling one requires no version.
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
		if !found {
			return Change{}, os.ErrNotExist
		}
		// Enable requires the effective version the caller read; disable only names the record.
		if enabled {
			version, err := recordVersion("plugin", ref.ID, value.Component)
			if err != nil {
				return Change{}, err
			}
			if version != ref.Version {
				return Change{}, os.ErrNotExist
			}
		}
		value.Enabled = enabled
		next.Plugins[ref.ID] = value
	}
	return Write(home, current, true, next, expected)
}

// PluginManifests lists every plugin record with its manifest body. A record
// whose manifest readRecordManifest refuses is listed with the refusal
// sentence in Error and no Manifest.
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
		manifest, readErr := readRecordManifest("plugin", id, value.Component)
		if readErr != nil {
			record.Error = stringPointer(readErr.Error())
		} else {
			record.Manifest = stringPointer(string(manifest.Body))
		}
		records = append(records, record)
	}
	return records, nil
}
func stringPointer(value string) *string { return &value }
