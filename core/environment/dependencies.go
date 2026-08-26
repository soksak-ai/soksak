package environment

import (
	"sort"

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
	return validateDependencies(Empty(), value, roots, nil)
}

// ValidateDependencyTransition refuses a write from before to after only for a
// dependency conflict the write introduces. A conflict that before already
// holds (a development manifest edited on disk after its record was written)
// is reported by the runtime as plugin status and does not block an unrelated
// change; the write that removes the conflicting record or installs the
// required version is the way out.
func ValidateDependencyTransition(before, after Environment, roots map[string]string) error {
	return validateDependencies(before, after, roots, nil)
}

// dependencyConflict names one unmet requirement of one dependent.
type dependencyConflict struct{ dependent, kind, id, required, actual string }

func (conflict dependencyConflict) key() string {
	return conflict.dependent + "\x00" + conflict.kind + "\x00" + conflict.id + "\x00" + conflict.required
}

// validateDependencies is ValidateDependencyTransition with the manifests the
// operation already read in known; those records are not read again. A
// conflict of before is computed without the read errors that gate after: a
// record before cannot read holds no requirement.
func validateDependencies(before, after Environment, roots map[string]string, known map[recordKey]recordManifest) error {
	existing := map[string]bool{}
	for _, conflict := range dependencyConflicts(before, nil, known, true) {
		existing[conflict.key()] = true
	}
	conflicts, err := dependencyConflictsStrict(after, roots, known)
	if err != nil {
		return err
	}
	for _, conflict := range conflicts {
		if existing[conflict.key()] {
			continue
		}
		return i18n.Errorf("install.transaction.dependencyVersionConflict", map[string]string{"plugin": conflict.dependent, "kind": conflict.kind, "dependency": conflict.id, "required": conflict.required, "requested": conflict.actual})
	}
	return nil
}

// dependencyConflicts is dependencyConflictsStrict with every read error skipped.
func dependencyConflicts(value Environment, roots map[string]string, known map[recordKey]recordManifest, lenient bool) []dependencyConflict {
	conflicts, _ := collectDependencyConflicts(value, roots, known, lenient)
	return conflicts
}

func dependencyConflictsStrict(value Environment, roots map[string]string, known map[recordKey]recordManifest) ([]dependencyConflict, error) {
	return collectDependencyConflicts(value, roots, known, false)
}

func collectDependencyConflicts(value Environment, roots map[string]string, known map[recordKey]recordManifest, lenient bool) ([]dependencyConflict, error) {
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
			if record.Source == DevelopmentSource || lenient {
				continue
			}
			return nil, err
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
	ids := make([]string, 0, len(manifests))
	for id := range manifests {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	var conflicts []dependencyConflict
	for _, id := range ids {
		manifest := manifests[id]
		dependent := id + "@" + manifest.Version
		for _, dependency := range manifest.RuntimeDependencies.Plugins {
			if conflict, unmet := requireVersion(dependent, "Plugin", dependency.ID, dependency.Version, plugins); unmet {
				conflicts = append(conflicts, conflict)
			}
		}
		for _, dependency := range manifest.RuntimeDependencies.Sidecars {
			if conflict, unmet := requireVersion(dependent, "Sidecar", dependency.ID, dependency.Version, sidecars); unmet {
				conflicts = append(conflicts, conflict)
			}
		}
	}
	return conflicts, nil
}

// requireVersion reports the conflict of dependent unless selected holds id at exactly required.
func requireVersion(dependent, kind, id, required string, selected map[string]string) (dependencyConflict, bool) {
	actual, found := selected[id]
	if found && actual == required {
		return dependencyConflict{}, false
	}
	if !found {
		actual = "missing"
	}
	return dependencyConflict{dependent: dependent, kind: kind, id: id, required: required, actual: actual}, true
}
