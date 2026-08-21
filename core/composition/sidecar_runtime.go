package composition

import (
	"os"
	"path/filepath"
	"strings"

	contract "github.com/soksak-ai/soksak-contract-composition"
	"github.com/soksak-ai/soksak-core/core/i18n"
)

type SidecarRuntime struct {
	ID, Version, InterfaceID, InterfaceVersion, Process string
}

func ResolveBoundSidecar(home string, consumer contract.PluginRef, requirement string) (SidecarRuntime, error) {
	result, err := Load(home)
	if err != nil {
		return SidecarRuntime{}, err
	}
	var provider *contract.SidecarRef
	for _, binding := range result.Settings.Bindings {
		if binding.Consumer.Plugin != nil && *binding.Consumer.Plugin == consumer && binding.Requirement == requirement {
			provider = binding.Provider.Sidecar
			break
		}
	}
	if provider == nil {
		return SidecarRuntime{}, i18n.Errorf("composition.sidecar.bindingMissing", map[string]string{"plugin": consumer.ID + "@" + consumer.Version, "requirement": requirement})
	}
	return resolveInstalledSidecar(result.Settings, *provider)
}

func ResolveInstalledSidecar(home string, provider contract.SidecarRef) (SidecarRuntime, error) {
	result, err := Load(home)
	if err != nil {
		return SidecarRuntime{}, err
	}
	return resolveInstalledSidecar(result.Settings, provider)
}

func resolveInstalledSidecar(settings contract.Settings, provider contract.SidecarRef) (SidecarRuntime, error) {
	var installed *contract.Sidecar
	for index := range settings.Sidecars {
		if settings.Sidecars[index].SidecarRef == provider {
			installed = &settings.Sidecars[index]
			break
		}
	}
	if installed == nil || !installed.Enabled {
		return SidecarRuntime{}, i18n.Errorf("composition.sidecar.unavailable", map[string]string{"sidecar": provider.ID + "@" + provider.Version})
	}
	if installed.Manifest != "sidecar.json" {
		return SidecarRuntime{}, i18n.Errorf("composition.sidecar.manifestName", map[string]string{"sidecar": provider.ID})
	}
	raw, err := os.ReadFile(filepath.Join(installed.InstallPath, installed.Manifest))
	if err != nil {
		return SidecarRuntime{}, err
	}
	manifest, err := contract.ParseSidecarManifest(raw)
	if err != nil {
		return SidecarRuntime{}, i18n.Errorf("composition.sidecar.manifestInvalid", map[string]string{"sidecar": provider.ID, "reason": err.Error()})
	}
	if manifest.ID != provider.ID || manifest.Version != provider.Version {
		return SidecarRuntime{}, i18n.Errorf("composition.sidecar.identityMismatch", map[string]string{"sidecar": provider.ID + "@" + provider.Version})
	}
	if len(manifest.Library) > 0 {
		return SidecarRuntime{}, i18n.Errorf("composition.sidecar.libraryUnsupported", map[string]string{"sidecar": provider.ID})
	}
	process := filepath.Join(installed.InstallPath, filepath.FromSlash(manifest.Process))
	if err := validateRegularPath(installed.InstallPath, manifest.Process); err != nil {
		return SidecarRuntime{}, err
	}
	return SidecarRuntime{ID: manifest.ID, Version: manifest.Version, InterfaceID: manifest.Interface.ID, InterfaceVersion: manifest.Interface.Version, Process: process}, nil
}

func validateRegularPath(root, relative string) error {
	path := root
	for _, component := range strings.Split(filepath.FromSlash(relative), string(filepath.Separator)) {
		path = filepath.Join(path, component)
		info, err := os.Lstat(path)
		if err != nil {
			return i18n.Errorf("composition.sidecar.processUnreadable", map[string]string{"path": path, "reason": err.Error()})
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return i18n.Errorf("composition.sidecar.processSymlink", map[string]string{"path": path})
		}
	}
	info, err := os.Lstat(path)
	if err != nil {
		return i18n.Errorf("composition.sidecar.processUnreadable", map[string]string{"path": path, "reason": err.Error()})
	}
	if !info.Mode().IsRegular() {
		return i18n.Errorf("composition.sidecar.processNotRegular", map[string]string{"path": path})
	}
	return nil
}
