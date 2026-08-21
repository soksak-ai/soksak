package composition

import (
	"os"
	"path/filepath"
)

type PluginManifestRecord struct {
	ID           string  `json:"id"`
	Version      string  `json:"version"`
	InstallPath  string  `json:"installPath"`
	ManifestPath string  `json:"manifestPath"`
	Development  bool    `json:"development"`
	Enabled      bool    `json:"enabled"`
	Manifest     *string `json:"manifest"`
	Error        *string `json:"error"`
}

func PluginManifests(home string) ([]PluginManifestRecord, error) {
	result, err := Load(home)
	if err != nil {
		return nil, err
	}
	records := make([]PluginManifestRecord, 0, len(result.Settings.Plugins))
	for _, plugin := range result.Settings.Plugins {
		record := PluginManifestRecord{
			ID: plugin.ID, Version: plugin.Version, InstallPath: plugin.InstallPath, ManifestPath: plugin.Manifest,
			Development: plugin.Development, Enabled: plugin.Enabled,
		}
		body, readErr := os.ReadFile(filepath.Join(plugin.InstallPath, filepath.FromSlash(plugin.Manifest)))
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
