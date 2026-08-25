package environment

import (
	"github.com/soksak-ai/soksak-core/core/i18n"
)

// recordKey names one record by kind ("plugin" or "sidecar") and id.
type recordKey struct{ kind, id string }

// ValidatePluginDependencies checks every plugin manifest's runtimeDependencies
// {id, version} against the records in value. roots maps a plugin id to a
// directory that replaces the record's Path when reading plugin.json (staged
// artifacts before publish). Every manifest is read once. A registry or local
// plugin manifest must declare the record's id and version
// (install.transaction.pluginManifestInvalid). A broken development record
// (see readRecordManifest) has no manifest and no version: its own
// dependencies are not checked and it is absent for dependents. A write of
// value proceeds when no dependent requires the broken record.
func ValidatePluginDependencies(value Environment, roots map[string]string) error {
	return validateDependencies(value, roots, nil)
}

// validateDependencies is ValidatePluginDependencies with the manifests the
// operation already read in known; those records are not read again.
func validateDependencies(value Environment, roots map[string]string, known map[recordKey]recordManifest) error {
	read := func(kind, id string, record Component) (recordManifest, error) {
		if manifest, found := known[recordKey{kind, id}]; found {
			return manifest, nil
		}
		return readRecordManifest(kind, id, record)
	}
	manifests := map[string]recordManifest{}
	plugins := map[string]string{}
	for id, plugin := range value.Plugins {
		record := plugin.Component
		if staged := roots[id]; staged != "" {
			record.Path = staged
		}
		manifest, err := read("plugin", id, record)
		if err != nil {
			if record.Source == DevelopmentSource {
				continue
			}
			return err
		}
		manifests[id] = manifest
		plugins[id] = manifest.Version
	}
	sidecars := map[string]string{}
	for id, sidecar := range value.Sidecars {
		version := sidecar.Version
		if sidecar.Source == DevelopmentSource {
			manifest, err := read("sidecar", id, sidecar)
			if err != nil {
				continue
			}
			version = manifest.Version
		}
		sidecars[id] = version
	}
	for id, manifest := range manifests {
		dependent := id + "@" + manifest.Version
		for _, dependency := range manifest.RuntimeDependencies.Plugins {
			if err := requireVersion(dependent, "Plugin", dependency.ID, dependency.Version, plugins); err != nil {
				return err
			}
		}
		for _, dependency := range manifest.RuntimeDependencies.Sidecars {
			if err := requireVersion(dependent, "Sidecar", dependency.ID, dependency.Version, sidecars); err != nil {
				return err
			}
		}
	}
	return nil
}

// requireVersion refuses dependent unless selected holds id at exactly required.
func requireVersion(dependent, kind, id, required string, selected map[string]string) error {
	actual, found := selected[id]
	if found && actual == required {
		return nil
	}
	if !found {
		actual = "missing"
	}
	return i18n.Errorf("install.transaction.dependencyVersionConflict", map[string]string{"plugin": dependent, "kind": kind, "dependency": id, "required": required, "requested": actual})
}
