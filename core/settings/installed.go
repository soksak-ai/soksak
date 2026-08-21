package settings

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
)

const InstalledFile = "installed.json"

type InstalledComponent struct {
	Version        string `json:"version"`
	Path           string `json:"path"`
	RegistryID     string `json:"registryId"`
	Repository     string `json:"repository"`
	SourceCommit   string `json:"sourceCommit"`
	ManifestSHA256 string `json:"manifestSha256"`
	ArtifactSHA256 string `json:"artifactSha256"`
	Target         string `json:"target,omitempty"`
}
type Installed struct {
	Revision  uint64                        `json:"revision"`
	Plugins   map[string]InstalledComponent `json:"plugins"`
	Sidecars  map[string]InstalledComponent `json:"sidecars"`
	Kits      map[string]InstalledComponent `json:"kits"`
	Contracts map[string]InstalledComponent `json:"contracts"`
	Specs     map[string]InstalledComponent `json:"specs"`
}

func ParseInstalled(body []byte) (Installed, error) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var value Installed
	if err := decoder.Decode(&value); err != nil {
		return Installed{}, err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return Installed{}, fmt.Errorf("installed state has trailing data")
	}
	if err := ValidateInstalled(value); err != nil {
		return Installed{}, err
	}
	return value, nil
}

func ValidateInstalled(value Installed) error {
	if value.Revision < 1 || value.Plugins == nil || value.Sidecars == nil || value.Kits == nil || value.Contracts == nil || value.Specs == nil {
		return fmt.Errorf("installed state requires revision and all component maps")
	}
	for kind, values := range map[string]map[string]InstalledComponent{"plugin": value.Plugins, "sidecar": value.Sidecars, "kit": value.Kits, "contract": value.Contracts, "spec": value.Specs} {
		for id, item := range values {
			if !idPattern.MatchString(id) || item.Version != "0.0.1" || !filepath.IsAbs(item.Path) || item.RegistryID == "" || item.Repository == "" || len(item.SourceCommit) != 40 || len(item.ManifestSHA256) != 64 || len(item.ArtifactSHA256) != 64 {
				return fmt.Errorf("invalid installed %s %s", kind, id)
			}
			if kind == "sidecar" && item.Target == "" {
				return fmt.Errorf("installed sidecar target required")
			}
		}
	}
	return nil
}

func EmptyInstalled() Installed {
	return Installed{Revision: 1, Plugins: map[string]InstalledComponent{}, Sidecars: map[string]InstalledComponent{}, Kits: map[string]InstalledComponent{}, Contracts: map[string]InstalledComponent{}, Specs: map[string]InstalledComponent{}}
}
