package environment

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/soksak-ai/soksak-core/core/i18n"
	platformspec "github.com/soksak-ai/soksak-spec/go/platformspec"
)

type SidecarRuntime struct {
	ID         string
	Version    string
	Interfaces []platformspec.Reference
	Process    string
}

// ResolveSelectedSidecar resolves the installed sidecar selected by environment.json.
func ResolveSelectedSidecar(home, id string) (SidecarRuntime, error) {
	environment, exists, err := Read(home)
	if err != nil {
		return SidecarRuntime{}, err
	}
	if !exists {
		return SidecarRuntime{}, i18n.Errorf("environment.sidecar.noInstallationRecord", map[string]string{"id": id})
	}
	value, found := environment.Sidecars[id]
	if !found {
		return SidecarRuntime{}, i18n.Errorf("environment.sidecar.noInstallationRecord", map[string]string{"id": id})
	}
	return resolveSidecarRecord(id, value, value.Version)
}

// ResolveSidecarForPlugin resolves sidecar for consumer. consumer must name an
// installed plugin at its effective version; otherwise os.ErrNotExist. A broken
// development consumer is refused with environment.develop.directoryUnavailable.
func ResolveSidecarForPlugin(home string, consumer PluginRef, sidecar PluginRef) (SidecarRuntime, error) {
	environment, exists, err := Read(home)
	if err != nil {
		return SidecarRuntime{}, err
	}
	if !exists {
		return SidecarRuntime{}, os.ErrNotExist
	}
	plugin, found := environment.Plugins[consumer.ID]
	if !found {
		return SidecarRuntime{}, os.ErrNotExist
	}
	version, err := recordVersion("plugin", consumer.ID, plugin.Component)
	if err != nil {
		return SidecarRuntime{}, err
	}
	if version != consumer.Version {
		return SidecarRuntime{}, os.ErrNotExist
	}
	return ResolveSidecarVersion(home, sidecar.ID, sidecar.Version)
}

// ResolveSidecarVersion resolves sidecar id at exactly version, the record's
// effective version, from one read of sidecar.json. A broken development
// record is refused with environment.develop.directoryUnavailable; an
// installed manifest that does not confirm the record is os.ErrInvalid.
func ResolveSidecarVersion(home, id, version string) (SidecarRuntime, error) {
	environment, exists, err := Read(home)
	if err != nil {
		return SidecarRuntime{}, err
	}
	if !exists {
		return SidecarRuntime{}, os.ErrNotExist
	}
	value, found := environment.Sidecars[id]
	if !found {
		return SidecarRuntime{}, os.ErrNotExist
	}
	return resolveSidecarRecord(id, value, version)
}

func resolveSidecarRecord(id string, value Component, version string) (SidecarRuntime, error) {
	manifest, err := readRecordManifest("sidecar", id, value)
	if err != nil {
		return SidecarRuntime{}, err
	}
	if manifest.Version != version {
		return SidecarRuntime{}, os.ErrNotExist
	}
	root := value.Path
	if err := validateRegularPath(root, manifest.Process); err != nil {
		return SidecarRuntime{}, err
	}
	process := filepath.Join(root, filepath.FromSlash(manifest.Process))
	return SidecarRuntime{ID: id, Version: version, Interfaces: manifest.Interfaces, Process: process}, nil
}
func validateRegularPath(root, relative string) error {
	path := root
	for _, component := range strings.Split(filepath.FromSlash(relative), string(filepath.Separator)) {
		path = filepath.Join(path, component)
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return os.ErrInvalid
		}
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return os.ErrInvalid
	}
	return nil
}
