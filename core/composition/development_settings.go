package composition

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"

	contract "github.com/soksak-ai/soksak-contract-composition"
	"github.com/soksak-ai/soksak-core/core/i18n"
)

func SetPluginDevelopment(home string, value contract.Plugin, expected uint64) (contract.Change, error) {
	if err := validateDevelopmentPath(value.InstallPath, value.Manifest); err != nil {
		return contract.Change{}, err
	}
	settings, exists, err := readSettingsFile(home)
	if err != nil {
		return contract.Change{}, err
	}
	next, err := nextSettings(settings, exists, expected)
	if err != nil {
		return contract.Change{}, err
	}
	value.Enabled = pluginEnabled(settings.Plugins, value.PluginRef)
	next.Plugins = replacePlugin(next.Plugins, value)
	sort.Slice(next.Plugins, func(i, j int) bool {
		return pluginKey(next.Plugins[i].PluginRef) < pluginKey(next.Plugins[j].PluginRef)
	})
	return writeSettings(home, settings, next, exists, expected)
}

func SetSidecarDevelopment(home string, value contract.Sidecar, expected uint64) (contract.Change, error) {
	if err := validateDevelopmentPath(value.InstallPath, value.Manifest); err != nil {
		return contract.Change{}, err
	}
	settings, exists, err := readSettingsFile(home)
	if err != nil {
		return contract.Change{}, err
	}
	next, err := nextSettings(settings, exists, expected)
	if err != nil {
		return contract.Change{}, err
	}
	value.Enabled = sidecarEnabled(settings.Sidecars, value.SidecarRef)
	next.Sidecars = replaceSidecar(next.Sidecars, value)
	sort.Slice(next.Sidecars, func(i, j int) bool {
		return sidecarKey(next.Sidecars[i].SidecarRef) < sidecarKey(next.Sidecars[j].SidecarRef)
	})
	return writeSettings(home, settings, next, exists, expected)
}

func SetKitDevelopment(home string, value contract.Kit, expected uint64) (contract.Change, error) {
	if err := validateDevelopmentPath(value.InstallPath, value.Manifest); err != nil {
		return contract.Change{}, err
	}
	settings, exists, err := readSettingsFile(home)
	if err != nil {
		return contract.Change{}, err
	}
	next, err := nextSettings(settings, exists, expected)
	if err != nil {
		return contract.Change{}, err
	}
	value.Enabled = kitEnabled(settings.Kits, value.KitRef)
	next.Kits = replaceKit(next.Kits, value)
	sort.Slice(next.Kits, func(i, j int) bool { return kitKey(next.Kits[i].KitRef) < kitKey(next.Kits[j].KitRef) })
	return writeSettings(home, settings, next, exists, expected)
}

func validateDevelopmentPath(root, manifest string) error {
	if !filepath.IsAbs(root) {
		return i18n.Errorf("composition.development.absolute", nil)
	}
	info, err := os.Lstat(root)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return i18n.Errorf("composition.development.notDirectory", nil)
	}
	info, err = os.Lstat(filepath.Join(root, filepath.FromSlash(manifest)))
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return i18n.Errorf("composition.development.entrypoint", nil)
	}
	return nil
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
func nextSettings(current contract.Settings, exists bool, expected uint64) (contract.Settings, error) {
	if exists && current.Generation != expected {
		return contract.Settings{}, contract.ErrGenerationConflict{Expected: expected, Actual: current.Generation}
	}
	if !exists && expected != 0 {
		return contract.Settings{}, contract.ErrGenerationConflict{Expected: expected, Actual: 0}
	}
	if !exists {
		return contract.Settings{Spec: contract.SettingsSpec, Generation: 1, Plugins: []contract.Plugin{}, Sidecars: []contract.Sidecar{}, Kits: []contract.Kit{}, Bindings: []contract.Binding{}}, nil
	}
	current.Generation++
	return current, nil
}
func writeSettings(home string, current, next contract.Settings, exists bool, expected uint64) (contract.Change, error) {
	var change contract.Change
	var err error
	if exists {
		_, change, err = contract.Replace(current, next, expected)
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
func replacePlugin(values []contract.Plugin, replacement contract.Plugin) []contract.Plugin {
	result := make([]contract.Plugin, 0, len(values)+1)
	for _, value := range values {
		if value.PluginRef != replacement.PluginRef {
			result = append(result, value)
		}
	}
	return append(result, replacement)
}
func replaceSidecar(values []contract.Sidecar, replacement contract.Sidecar) []contract.Sidecar {
	result := make([]contract.Sidecar, 0, len(values)+1)
	for _, value := range values {
		if value.SidecarRef != replacement.SidecarRef {
			result = append(result, value)
		}
	}
	return append(result, replacement)
}
func replaceKit(values []contract.Kit, replacement contract.Kit) []contract.Kit {
	result := make([]contract.Kit, 0, len(values)+1)
	for _, value := range values {
		if value.KitRef != replacement.KitRef {
			result = append(result, value)
		}
	}
	return append(result, replacement)
}
func pluginKey(value contract.PluginRef) string   { return value.ID + "@" + value.Version }
func sidecarKey(value contract.SidecarRef) string { return value.ID + "@" + value.Version }
func kitKey(value contract.KitRef) string         { return value.ID + "@" + value.Version }

func pluginEnabled(values []contract.Plugin, ref contract.PluginRef) bool {
	for _, value := range values {
		if value.PluginRef == ref {
			return value.Enabled
		}
	}
	return false
}

func sidecarEnabled(values []contract.Sidecar, ref contract.SidecarRef) bool {
	for _, value := range values {
		if value.SidecarRef == ref {
			return value.Enabled
		}
	}
	return false
}

func kitEnabled(values []contract.Kit, ref contract.KitRef) bool {
	for _, value := range values {
		if value.KitRef == ref {
			return value.Enabled
		}
	}
	return false
}
