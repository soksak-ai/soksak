// Package composition resolves plugins, sidecars and kits declared by settings.json.
package composition

import (
	"fmt"
	"os"
	"path/filepath"

	contract "github.com/soksak-ai/soksak-contract-composition"
	"github.com/soksak-ai/soksak-core/core/i18n"
)

type Result struct {
	Settings contract.Settings `json:"settings"`
	Graph    contract.Graph    `json:"graph"`
}
type Status struct {
	Generation          uint64 `json:"generation"`
	Plugins             int    `json:"plugins"`
	Sidecars            int    `json:"sidecars"`
	Kits                int    `json:"kits"`
	DevelopmentPlugins  int    `json:"developmentPlugins"`
	DevelopmentSidecars int    `json:"developmentSidecars"`
	DevelopmentKits     int    `json:"developmentKits"`
	RejectedPlugins     int    `json:"rejectedPlugins"`
	RejectedSidecars    int    `json:"rejectedSidecars"`
	RejectedKits        int    `json:"rejectedKits"`
}

func Load(home string) (Result, error) {
	if !filepath.IsAbs(home) {
		return Result{}, i18n.Errorf("composition.home.absolute", map[string]string{"path": home})
	}
	path := filepath.Join(home, contract.SettingsFile)
	body, err := os.ReadFile(path)
	if err != nil {
		return Result{}, fmt.Errorf("read composition settings %s: %w", path, err)
	}
	settings, err := contract.ParseSettings(body)
	if err != nil {
		return Result{}, err
	}
	graph, err := contract.Resolve(settings)
	if err != nil {
		return Result{}, err
	}
	for index, value := range settings.Plugins {
		if issue := validateInstallation(value.InstallPath, value.Manifest); issue != "" {
			graph.Plugins[index].Status = contract.Rejected
			graph.Plugins[index].Issues = append(graph.Plugins[index].Issues, issue)
		}
	}
	for index, value := range settings.Sidecars {
		if issue := validateInstallation(value.InstallPath, value.Manifest); issue != "" {
			graph.Sidecars[index].Status = contract.Rejected
			graph.Sidecars[index].Issues = append(graph.Sidecars[index].Issues, issue)
		}
	}
	for index, value := range settings.Kits {
		if issue := validateInstallation(value.InstallPath, value.Manifest); issue != "" {
			graph.Kits[index].Status = contract.Rejected
			graph.Kits[index].Issues = append(graph.Kits[index].Issues, issue)
		}
	}
	return Result{Settings: settings, Graph: graph}, nil
}

func PluginAssetRoots(home string) ([]string, error) {
	result, err := Load(home)
	if err != nil {
		return nil, err
	}
	roots := make([]string, 0, len(result.Graph.Plugins))
	for _, plugin := range result.Graph.Plugins {
		if plugin.Status == contract.Resolved {
			roots = append(roots, plugin.Plugin.InstallPath)
		}
	}
	return roots, nil
}

func validateInstallation(root, manifest string) string {
	info, err := os.Lstat(root)
	if err != nil {
		return err.Error()
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return "install path is a symbolic link"
	}
	if !info.IsDir() {
		return "install path is not a directory"
	}
	info, err = os.Lstat(filepath.Join(root, filepath.FromSlash(manifest)))
	if err != nil {
		return err.Error()
	}
	if !info.Mode().IsRegular() {
		return "manifest is not a regular file"
	}
	return ""
}

func summarize(result Result) Status {
	status := Status{Generation: result.Settings.Generation, Plugins: len(result.Graph.Plugins), Sidecars: len(result.Graph.Sidecars), Kits: len(result.Graph.Kits)}
	for _, value := range result.Graph.Plugins {
		if value.Plugin.Development {
			status.DevelopmentPlugins++
		}
		if value.Status == contract.Rejected {
			status.RejectedPlugins++
		}
	}
	for _, value := range result.Graph.Sidecars {
		if value.Sidecar.Development {
			status.DevelopmentSidecars++
		}
		if value.Status == contract.Rejected {
			status.RejectedSidecars++
		}
	}
	for _, value := range result.Graph.Kits {
		if value.Kit.Development {
			status.DevelopmentKits++
		}
		if value.Status == contract.Rejected {
			status.RejectedKits++
		}
	}
	return status
}
