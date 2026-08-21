package install

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	composition "github.com/soksak-ai/soksak-contract-composition"
)

func unitArchive(t *testing.T, unit composition.UnitRef, entrypoint string) []byte {
	t.Helper()
	manifest := composition.UnitManifest{
		Spec: composition.UnitSpec, UnitRef: unit,
		Dependencies: []composition.UnitRef{}, Implements: []composition.ContractRef{}, Consumes: []composition.Requirement{},
		Entrypoints: []composition.Entrypoint{{Role: map[composition.UnitKind]string{composition.Plugin: "plugin", composition.Kit: "package", composition.Sidecar: "process"}[unit.Kind], Name: func() string {
			if unit.Kind == composition.Sidecar {
				return unit.ID
			}
			return ""
		}(), Path: entrypoint}},
	}
	body, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	return tgz(t, archiveEntry{name: composition.UnitManifestFile, body: string(body)}, archiveEntry{name: entrypoint, body: "artifact"})
}

func manifestArchive(t *testing.T, manifest composition.UnitManifest, entrypoint string) []byte {
	t.Helper()
	body, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	return tgz(t, archiveEntry{name: composition.UnitManifestFile, body: string(body)}, archiveEntry{name: entrypoint, body: "artifact"})
}

func stageUnit(t *testing.T, manager *TransactionManager, transaction Transaction, unit composition.UnitRef, archive []byte, entrypoint string) StagedArtifact {
	t.Helper()
	manager.fetcher = memoryFetcher{body: archive}
	staged, err := manager.Stage(context.Background(), StageRequest{
		TransactionID: transaction.TransactionID, RegistryID: "official",
		Unit:     UnitIdentity{Kind: string(unit.Kind), ID: unit.ID, Version: unit.Version},
		Artifact: Artifact{URL: "https://example.invalid/" + unit.ID + ".tgz", SHA256: sha256Hex(archive), Format: "tgz", Entrypoints: []string{composition.UnitManifestFile, entrypoint}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return staged
}

func TestCommitPublishesClosureAndInitialSettings(t *testing.T) {
	home := t.TempDir()
	manager := NewTransactionManager(filepath.Join(home, ".transactions"), memoryFetcher{})
	plugin := composition.UnitRef{Kind: composition.Plugin, ID: "view", Version: "0.0.1"}
	kit := composition.UnitRef{Kind: composition.Kit, ID: "runtime", Version: "0.0.1"}
	transaction, err := manager.Begin("official", identityOf(plugin))
	if err != nil {
		t.Fatal(err)
	}
	pluginStage := stageUnit(t, manager, transaction, plugin, unitArchive(t, plugin, "plugin.json"), "plugin.json")
	kitStage := stageUnit(t, manager, transaction, kit, unitArchive(t, kit, "package.json"), "package.json")
	result, err := manager.Commit(CommitRequest{
		TransactionID: transaction.TransactionID, ExpectedGeneration: 0,
		Units: []VerifiedUnit{
			verified(plugin, pluginStage, "https://github.com/example/view", "https://example.invalid/view.tgz"),
			verified(kit, kitStage, "https://github.com/example/runtime", "https://example.invalid/runtime.tgz"),
		},
		Bindings: []composition.Binding{}, Home: home,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Generation != 1 {
		t.Fatalf("generation = %d", result.Generation)
	}
	body, err := os.ReadFile(filepath.Join(home, composition.SettingsFile))
	if err != nil {
		t.Fatal(err)
	}
	settings, err := composition.ParseSettings(body)
	if err != nil {
		t.Fatal(err)
	}
	if len(settings.Installations) != 2 || len(settings.Plugins) != 1 || !settings.Plugins[0].Enabled {
		t.Fatalf("settings = %+v", settings)
	}
	for _, installation := range settings.Installations {
		if !filepath.IsAbs(installation.InstallPath) {
			t.Errorf("relative install path: %s", installation.InstallPath)
		}
		if installation.Source.Repository == "" || installation.Source.Commit == "" || installation.Source.URL == "" || installation.Source.SHA256 == "" {
			t.Errorf("incomplete source: %+v", installation.Source)
		}
		if _, err := os.Stat(filepath.Join(installation.InstallPath, installation.Manifest)); err != nil {
			t.Errorf("manifest missing: %v", err)
		}
	}
	if _, err := os.Stat(filepath.Join(manager.root, transaction.TransactionID)); !os.IsNotExist(err) {
		t.Errorf("transaction remains: %v", err)
	}
}

func TestCommitRejectsGenerationConflictWithoutChangingFiles(t *testing.T) {
	home := t.TempDir()
	manager := NewTransactionManager(filepath.Join(home, ".transactions"), memoryFetcher{})
	existing := composition.Settings{Spec: composition.SettingsSpec, Generation: 2, Installations: []composition.Installation{}, Plugins: []composition.PluginSelection{}, Bindings: []composition.Binding{}}
	writeJSONFile(t, filepath.Join(home, composition.SettingsFile), existing)
	plugin := composition.UnitRef{Kind: composition.Plugin, ID: "view", Version: "0.0.1"}
	transaction, _ := manager.Begin("official", identityOf(plugin))
	staged := stageUnit(t, manager, transaction, plugin, unitArchive(t, plugin, "plugin.json"), "plugin.json")
	_, err := manager.Commit(CommitRequest{TransactionID: transaction.TransactionID, ExpectedGeneration: 1, Units: []VerifiedUnit{verified(plugin, staged, "https://github.com/example/view", "https://example.invalid/view.tgz")}, Home: home})
	if err == nil {
		t.Fatal("stale generation was accepted")
	}
	body, readErr := os.ReadFile(filepath.Join(home, composition.SettingsFile))
	if readErr != nil {
		t.Fatal(readErr)
	}
	settings, parseErr := composition.ParseSettings(body)
	if parseErr != nil || settings.Generation != 2 {
		t.Fatalf("settings changed: %+v %v", settings, parseErr)
	}
	if _, statErr := os.Stat(filepath.Join(home, "installed", "plugin", "view", "0.0.1")); !os.IsNotExist(statErr) {
		t.Fatalf("unit was published: %v", statErr)
	}
}

func TestCommitRejectsMissingAndMismatchedBindings(t *testing.T) {
	home := t.TempDir()
	manager := NewTransactionManager(filepath.Join(home, ".transactions"), memoryFetcher{})
	plugin := composition.UnitRef{Kind: composition.Plugin, ID: "view", Version: "0.0.1"}
	provider := composition.UnitRef{Kind: composition.Sidecar, ID: "state", Version: "0.0.1"}
	wanted := composition.ContractRef{ID: "soksak-spec-sidecar-terminal", Version: "0.0.1"}
	pluginManifest := composition.UnitManifest{Spec: composition.UnitSpec, UnitRef: plugin, Dependencies: []composition.UnitRef{}, Implements: []composition.ContractRef{}, Consumes: []composition.Requirement{{Name: "state", Contract: wanted}}, Entrypoints: []composition.Entrypoint{{Role: "plugin", Path: "plugin.json"}}}
	providerManifest := composition.UnitManifest{Spec: composition.UnitSpec, UnitRef: provider, Dependencies: []composition.UnitRef{}, Implements: []composition.ContractRef{{ID: "soksak-spec-sidecar-other", Version: "0.0.1"}}, Consumes: []composition.Requirement{}, Entrypoints: []composition.Entrypoint{{Role: "process", Name: "state", Path: "bin/state"}}}
	transaction, _ := manager.Begin("official", identityOf(plugin))
	pluginStage := stageUnit(t, manager, transaction, plugin, manifestArchive(t, pluginManifest, "plugin.json"), "plugin.json")
	providerStage := stageUnit(t, manager, transaction, provider, manifestArchive(t, providerManifest, "bin/state"), "bin/state")
	units := []VerifiedUnit{verified(plugin, pluginStage, "https://github.com/example/view", "https://example.invalid/view.tgz"), verified(provider, providerStage, "https://github.com/example/state", "https://example.invalid/state.tgz")}
	if _, err := manager.Commit(CommitRequest{TransactionID: transaction.TransactionID, ExpectedGeneration: 0, Units: units, Home: home}); err == nil {
		t.Fatal("missing binding was accepted")
	}
	_, err := manager.Commit(CommitRequest{TransactionID: transaction.TransactionID, ExpectedGeneration: 0, Units: units, Home: home, Bindings: []composition.Binding{{Consumer: plugin, Requirement: "state", Provider: provider}}})
	if err == nil {
		t.Fatal("provider contract mismatch was accepted")
	}
}

func identityOf(unit composition.UnitRef) UnitIdentity {
	return UnitIdentity{Kind: string(unit.Kind), ID: unit.ID, Version: unit.Version}
}

func verified(unit composition.UnitRef, staged StagedArtifact, repository, artifactURL string) VerifiedUnit {
	return VerifiedUnit{UnitIdentity: identityOf(unit), RegistryID: "official", SourceRepository: repository, SourceCommit: "0123456789abcdef0123456789abcdef01234567", ArtifactURL: artifactURL, ArtifactSHA256: staged.SHA256, StagedHandle: staged.Handle}
}

func writeJSONFile(t *testing.T, path string, value any) {
	t.Helper()
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
}
