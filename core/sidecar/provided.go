package sidecar

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/soksak/soksak-core/core/i18n"
)

// What an installed unit states it implements, read from the release manifest beside its binary.
//
// This is the "actual" half of declared-equals-actual. The declared half arrives with the request,
// from the manifest of the plugin that asked, and neither is taken on the other's word.
//
// It is read from disk on every open rather than cached. The answer is about what is installed now,
// and an install that replaced a unit between two opens is exactly the case a cache would answer
// wrongly — with the version that was there when the application started.
func ProvidedFromRelease(home string) func(unit string) (Provided, error) {
	return func(unit string) (Provided, error) {
		name := "soksak-sidecar-" + unit
		path := filepath.Join(home, "sidecars", name, "release", "unit.json")
		raw, err := os.ReadFile(path)
		if err != nil {
			return Provided{}, i18n.Errorf("sidecar.noRelease", map[string]string{
				"name": unit, "path": path,
			})
		}
		var release struct {
			ID        string `json:"id"`
			Interface struct {
				ID      string `json:"id"`
				Version string `json:"version"`
			} `json:"interface"`
		}
		if err := json.Unmarshal(raw, &release); err != nil {
			return Provided{}, i18n.Errorf("sidecar.releaseUnreadable", map[string]string{
				"name": unit, "path": path, "reason": err.Error(),
			})
		}
		if release.Interface.ID == "" || release.Interface.Version == "" {
			return Provided{}, i18n.Errorf("sidecar.releaseDeclaresNoInterface", map[string]string{
				"name": unit, "path": path,
			})
		}
		// The release names itself, and a release under one unit's directory naming another is an
		// install that put the wrong thing there. Opening it would run a unit nobody asked for.
		if release.ID != name {
			return Provided{}, i18n.Errorf("sidecar.releaseNamesAnotherUnit", map[string]string{
				"name": name, "found": release.ID, "path": path,
			})
		}
		return Provided{ID: release.Interface.ID, Version: release.Interface.Version}, nil
	}
}
