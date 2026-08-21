package install

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"

	composition "github.com/soksak-ai/soksak-contract-composition"
	"github.com/soksak-ai/soksak-core/core/i18n"
)

type VerifiedPlugin struct {
	Plugin           composition.PluginRef `json:"plugin"`
	RegistryID       string                `json:"registryId"`
	SourceRepository string                `json:"sourceRepository"`
	SourceCommit     string                `json:"sourceCommit"`
	ArtifactURL      string                `json:"artifactUrl"`
	ArtifactSHA256   string                `json:"artifactSha256"`
	StagedHandle     string                `json:"stagedHandle"`
}
type VerifiedSidecar struct {
	Sidecar          composition.SidecarRef `json:"sidecar"`
	RegistryID       string                 `json:"registryId"`
	SourceRepository string                 `json:"sourceRepository"`
	SourceCommit     string                 `json:"sourceCommit"`
	ArtifactURL      string                 `json:"artifactUrl"`
	ArtifactSHA256   string                 `json:"artifactSha256"`
	StagedHandle     string                 `json:"stagedHandle"`
}
type VerifiedKit struct {
	Kit              composition.KitRef `json:"kit"`
	RegistryID       string             `json:"registryId"`
	SourceRepository string             `json:"sourceRepository"`
	SourceCommit     string             `json:"sourceCommit"`
	ArtifactURL      string             `json:"artifactUrl"`
	ArtifactSHA256   string             `json:"artifactSha256"`
	StagedHandle     string             `json:"stagedHandle"`
}
type CommitRequest struct {
	TransactionID      string
	ExpectedGeneration uint64
	Plugins            []VerifiedPlugin
	Sidecars           []VerifiedSidecar
	Kits               []VerifiedKit
	Bindings           []composition.Binding
	Home               string
}
type CommitResult struct {
	Generation uint64 `json:"generation"`
}
type publishArtifact struct{ kind, id, version, manifest, repository, commit, url, digest, handle string }
type publishedArtifact struct {
	final  string
	staged stagedState
}

