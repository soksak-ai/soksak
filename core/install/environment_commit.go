package install

import (
	"os"
	"path/filepath"

	coreenvironment "github.com/soksak-ai/soksak-core/core/environment"
	"github.com/soksak-ai/soksak-core/core/i18n"
)

type VerifiedComponent struct {
	Kind             string `json:"kind"`
	ID               string `json:"id"`
	Version          string `json:"version"`
	Target           string `json:"target,omitempty"`
	RegistryID       string `json:"registryId"`
	SourceRepository string `json:"sourceRepository"`
	SourceCommit     string `json:"sourceCommit"`
	ArtifactURL      string `json:"artifactUrl"`
	ArtifactSHA256   string `json:"artifactSha256"`
	StagedHandle     string `json:"stagedHandle"`
}
type CommitRequest struct {
	TransactionID    string
	ExpectedRevision uint64
	Components       []VerifiedComponent
	Home             string
}
type CommitResult struct {
	Revision uint64 `json:"revision"`
}
type publishArtifact struct {
	kind, id, version, target, repository, commit, url, digest, handle string
}
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
	manager.recordProgress(ArtifactInstallProgress{
		TransactionID: request.TransactionID, RegistryID: transaction.registryID,
		Root: transaction.root, Component: transaction.root, Phase: "committing",
	})
	artifacts := []publishArtifact{}
	for _, value := range request.Components {
		artifacts = append(artifacts, publishArtifact{kind: value.Kind, id: value.ID, version: value.Version, target: value.Target, repository: value.SourceRepository, commit: value.SourceCommit, url: value.ArtifactURL, digest: value.ArtifactSHA256, handle: value.StagedHandle})
	}
	if len(artifacts) == 0 {
		return CommitResult{}, i18n.Errorf("install.transaction.commitArtifactsRequired", nil)
	}
	current, exists, err := coreenvironment.Read(request.Home)
	if err != nil {
		return CommitResult{}, err
	}
	next := current
	if !exists {
		next = coreenvironment.Empty()
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
		parts := []string{request.Home, "components", artifact.kind, artifact.id, artifact.version}
		if artifact.kind == "sidecar" {
			if artifact.target == "" {
				return CommitResult{}, i18n.Errorf("install.transaction.targetRequired", map[string]string{"artifact": key})
			}
			parts = append(parts, artifact.target)
		}
		final := filepath.Join(parts...)
		if _, err := os.Lstat(final); err == nil {
			return CommitResult{}, i18n.Errorf("install.transaction.destinationExists", map[string]string{"path": final})
		} else if !os.IsNotExist(err) {
			return CommitResult{}, err
		}
		prepared = append(prepared, publishedArtifact{final: final, staged: staged})
		value := coreenvironment.Component{Version: artifact.version, Path: final, Source: "registry", Registry: transaction.registryID, Target: artifact.target}
		switch artifact.kind {
		case "plugin":
			plugin := next.Plugins[artifact.id]
			plugin.Component = value
			next.Plugins[artifact.id] = plugin
		case "sidecar":
			next.Sidecars[artifact.id] = value
		case "kit":
			next.Kits[artifact.id] = value
		}
	}
	change, temporary, err := coreenvironment.PrepareWrite(request.Home, current, exists, next, request.ExpectedRevision, "next-"+request.TransactionID)
	if err != nil {
		return CommitResult{}, err
	}
	journal := commitJournal{TransactionID: request.TransactionID, PreviousGeneration: request.ExpectedRevision, Generation: change.Revision, Moves: []journalMove{}}
	for _, value := range prepared {
		journal.Moves = append(journal.Moves, journalMove{Staged: value.staged.path, Final: value.final})
	}
	if err := writeCommitJournal(manager.root, journal); err != nil {
		_ = os.Remove(temporary)
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
	if err := coreenvironment.Publish(request.Home, temporary); err != nil {
		rollback()
		return CommitResult{}, err
	}
	manager.mu.Lock()
	delete(manager.transactions, request.TransactionID)
	manager.mu.Unlock()
	_ = os.RemoveAll(filepath.Join(manager.root, request.TransactionID))
	manager.recordProgress(ArtifactInstallProgress{
		TransactionID: request.TransactionID, RegistryID: transaction.registryID,
		Root: transaction.root, Component: transaction.root, Phase: "committed",
	})
	return CommitResult{Revision: change.Revision}, nil
}
