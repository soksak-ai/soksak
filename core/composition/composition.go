// Package composition resolves the exact installation graph declared by settings.json.
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
	Generation  uint64 `json:"generation"`
	Units       int    `json:"units"`
	Active      int    `json:"active"`
	Development int    `json:"development"`
	Resolved    int    `json:"resolved"`
	Disabled    int    `json:"disabled"`
	Rejected    int    `json:"rejected"`
	Issues      int    `json:"issues"`
}

func Load(home string) (Result, error) {
	if !filepath.IsAbs(home) {
		return Result{}, i18n.Errorf("composition.home.absolute", map[string]string{"path": home})
	}
	settingsPath := filepath.Join(home, contract.SettingsFile)
	body, err := os.ReadFile(settingsPath)
	if err != nil {
		return Result{}, fmt.Errorf("read composition settings %s: %w", settingsPath, err)
	}
	settings, err := contract.ParseSettings(body)
	if err != nil {
		return Result{}, err
	}
	manifests := make(map[string]contract.UnitManifest, len(settings.Installations))
	invalid := make(map[string]string)
	for _, installation := range settings.Installations {
		manifest, readErr := readManifest(installation)
		if readErr != nil {
			invalid[installation.UnitRef.Key()] = readErr.Error()
			continue
		}
		manifests[installation.UnitRef.Key()] = manifest
	}
	graph, err := contract.Resolve(settings, manifests)
	if err != nil {
		return Result{}, err
	}
	for index := range graph.Nodes {
		message, rejected := invalid[graph.Nodes[index].UnitRef.Key()]
		if !rejected {
			continue
		}
		graph.Nodes[index].Status = contract.Rejected
		graph.Issues = append(graph.Issues, contract.GraphIssue{
			Unit: graph.Nodes[index].UnitRef, Code: "manifest-unreadable", Message: message,
		})
	}
	return Result{Settings: settings, Graph: graph}, nil
}

func readManifest(installation contract.Installation) (contract.UnitManifest, error) {
	info, err := os.Lstat(installation.InstallPath)
	if err != nil {
		return contract.UnitManifest{}, fmt.Errorf("inspect install path %s: %w", installation.InstallPath, err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return contract.UnitManifest{}, i18n.Errorf("composition.installPath.symlink", map[string]string{"path": installation.InstallPath})
	}
	if !info.IsDir() {
		return contract.UnitManifest{}, i18n.Errorf("composition.installPath.notDirectory", map[string]string{"path": installation.InstallPath})
	}
	path := filepath.Join(installation.InstallPath, installation.Manifest)
	manifestInfo, err := os.Lstat(path)
	if err != nil {
		return contract.UnitManifest{}, fmt.Errorf("inspect unit manifest %s: %w", path, err)
	}
	if !manifestInfo.Mode().IsRegular() {
		return contract.UnitManifest{}, i18n.Errorf("composition.manifest.notRegular", map[string]string{"path": path})
	}
	body, err := os.ReadFile(path)
	if err != nil {
		return contract.UnitManifest{}, fmt.Errorf("read unit manifest %s: %w", path, err)
	}
	manifest, err := contract.ParseUnitManifest(body)
	if err != nil {
		return contract.UnitManifest{}, err
	}
	return manifest, nil
}

func summarize(result Result) Status {
	status := Status{Generation: result.Settings.Generation, Units: len(result.Graph.Nodes), Issues: len(result.Graph.Issues)}
	for _, node := range result.Graph.Nodes {
		if node.Active {
			status.Active++
		}
		if node.Mode == contract.Development {
			status.Development++
		}
		switch node.Status {
		case contract.Resolved:
			status.Resolved++
		case contract.Disabled:
			status.Disabled++
		case contract.Rejected:
			status.Rejected++
		}
	}
	return status
}
