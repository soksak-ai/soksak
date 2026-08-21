package composition

import (
	contract "github.com/soksak-ai/soksak-contract-composition"
	"github.com/soksak-ai/soksak-core/core/i18n"
)

func SetPluginsEnabled(home string, refs []contract.PluginRef, enabled bool, expected uint64) (contract.Change, error) {
	if len(refs) == 0 {
		return contract.Change{}, i18n.Errorf("composition.enabled.pluginsRequired", nil)
	}
	settings, exists, err := readSettingsFile(home)
	if err != nil {
		return contract.Change{}, err
	}
	if !exists {
		return contract.Change{}, i18n.Errorf("composition.home.required", nil)
	}
	indices := make([]int, 0, len(refs))
	seen := map[contract.PluginRef]bool{}
	for _, ref := range refs {
		if seen[ref] {
			return contract.Change{}, i18n.Errorf("composition.enabled.duplicatePlugin", map[string]string{"plugin": pluginKey(ref)})
		}
		seen[ref] = true
		index := -1
		for candidate, plugin := range settings.Plugins {
			if plugin.PluginRef == ref {
				index = candidate
				break
			}
		}
		if index < 0 {
			return contract.Change{}, i18n.Errorf("composition.enabled.pluginNotFound", map[string]string{"plugin": pluginKey(ref)})
		}
		indices = append(indices, index)
	}
	next, err := nextSettings(settings, true, expected)
	if err != nil {
		return contract.Change{}, err
	}
	for _, index := range indices {
		next.Plugins[index].Enabled = enabled
	}
	return writeSettings(home, settings, next, true, expected)
}