func (manager *TransactionManager) Commit(request CommitRequest) (CommitResult, error) {
	if !filepath.IsAbs(request.Home) {
		return CommitResult{}, i18n.Errorf("install.transaction.homeAbsolute", nil)
	}
	manager.mu.Lock()
	transaction := manager.transactions[request.TransactionID]
	manager.mu.Unlock()
	if transaction == nil {
		return CommitResult{}, i18n.Errorf("install.transaction.notFound", map[string]string{"id": request.TransactionID})
	}
	artifacts := []publishArtifact{}
	for _, value := range request.Plugins {
		artifacts = append(artifacts, publishArtifact{kind: "plugin", id: value.Plugin.ID, version: value.Plugin.Version, manifest: "plugin.json", repository: value.SourceRepository, commit: value.SourceCommit, url: value.ArtifactURL, digest: value.ArtifactSHA256, handle: value.StagedHandle})
	}
	for _, value := range request.Sidecars {
		artifacts = append(artifacts, publishArtifact{kind: "sidecar", id: value.Sidecar.ID, version: value.Sidecar.Version, manifest: "sidecar.json", repository: value.SourceRepository, commit: value.SourceCommit, url: value.ArtifactURL, digest: value.ArtifactSHA256, handle: value.StagedHandle})
	}
	for _, value := range request.Kits {
		artifacts = append(artifacts, publishArtifact{kind: "kit", id: value.Kit.ID, version: value.Kit.Version, manifest: "package.json", repository: value.SourceRepository, commit: value.SourceCommit, url: value.ArtifactURL, digest: value.ArtifactSHA256, handle: value.StagedHandle})
	}
	if len(artifacts) == 0 {
		return CommitResult{}, i18n.Errorf("install.transaction.commitArtifactsRequired", nil)
	}
	current, exists, err := readCompositionSettings(request.Home)
	if err != nil {
		return CommitResult{}, err
	}
	if exists && current.Generation != request.ExpectedGeneration {
		return CommitResult{}, composition.ErrGenerationConflict{Expected: request.ExpectedGeneration, Actual: current.Generation}
	}
	if !exists && request.ExpectedGeneration != 0 {
		return CommitResult{}, composition.ErrGenerationConflict{Expected: request.ExpectedGeneration, Actual: 0}
	}
	next := current
	if !exists {
		next = composition.Settings{Spec: composition.SettingsSpec, Generation: 1, Plugins: []composition.Plugin{}, Sidecars: []composition.Sidecar{}, Kits: []composition.Kit{}, Bindings: []composition.Binding{}}
	} else {
		next.Generation++
	}
	prepared := []publishedArtifact{}
	seen := map[string]bool{}
	for _, artifact := range artifacts {
		key := artifact.kind + ":" + artifact.id + "@" + artifact.version
		if seen[key] {
			return CommitResult{}, i18n.Errorf("install.transaction.duplicateArtifact", map[string]string{"artifact": key})
		}
		seen[key] = true
		staged, err := manager.staged(request.TransactionID, artifact.handle)
		if err != nil {
			return CommitResult{}, err
		}
		expected := ArtifactIdentity{Kind: artifact.kind, ID: artifact.id, Version: artifact.version}
		if staged.identity != expected || staged.sha256 != artifact.digest {
			return CommitResult{}, i18n.Errorf("install.transaction.stagedArtifactMismatch", map[string]string{"artifact": key})
		}
		if staged.manifest != "" {
			artifact.manifest = staged.manifest
		}
		info, err := os.Lstat(filepath.Join(staged.path, filepath.FromSlash(artifact.manifest)))
		if err != nil || !info.Mode().IsRegular() {
			return CommitResult{}, i18n.Errorf("install.transaction.manifestArtifactMismatch", map[string]string{"artifact": key})
		}
		final := filepath.Join(request.Home, "installed", artifact.kind, artifact.id, artifact.version)
		if _, err := os.Lstat(final); err == nil {
			return CommitResult{}, i18n.Errorf("install.transaction.destinationExists", map[string]string{"path": final})
		} else if !os.IsNotExist(err) {
			return CommitResult{}, err
		}
		prepared = append(prepared, publishedArtifact{final: final, staged: staged})
		source := composition.Source{Type: composition.ArchiveSource, URL: artifact.url, Repository: artifact.repository, Commit: artifact.commit, SHA256: artifact.digest}
		switch artifact.kind {
		case "plugin":
			next.Plugins = replacePlugin(next.Plugins, composition.Plugin{PluginRef: composition.PluginRef{ID: artifact.id, Version: artifact.version}, Enabled: true, InstallPath: final, Manifest: artifact.manifest, Source: source})
		case "sidecar":
			next.Sidecars = replaceSidecar(next.Sidecars, composition.Sidecar{SidecarRef: composition.SidecarRef{ID: artifact.id, Version: artifact.version}, Enabled: true, InstallPath: final, Manifest: artifact.manifest, Source: source})
		case "kit":
			next.Kits = replaceKit(next.Kits, composition.Kit{KitRef: composition.KitRef{ID: artifact.id, Version: artifact.version}, Enabled: true, InstallPath: final, Manifest: artifact.manifest, Source: source})
		}
	}
	next.Bindings = make([]composition.Binding, len(request.Bindings))
	copy(next.Bindings, request.Bindings)
	sortSettings(&next)
	if exists {
		if _, _, err := composition.Replace(current, next, request.ExpectedGeneration); err != nil {
			return CommitResult{}, err
		}
	} else {
		if _, _, err := composition.Initialize(next); err != nil {
			return CommitResult{}, err
		}
	}
	if _, err := composition.Resolve(next); err != nil {
		return CommitResult{}, err
	}
	body, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return CommitResult{}, err
	}
	settingsPath := filepath.Join(request.Home, composition.SettingsFile)
	temporary := settingsPath + ".next-" + request.TransactionID
	if err := os.MkdirAll(request.Home, 0o700); err != nil {
		return CommitResult{}, err
	}
	if err := os.WriteFile(temporary, append(body, byte(10)), 0o600); err != nil {
		return CommitResult{}, err
	}
	journal := commitJournal{TransactionID: request.TransactionID, PreviousGeneration: request.ExpectedGeneration, Generation: next.Generation, Moves: []journalMove{}}
	for _, value := range prepared {
		journal.Moves = append(journal.Moves, journalMove{Staged: value.staged.path, Final: value.final})
	}
	if err := writeCommitJournal(manager.root, journal); err != nil {
		return CommitResult{}, err
	}
	published := []publishedArtifact{}
	rollback := func() {
		for index := len(published) - 1; index >= 0; index-- {
			_ = os.Rename(published[index].final, published[index].staged.path)
		}
		_ = os.Remove(temporary)
	}
	for _, value := range prepared {
		if err := os.MkdirAll(filepath.Dir(value.final), 0o755); err != nil {
			rollback()
			return CommitResult{}, err
		}
		if err := os.Rename(value.staged.path, value.final); err != nil {
			rollback()
			return CommitResult{}, err
		}
		published = append(published, value)
	}
	if err := os.Rename(temporary, settingsPath); err != nil {
		rollback()
		return CommitResult{}, err
	}
	manager.mu.Lock()
	delete(manager.transactions, request.TransactionID)
	manager.mu.Unlock()
	_ = os.RemoveAll(filepath.Join(manager.root, request.TransactionID))
	return CommitResult{Generation: next.Generation}, nil
}
func readCompositionSettings(home string) (composition.Settings, bool, error) {
	body, err := os.ReadFile(filepath.Join(home, composition.SettingsFile))
	if os.IsNotExist(err) {
		return composition.Settings{}, false, nil
	}
	if err != nil {
		return composition.Settings{}, false, err
	}
	settings, err := composition.ParseSettings(body)
	return settings, err == nil, err
}
func replacePlugin(values []composition.Plugin, replacement composition.Plugin) []composition.Plugin {
	result := make([]composition.Plugin, 0, len(values)+1)
	for _, value := range values {
		if value.PluginRef != replacement.PluginRef {
			result = append(result, value)
		}
	}
	return append(result, replacement)
}
func replaceSidecar(values []composition.Sidecar, replacement composition.Sidecar) []composition.Sidecar {
	result := make([]composition.Sidecar, 0, len(values)+1)
	for _, value := range values {
		if value.SidecarRef != replacement.SidecarRef {
			result = append(result, value)
		}
	}
	return append(result, replacement)
}
func replaceKit(values []composition.Kit, replacement composition.Kit) []composition.Kit {
	result := make([]composition.Kit, 0, len(values)+1)
	for _, value := range values {
		if value.KitRef != replacement.KitRef {
			result = append(result, value)
		}
	}
	return append(result, replacement)
}
func sortSettings(settings *composition.Settings) {
	sort.Slice(settings.Plugins, func(i, j int) bool { return settings.Plugins[i].ID < settings.Plugins[j].ID })
	sort.Slice(settings.Sidecars, func(i, j int) bool { return settings.Sidecars[i].ID < settings.Sidecars[j].ID })
	sort.Slice(settings.Kits, func(i, j int) bool { return settings.Kits[i].ID < settings.Kits[j].ID })
}
