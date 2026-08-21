package install

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	composition "github.com/soksak-ai/soksak-contract-composition"
)

func TestCommitPublishesPluginAndSidecarSeparately(t *testing.T) {
	home := t.TempDir()
	manager := NewTransactionManager(filepath.Join(home, ".transactions"), memoryFetcher{})
	root := ArtifactIdentity{Kind: "plugin", ID: "view", Version: "0.0.1"}
	transaction, _ := manager.Begin("official", root)
	archive := tgz(t, archiveEntry{name: "plugin.json", body: "{}"}, archiveEntry{name: "sidecar.json", body: "{}"})
	manager.fetcher = memoryFetcher{body: archive}
	pluginStage, err := manager.Stage(context.Background(), StageRequest{TransactionID: transaction.TransactionID, RegistryID: "official", Identity: root, Artifact: Artifact{URL: "https://example.invalid/p.tgz", SHA256: sha256Hex(archive), Format: "tgz", Manifest: "plugin.json", Entrypoints: []string{"plugin.json"}}})
	if err != nil {
		t.Fatal(err)
	}
	sidecarIdentity := ArtifactIdentity{Kind: "sidecar", ID: "state", Version: "0.0.1"}
	sidecarStage, err := manager.Stage(context.Background(), StageRequest{TransactionID: transaction.TransactionID, RegistryID: "official", Identity: sidecarIdentity, Artifact: Artifact{URL: "https://example.invalid/s.tgz", SHA256: sha256Hex(archive), Format: "tgz", Manifest: "sidecar.json", Entrypoints: []string{"sidecar.json"}}})
	if err != nil {
		t.Fatal(err)
	}
	commit := "0123456789abcdef0123456789abcdef01234567"
	result, err := manager.Commit(CommitRequest{
		TransactionID: transaction.TransactionID, ExpectedGeneration: 0,
		Plugins:  []VerifiedPlugin{{Plugin: composition.PluginRef{ID: "view", Version: "0.0.1"}, RegistryID: "official", SourceRepository: "https://github.com/example/view", SourceCommit: commit, ArtifactURL: "https://example.invalid/p.tgz", ArtifactSHA256: pluginStage.SHA256, StagedHandle: pluginStage.Handle}},
		Sidecars: []VerifiedSidecar{{Sidecar: composition.SidecarRef{ID: "state", Version: "0.0.1"}, RegistryID: "official", SourceRepository: "https://github.com/example/state", SourceCommit: commit, ArtifactURL: "https://example.invalid/s.tgz", ArtifactSHA256: sidecarStage.SHA256, StagedHandle: sidecarStage.Handle}},
		Kits:     []VerifiedKit{}, Bindings: []composition.Binding{}, Home: home,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Generation != 1 {
		t.Fatalf("result=%+v", result)
	}
	body, err := os.ReadFile(filepath.Join(home, composition.SettingsFile))
	if err != nil {
		t.Fatal(err)
	}
	settings, err := composition.ParseSettings(body)
	if err != nil {
		t.Fatal(err)
	}
	if len(settings.Plugins) != 1 || len(settings.Sidecars) != 1 || settings.Plugins[0].Manifest != "plugin.json" || settings.Sidecars[0].Manifest != "sidecar.json" {
		t.Fatalf("settings=%+v", settings)
	}
	if settings.Plugins[0].InstallPath == settings.Sidecars[0].InstallPath {
		t.Fatalf("plugin and sidecar share install path: %s", settings.Plugins[0].InstallPath)
	}
	for _, path := range []string{settings.Plugins[0].InstallPath, settings.Sidecars[0].InstallPath} {
		if info, err := os.Stat(path); err != nil || !info.IsDir() {
			t.Fatalf("published path %s: info=%v err=%v", path, info, err)
		}
	}
}
