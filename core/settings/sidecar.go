package settings

import (
	"os"
	"path/filepath"
	"strings"

	platformspec "github.com/soksak-ai/soksak-spec/go/platformspec"
)

type SidecarRuntime struct {
	ID               string
	Version          string
	InterfaceID      string
	InterfaceVersion string
	Process          string
}

func ResolveBoundSidecar(home string, consumer PluginRef, requirement string) (SidecarRuntime, error) {
	preferences, exists, err := Read(home)
	if err != nil {
		return SidecarRuntime{}, err
	}
	if !exists {
		return SidecarRuntime{}, os.ErrNotExist
	}
	plugin, found := preferences.Plugins[consumer.ID]
	if !found {
		return SidecarRuntime{}, os.ErrNotExist
	}
	provider, found := plugin.Providers[requirement]
	if !found {
		return SidecarRuntime{}, os.ErrNotExist
	}
	return ResolveInstalledSidecar(home, provider)
}
func ResolveInstalledSidecar(home, id string) (SidecarRuntime, error) {
	preferences, _, err := Read(home)
	if err != nil {
		return SidecarRuntime{}, err
	}
	installed, exists, err := ReadInstalled(home)
	if err != nil {
		return SidecarRuntime{}, err
	}
	if !exists {
		return SidecarRuntime{}, os.ErrNotExist
	}
	value, found := installed.Sidecars[id]
	if !found {
		return SidecarRuntime{}, os.ErrNotExist
	}
	root := value.Path
	if preference, ok := preferences.Sidecars[id]; ok && preference.Development != nil {
		root = preference.Development.Path
	}
	body, err := os.ReadFile(filepath.Join(root, "sidecar.json"))
	if err != nil {
		return SidecarRuntime{}, err
	}
	manifest, err := platformspec.ParseSidecarManifest(body)
	if err != nil {
		return SidecarRuntime{}, err
	}
	if manifest.ID != id || manifest.Version != value.Version {
		return SidecarRuntime{}, os.ErrInvalid
	}
	process := filepath.Join(root, filepath.FromSlash(manifest.Process))
	if err := validateRegularPath(root, manifest.Process); err != nil {
		return SidecarRuntime{}, err
	}
	return SidecarRuntime{ID: id, Version: value.Version, InterfaceID: manifest.Interface.ID, InterfaceVersion: manifest.Interface.Version, Process: process}, nil
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
