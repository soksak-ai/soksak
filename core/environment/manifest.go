package environment

import (
	"fmt"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/soksak-ai/soksak-core/core/i18n"
	platformspec "github.com/soksak-ai/soksak-spec/go/platformspec"
)

// recordManifest is one parse of a record's manifest file. Body is the file
// as read; ID and Version are set for both kinds; Entry and RuntimeDependencies
// for a plugin; Interfaces and Process for a sidecar.
type recordManifest struct {
	Body    []byte
	ID      string
	Version string
	// Entry keeps the raw JSON of a plugin's "entry": absent, null, and a
	// string are three distinct cases.
	Entry               json.RawMessage
	RuntimeDependencies runtimeDependencies
	Interfaces          []platformspec.Reference
	Process             string
}

type runtimeDependencies struct {
	Plugins  []PluginRef `json:"plugins"`
	Sidecars []PluginRef `json:"sidecars"`
}

// pluginManifest is the decode target for plugin.json.
type pluginManifest struct {
	ID                  string              `json:"id"`
	Version             string              `json:"version"`
	Entry               json.RawMessage     `json:"entry"`
	RuntimeDependencies runtimeDependencies `json:"runtimeDependencies"`
}

// manifestName returns the manifest file name for kind ("plugin" or "sidecar").
func manifestName(kind string) string {
	return kind + ".json"
}

// parseManifest reads <root>/<kind>.json and parses it with the kind's parser,
// once. The error is the file or parser error as it stands.
func parseManifest(kind, root string) (recordManifest, error) {
	body, err := os.ReadFile(filepath.Join(root, manifestName(kind)))
	if err != nil {
		return recordManifest{}, err
	}
	if kind == "sidecar" {
		manifest, err := platformspec.ParseSidecarManifest(body)
		if err != nil {
			return recordManifest{}, fmt.Errorf("%s: %w", filepath.Join(root, manifestName(kind)), err)
		}
		return recordManifest{Body: body, ID: manifest.ID, Version: manifest.Version, Interfaces: manifest.Interfaces, Process: manifest.Process}, nil
	}
	var manifest pluginManifest
	if err := json.Unmarshal(body, &manifest); err != nil {
		return recordManifest{}, fmt.Errorf("%s: %w", filepath.Join(root, manifestName(kind)), err)
	}
	return recordManifest{Body: body, ID: manifest.ID, Version: manifest.Version, Entry: manifest.Entry, RuntimeDependencies: manifest.RuntimeDependencies}, nil
}

// readRecordManifest reads and parses the manifest of record exactly once;
// kind ("plugin" or "sidecar") selects the file and the parser. Every manifest
// field an operation uses, the effective version included, comes from this one
// parse; no site parses the file a second time or compares record.Version of a
// development record.
//
// A development manifest that cannot be read or parsed, or that declares
// another id, makes the record broken: the error is
// environment.develop.directoryUnavailable with the file name and the reason
// in {error}; no file error is wrapped into it. A registry or local manifest
// is immutable and must declare the record's id and version: a plugin manifest
// that does not is install.transaction.pluginManifestInvalid; a sidecar
// manifest that does not is os.ErrInvalid.
func readRecordManifest(kind, id string, record Component) (recordManifest, error) {
	name := manifestName(kind)
	manifest, err := parseManifest(kind, record.Path)
	reason := ""
	switch {
	case err != nil:
		reason = name + ": " + err.Error()
	case manifest.ID != id:
		reason = name + " declares id " + manifest.ID
	}
	if record.Source != DevelopmentSource {
		if reason != "" || manifest.Version != record.Version {
			if kind == "plugin" {
				return recordManifest{}, i18n.Errorf("install.transaction.pluginManifestInvalid", map[string]string{"plugin": id})
			}
			return recordManifest{}, os.ErrInvalid
		}
		return manifest, nil
	}
	if reason != "" {
		return recordManifest{}, i18n.Errorf("environment.develop.directoryUnavailable", map[string]string{"kind": kind, "id": id, "path": record.Path, "error": reason})
	}
	if kind == "sidecar" {
		staged, stagedErr := parseManifest("sidecar", filepath.Join(record.Path, "dist"))
		expectedProcess := manifest.Process
		if strings.HasSuffix(record.Target, "windows-msvc") && !strings.HasSuffix(expectedProcess, ".exe") {
			expectedProcess += ".exe"
		}
		if stagedErr != nil || staged.ID != manifest.ID || staged.Version != manifest.Version ||
			!slices.Equal(staged.Interfaces, manifest.Interfaces) || staged.Process != expectedProcess {
			detail := "dist/sidecar.json does not match sidecar.json"
			if stagedErr != nil {
				detail = "dist/sidecar.json: " + stagedErr.Error()
			}
			return recordManifest{}, i18n.Errorf("environment.develop.sidecarArtifactStale", map[string]string{
				"id": id, "path": record.Path, "error": detail,
			})
		}
		manifest.Process = staged.Process
	}
	return manifest, nil
}

// recordVersion returns the version record satisfies now for an operation that
// needs no other manifest field: record.Version for a registry or local record
// (immutable, not read), the manifest version read now for a development
// record. A broken development record has no version; the error is the one of
// readRecordManifest.
func recordVersion(kind, id string, record Component) (string, error) {
	if record.Source != DevelopmentSource {
		return record.Version, nil
	}
	manifest, err := readRecordManifest(kind, id, record)
	if err != nil {
		return "", err
	}
	return manifest.Version, nil
}
