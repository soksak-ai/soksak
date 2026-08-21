package composition

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"

	contract "github.com/soksak-ai/soksak-contract-composition"
	"github.com/soksak-ai/soksak-core/core/i18n"
)

func SetDevelopment(home string, unit contract.UnitRef, root string, enabled bool, expected uint64) (contract.Change, error) {
	if !filepath.IsAbs(home) || !filepath.IsAbs(root) {
		return contract.Change{}, i18n.Errorf("composition.development.absolute", nil)
	}
	info, err := os.Lstat(root)
	if err != nil {
		return contract.Change{}, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return contract.Change{}, i18n.Errorf("composition.development.notDirectory", nil)
	}
	body, err := os.ReadFile(filepath.Join(root, contract.UnitManifestFile))
	if err != nil {
		return contract.Change{}, err
	}
	manifest, err := contract.ParseUnitManifest(body)
	if err != nil {
		return contract.Change{}, err
	}
	if manifest.UnitRef != unit {
		return contract.Change{}, i18n.Errorf("composition.development.identity", nil)
	}
	for _, entrypoint := range manifest.Entrypoints {
		entryInfo, err := os.Lstat(filepath.Join(root, filepath.FromSlash(entrypoint.Path)))
		if err != nil {
			return contract.Change{}, err
		}
		if !entryInfo.Mode().IsRegular() {
			return contract.Change{}, i18n.Errorf("composition.development.entrypoint", nil)
		}
	}
	settings, exists, err := readSettingsFile(home)
	if err != nil {
		return contract.Change{}, err
	}
	if exists && settings.Generation != expected {
		return contract.Change{}, contract.ErrGenerationConflict{Expected: expected, Actual: settings.Generation}
	}
	if !exists && expected != 0 {
		return contract.Change{}, contract.ErrGenerationConflict{Expected: expected, Actual: 0}
	}
	next := settings
	if !exists {
		next = contract.Settings{Spec: contract.SettingsSpec, Generation: 1, Installations: []contract.Installation{}, Plugins: []contract.PluginSelection{}, Bindings: []contract.Binding{}}
	} else {
		next.Generation++
	}
	next.Installations = replaceDevelopmentInstallation(next.Installations, contract.Installation{UnitRef: unit, Mode: contract.Development, InstallPath: root, Manifest: contract.UnitManifestFile, Source: contract.Source{Type: contract.PathSource, Path: root}})
	if unit.Kind == contract.Plugin {
		next.Plugins = replaceDevelopmentPlugin(next.Plugins, contract.PluginSelection{Plugin: unit, Enabled: enabled})
	}
	sort.Slice(next.Installations, func(i, j int) bool { return next.Installations[i].UnitRef.Key() < next.Installations[j].UnitRef.Key() })
	sort.Slice(next.Plugins, func(i, j int) bool { return next.Plugins[i].Plugin.Key() < next.Plugins[j].Plugin.Key() })
	var change contract.Change
	if exists {
		_, change, err = contract.Replace(settings, next, expected)
	} else {
		_, change, err = contract.Initialize(next)
	}
	if err != nil {
		return contract.Change{}, err
	}
	encoded, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return contract.Change{}, err
	}
	if err := os.MkdirAll(home, 0o700); err != nil {
		return contract.Change{}, err
	}
	temporary := filepath.Join(home, contract.SettingsFile) + ".next"
	if err := os.WriteFile(temporary, append(encoded, byte(10)), 0o600); err != nil {
		return contract.Change{}, err
	}
	if err := os.Rename(temporary, filepath.Join(home, contract.SettingsFile)); err != nil {
		return contract.Change{}, err
	}
	return change, nil
}

func readSettingsFile(home string) (contract.Settings, bool, error) {
	body, err := os.ReadFile(filepath.Join(home, contract.SettingsFile))
	if os.IsNotExist(err) {
		return contract.Settings{}, false, nil
	}
	if err != nil {
		return contract.Settings{}, false, err
	}
	settings, err := contract.ParseSettings(body)
	return settings, err == nil, err
}
func replaceDevelopmentInstallation(values []contract.Installation, replacement contract.Installation) []contract.Installation {
	result := make([]contract.Installation, 0, len(values)+1)
	for _, value := range values {
		if value.UnitRef != replacement.UnitRef {
			result = append(result, value)
		}
	}
	return append(result, replacement)
}
func replaceDevelopmentPlugin(values []contract.PluginSelection, replacement contract.PluginSelection) []contract.PluginSelection {
	result := make([]contract.PluginSelection, 0, len(values)+1)
	for _, value := range values {
		if value.Plugin != replacement.Plugin {
			result = append(result, value)
		}
	}
	return append(result, replacement)
}
