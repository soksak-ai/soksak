package install

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLocalTransactionReadsOnlyTheAddressedReleaseAsset(t *testing.T) {
	store := t.TempDir()
	archive := tgz(t, archiveEntry{name: "plugin.json", body: `{"id":"view","version":"0.0.1"}`})
	directory := filepath.Join(store, "plugins", "view", "0.0.1")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "view.tgz"), archive, 0o600); err != nil {
		t.Fatal(err)
	}
	manager := NewTransactionManager(t.TempDir(), memoryFetcher{err: context.Canceled}, nil)
	identity := ArtifactIdentity{Kind: "plugin", ID: "view", Version: "0.0.1"}
	transaction, err := manager.Begin("local", identity, store)
	if err != nil {
		t.Fatal(err)
	}
	_, err = manager.Stage(context.Background(), StageRequest{TransactionID: transaction.TransactionID, RegistryID: "local", Identity: identity, Artifact: Artifact{File: "view.tgz", Size: uint64(len(archive)), SHA256: sha256Hex(archive), Format: "tgz", Manifest: "plugin.json", Entrypoints: []string{"plugin.json"}}})
	if err != nil {
		t.Fatalf("local stage used the remote fetcher: %v", err)
	}
}

func TestLocalTransactionNeverFallsBackWhenTheReleaseIsMissing(t *testing.T) {
	manager := NewTransactionManager(t.TempDir(), memoryFetcher{body: []byte("remote bytes")}, nil)
	identity := ArtifactIdentity{Kind: "plugin", ID: "view", Version: "0.0.1"}
	transaction, err := manager.Begin("local", identity, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	_, err = manager.Stage(context.Background(), StageRequest{TransactionID: transaction.TransactionID, RegistryID: "local", Identity: identity, Artifact: Artifact{File: "view.tgz", Size: 12, SHA256: strings.Repeat("a", 64), Format: "tgz", Manifest: "plugin.json", Entrypoints: []string{"plugin.json"}}})
	if err == nil || !strings.Contains(err.Error(), "local release is missing") {
		t.Fatalf("error = %v", err)
	}
}

func TestLocalTransactionRefusesADependencyAbsentFromTheStore(t *testing.T) {
	store := t.TempDir()
	rootDirectory := filepath.Join(store, "plugins", "root", "0.0.1")
	if err := os.MkdirAll(rootDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	archive := tgz(t, archiveEntry{name: "sidecar.json", body: `{"id":"state","version":"0.0.1"}`})
	fetcher := &recordingFetcher{body: archive}
	manager := NewTransactionManager(t.TempDir(), fetcher, nil)
	root := ArtifactIdentity{Kind: "plugin", ID: "root", Version: "0.0.1"}
	transaction, err := manager.Begin("local", root, store)
	if err != nil {
		t.Fatal(err)
	}
	identity := ArtifactIdentity{Kind: "sidecar", ID: "state", Version: "0.0.1"}
	_, err = manager.Stage(context.Background(), StageRequest{TransactionID: transaction.TransactionID, RegistryID: "local", Identity: identity, Artifact: Artifact{File: "state.tgz", Size: uint64(len(archive)), SHA256: sha256Hex(archive), Format: "tgz", Manifest: "sidecar.json", Entrypoints: []string{"sidecar.json"}}})
	if err == nil || !strings.Contains(err.Error(), "local release is missing") {
		t.Fatalf("error = %v", err)
	}
	if len(fetcher.locations) != 0 {
		t.Fatalf("a local transaction reached the network: %q", fetcher.locations)
	}
}

// recordingFetcher answers body and keeps every location it was asked for.
type recordingFetcher struct {
	body      []byte
	locations []string
}

func (fetcher *recordingFetcher) Fetch(_ context.Context, location string, progress func(uint64)) ([]byte, error) {
	fetcher.locations = append(fetcher.locations, location)
	if progress != nil {
		progress(uint64(len(fetcher.body)))
	}
	return fetcher.body, nil
}

func TestRemoteTransactionFetchesTheLocationDerivedFromIdentityAndFile(t *testing.T) {
	archive := tgz(t, archiveEntry{name: "plugin.json", body: `{"id":"view","version":"0.0.1"}`})
	fetcher := &recordingFetcher{body: archive}
	manager := NewTransactionManager(t.TempDir(), fetcher, nil)
	identity := ArtifactIdentity{Kind: "plugin", ID: "view", Version: "0.0.1"}
	transaction, err := manager.Begin("official", identity)
	if err != nil {
		t.Fatal(err)
	}
	_, err = manager.Stage(context.Background(), StageRequest{TransactionID: transaction.TransactionID, RegistryID: "official", Identity: identity, Artifact: Artifact{File: "view-0.0.1.tgz", Size: uint64(len(archive)), SHA256: sha256Hex(archive), Format: "tgz", Manifest: "plugin.json", Entrypoints: []string{"plugin.json"}}})
	if err != nil {
		t.Fatal(err)
	}
	expected := []string{"https://github.com/soksak-ai/view/releases/download/v0.0.1/view-0.0.1.tgz"}
	if len(fetcher.locations) != 1 || fetcher.locations[0] != expected[0] {
		t.Fatalf("locations=%q expected=%q", fetcher.locations, expected)
	}
}
