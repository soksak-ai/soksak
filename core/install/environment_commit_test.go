package install

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	coreenvironment "github.com/soksak-ai/soksak-core/core/environment"
)

func TestCommitPublishesOneEnvironmentWithSeparateComponentPaths(t *testing.T) {
	home := t.TempDir()
	manager := NewTransactionManager(filepath.Join(home, ".transactions"), memoryFetcher{})
	root := ArtifactIdentity{Kind: "plugin", ID: "view", Version: "0.0.1"}
	transaction, _ := manager.Begin("official", root)
	pluginArchive := tgz(t, archiveEntry{name: "plugin.json", body: `{"id":"view","version":"0.0.1"}`})
	sidecarArchive := tgz(t, archiveEntry{name: "sidecar.json", body: `{"id":"state","version":"0.0.1"}`})
	manager.fetcher = memoryFetcher{body: pluginArchive}
	pluginStage, err := manager.Stage(context.Background(), StageRequest{TransactionID: transaction.TransactionID, RegistryID: "official", Identity: root, Artifact: Artifact{URL: "https://example.invalid/p.tgz", Size: uint64(len(pluginArchive)), SHA256: sha256Hex(pluginArchive), Format: "tgz", Manifest: "plugin.json", Entrypoints: []string{"plugin.json"}}})
	if err != nil {
		t.Fatal(err)
	}
	sidecarIdentity := ArtifactIdentity{Kind: "sidecar", ID: "state", Version: "0.0.1"}
	manager.fetcher = memoryFetcher{body: sidecarArchive}
	sidecarStage, err := manager.Stage(context.Background(), StageRequest{TransactionID: transaction.TransactionID, RegistryID: "official", Identity: sidecarIdentity, Artifact: Artifact{URL: "https://example.invalid/s.tgz", Size: uint64(len(sidecarArchive)), SHA256: sha256Hex(sidecarArchive), Format: "tgz", Manifest: "sidecar.json", Entrypoints: []string{"sidecar.json"}}})
	if err != nil {
		t.Fatal(err)
	}
	commit := "0123456789abcdef0123456789abcdef01234567"
	result, err := manager.Commit(CommitRequest{
		TransactionID: transaction.TransactionID, ExpectedRevision: 0,
		Plugins:  []VerifiedPlugin{{Plugin: PluginRef{ID: "view", Version: "0.0.1"}, RegistryID: "official", SourceRepository: "https://github.com/example/view", SourceCommit: commit, ArtifactURL: "https://example.invalid/p.tgz", ArtifactSHA256: pluginStage.SHA256, StagedHandle: pluginStage.Handle}},
		Sidecars: []VerifiedSidecar{{Sidecar: SidecarRef{ID: "state", Version: "0.0.1"}, Target: "aarch64-apple-darwin", RegistryID: "official", SourceRepository: "https://github.com/example/state", SourceCommit: commit, ArtifactURL: "https://example.invalid/s.tgz", ArtifactSHA256: sidecarStage.SHA256, StagedHandle: sidecarStage.Handle}},
		Kits:     []VerifiedKit{}, Home: home,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Revision != 1 {
		t.Fatalf("result=%+v", result)
	}
	body, err := os.ReadFile(filepath.Join(home, coreenvironment.File))
	if err != nil {
		t.Fatal(err)
	}
	environment, err := coreenvironment.Parse(body)
	if err != nil {
		t.Fatal(err)
	}
	if len(environment.Plugins) != 1 || len(environment.Sidecars) != 1 {
		t.Fatalf("environment=%+v", environment)
	}
	if environment.Plugins["view"].Path == environment.Sidecars["state"].Path {
		t.Fatalf("plugin and sidecar share install path: %s", environment.Plugins["view"].Path)
	}
	for _, path := range []string{environment.Plugins["view"].Path, environment.Sidecars["state"].Path} {
		if info, err := os.Stat(path); err != nil || !info.IsDir() {
			t.Fatalf("published path %s: info=%v err=%v", path, info, err)
		}
	}
}
