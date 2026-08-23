package install

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type memoryFetcher struct {
	body []byte
	err  error
}

func (fetcher memoryFetcher) Fetch(context.Context, string) ([]byte, error) {
	return fetcher.body, fetcher.err
}

type archiveEntry struct {
	name, body string
	kind       byte
	link       string
}

func tgz(t *testing.T, entries ...archiveEntry) []byte {
	t.Helper()
	var output bytes.Buffer
	gzipWriter := gzip.NewWriter(&output)
	tarWriter := tar.NewWriter(gzipWriter)
	for _, entry := range entries {
		header := &tar.Header{Name: entry.name, Mode: 0o644, Size: int64(len(entry.body)), Typeflag: entry.kind, Linkname: entry.link}
		if entry.kind == 0 {
			header.Typeflag = tar.TypeReg
		}
		if err := tarWriter.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if header.Typeflag == tar.TypeReg {
			if _, err := tarWriter.Write([]byte(entry.body)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tarWriter.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gzipWriter.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

func TestTransactionStagesAndReadsARegularFileArchive(t *testing.T) {
	archive := tgz(t, archiveEntry{name: "plugin.json", body: `{"id":"demo","version":"0.0.1"}`}, archiveEntry{name: "main.js", body: "export default {}"})
	manager := NewTransactionManager(t.TempDir(), memoryFetcher{body: archive})
	transaction, err := manager.Begin("official", ArtifactIdentity{Kind: "plugin", ID: "demo", Version: "0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	staged, err := manager.Stage(context.Background(), StageRequest{
		TransactionID: transaction.TransactionID, RegistryID: "official",
		Identity: ArtifactIdentity{Kind: "plugin", ID: "demo", Version: "0.0.1"},
		Artifact: Artifact{URL: "https://example.invalid/demo.tgz", Size: uint64(len(archive)), SHA256: sha256Hex(archive), Format: "tgz", Manifest: "plugin.json", Entrypoints: []string{"plugin.json"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if staged.Extraction != "regular-files-only" || staged.Size != uint64(len(archive)) || staged.ManifestSHA256 != sha256Hex([]byte(`{"id":"demo","version":"0.0.1"}`)) || len(staged.VerifiedEntrypoints) != 1 {
		t.Fatalf("staged = %+v", staged)
	}
	text, err := manager.ReadUTF8(transaction.TransactionID, staged.Handle, "plugin.json")
	if err != nil || text != `{"id":"demo","version":"0.0.1"}` {
		t.Fatalf("text=%q err=%v", text, err)
	}
	if err := manager.Rollback(transaction.TransactionID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(manager.root, transaction.TransactionID)); !os.IsNotExist(err) {
		t.Fatalf("staging remains: %v", err)
	}
}

func TestStageAcceptsAConventionalDirectoryEntry(t *testing.T) {
	archive := tgz(t,
		archiveEntry{name: "plugin.json", body: `{"id":"demo","version":"0.0.1"}`},
		archiveEntry{name: "dist/", kind: tar.TypeDir},
		archiveEntry{name: "dist/main.js", body: "export default {}"},
	)
	manager := NewTransactionManager(t.TempDir(), memoryFetcher{body: archive})
	identity := ArtifactIdentity{Kind: "plugin", ID: "demo", Version: "0.0.1"}
	transaction, err := manager.Begin("official", identity)
	if err != nil {
		t.Fatal(err)
	}
	_, err = manager.Stage(context.Background(), StageRequest{
		TransactionID: transaction.TransactionID, RegistryID: "official", Identity: identity,
		Artifact: Artifact{URL: "https://example.invalid/demo.tgz", Size: uint64(len(archive)), SHA256: sha256Hex(archive), Format: "tgz", Manifest: "plugin.json", Entrypoints: []string{"plugin.json", "dist/main.js"}},
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestStageRejectsDigestMismatch(t *testing.T) {
	archive := tgz(t, archiveEntry{name: "plugin.json", body: `{"id":"demo","version":"0.0.1"}`})
	manager := NewTransactionManager(t.TempDir(), memoryFetcher{body: archive})
	transaction, _ := manager.Begin("official", ArtifactIdentity{Kind: "plugin", ID: "demo", Version: "0.0.1"})
	_, err := manager.Stage(context.Background(), StageRequest{TransactionID: transaction.TransactionID, RegistryID: "official", Identity: ArtifactIdentity{Kind: "plugin", ID: "demo", Version: "0.0.1"}, Artifact: Artifact{URL: "https://example.invalid/a.tgz", Size: uint64(len(archive)), SHA256: strings.Repeat("0", 64), Format: "tgz", Manifest: "plugin.json", Entrypoints: []string{"plugin.json"}}})
	if err == nil || !strings.Contains(err.Error(), "SHA-256") {
		t.Fatalf("error = %v", err)
	}
}

func TestStageRejectsManifestIdentityMismatch(t *testing.T) {
	for _, fixture := range []struct {
		identity ArtifactIdentity
		manifest string
		body     string
	}{
		{ArtifactIdentity{Kind: "plugin", ID: "view", Version: "0.0.1"}, "plugin.json", `{"id":"other","version":"0.0.1"}`},
		{ArtifactIdentity{Kind: "sidecar", ID: "state", Version: "0.0.1"}, "sidecar.json", `{"id":"state","version":"0.0.2"}`},
		{ArtifactIdentity{Kind: "kit", ID: "terminal", Version: "0.0.1"}, "kit.json", `{"id":"terminal","version":"0.0.0"}`},
	} {
		archive := tgz(t, archiveEntry{name: fixture.manifest, body: fixture.body})
		manager := NewTransactionManager(t.TempDir(), memoryFetcher{body: archive})
		transaction, _ := manager.Begin("official", fixture.identity)
		_, err := manager.Stage(context.Background(), StageRequest{
			TransactionID: transaction.TransactionID, RegistryID: "official", Identity: fixture.identity,
			Artifact: Artifact{URL: "https://example.invalid/a.tgz", Size: uint64(len(archive)), SHA256: sha256Hex(archive), Format: "tgz", Manifest: fixture.manifest, Entrypoints: []string{fixture.manifest}},
		})
		if err == nil || !strings.Contains(err.Error(), "identity") {
			t.Errorf("%s error = %v", fixture.identity.Kind, err)
		}
	}
}

func TestStageRejectsUnsafeManifestPath(t *testing.T) {
	archive := tgz(t, archiveEntry{name: "plugin.json", body: `{"id":"demo","version":"0.0.1"}`})
	manager := NewTransactionManager(t.TempDir(), memoryFetcher{body: archive})
	identity := ArtifactIdentity{Kind: "plugin", ID: "demo", Version: "0.0.1"}
	transaction, _ := manager.Begin("official", identity)
	_, err := manager.Stage(context.Background(), StageRequest{
		TransactionID: transaction.TransactionID, RegistryID: "official", Identity: identity,
		Artifact: Artifact{URL: "https://example.invalid/a.tgz", Size: uint64(len(archive)), SHA256: sha256Hex(archive), Format: "tgz", Manifest: "../plugin.json", Entrypoints: []string{"plugin.json"}},
	})
	if err == nil || !strings.Contains(err.Error(), "manifest") {
		t.Fatalf("error = %v", err)
	}
}

func TestStageRejectsLinksAndPathEscape(t *testing.T) {
	archives := [][]byte{
		tgz(t, archiveEntry{name: "plugin.json", kind: tar.TypeSymlink, link: "elsewhere"}),
		tgz(t, archiveEntry{name: "../plugin.json", body: "{}"}),
		tgz(t, archiveEntry{name: "./", kind: tar.TypeDir}, archiveEntry{name: "plugin.json", body: "{}"}),
	}
	for _, archive := range archives {
		manager := NewTransactionManager(t.TempDir(), memoryFetcher{body: archive})
		transaction, _ := manager.Begin("official", ArtifactIdentity{Kind: "plugin", ID: "demo", Version: "0.0.1"})
		_, err := manager.Stage(context.Background(), StageRequest{TransactionID: transaction.TransactionID, RegistryID: "official", Identity: ArtifactIdentity{Kind: "plugin", ID: "demo", Version: "0.0.1"}, Artifact: Artifact{URL: "https://example.invalid/a.tgz", Size: uint64(len(archive)), SHA256: sha256Hex(archive), Format: "tgz", Manifest: "plugin.json", Entrypoints: []string{"plugin.json"}}})
		if err == nil {
			t.Fatal("unsafe archive was accepted")
		}
	}
}

func TestStageRequiresEveryDeclaredEntrypointAsARegularFile(t *testing.T) {
	archive := tgz(t, archiveEntry{name: "main.js", body: "x"})
	manager := NewTransactionManager(t.TempDir(), memoryFetcher{body: archive})
	transaction, _ := manager.Begin("official", ArtifactIdentity{Kind: "plugin", ID: "demo", Version: "0.0.1"})
	_, err := manager.Stage(context.Background(), StageRequest{TransactionID: transaction.TransactionID, RegistryID: "official", Identity: ArtifactIdentity{Kind: "plugin", ID: "demo", Version: "0.0.1"}, Artifact: Artifact{URL: "https://example.invalid/a.tgz", Size: uint64(len(archive)), SHA256: sha256Hex(archive), Format: "tgz", Manifest: "plugin.json", Entrypoints: []string{"plugin.json"}}})
	if err == nil || !strings.Contains(err.Error(), "entrypoint") {
		t.Fatalf("error = %v", err)
	}
}

func TestStagedHandleRetainsExactArtifactAndDigest(t *testing.T) {
	archive := tgz(t, archiveEntry{name: "plugin.json", body: `{"id":"demo","version":"0.0.1"}`})
	manager := NewTransactionManager(t.TempDir(), memoryFetcher{body: archive})
	artifact := ArtifactIdentity{Kind: "plugin", ID: "demo", Version: "0.0.1"}
	transaction, _ := manager.Begin("official", artifact)
	staged, err := manager.Stage(context.Background(), StageRequest{TransactionID: transaction.TransactionID, RegistryID: "official", Identity: artifact, Artifact: Artifact{URL: "https://example.invalid/a.tgz", Size: uint64(len(archive)), SHA256: sha256Hex(archive), Format: "tgz", Manifest: "plugin.json", Entrypoints: []string{"plugin.json"}}})
	if err != nil {
		t.Fatal(err)
	}
	state, err := manager.staged(transaction.TransactionID, staged.Handle)
	if err != nil {
		t.Fatal(err)
	}
	if state.identity != artifact || state.sha256 != staged.SHA256 || state.size != staged.Size || state.manifestSHA256 != staged.ManifestSHA256 {
		t.Fatalf("state = %+v", state)
	}
}
