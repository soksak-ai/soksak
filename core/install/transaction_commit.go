package install

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"

	composition "github.com/soksak-ai/soksak-contract-composition"
	"github.com/soksak-ai/soksak-core/core/i18n"
)

type VerifiedUnit struct {
	UnitIdentity
	RegistryID       string `json:"registryId"`
	SourceRepository string `json:"sourceRepository"`
	SourceCommit     string `json:"sourceCommit"`
	ArtifactURL      string `json:"artifactUrl"`
	ArtifactSHA256   string `json:"artifactSha256"`
	StagedHandle     string `json:"stagedHandle"`
}

type CommitRequest struct {
	TransactionID      string
	ExpectedGeneration uint64
	Units              []VerifiedUnit
	Bindings           []composition.Binding
	Home               string
}

type CommitResult struct {
	Generation uint64 `json:"generation"`
}
type publishedUnit struct {
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
	if len(request.Units) == 0 {
		return CommitResult{}, i18n.Errorf("install.transaction.commitUnitsRequired", nil)
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
		next = composition.Settings{Spec: composition.SettingsSpec, Generation: 1, Installations: []composition.Installation{}, Plugins: []composition.PluginSelection{}, Bindings: []composition.Binding{}}
	} else {
		next.Generation++
	}
	prepared := make([]publishedUnit, 0, len(request.Units))
	seen := map[string]bool{}
	manifests := make(map[string]composition.UnitManifest, len(request.Units))
	for _, unit := range request.Units {
		identity := composition.UnitRef{Kind: composition.UnitKind(unit.Kind), ID: unit.ID, Version: unit.Version}
		if seen[identity.Key()] {
			return CommitResult{}, i18n.Errorf("install.transaction.duplicateUnit", map[string]string{"unit": identity.Key()})
		}
		seen[identity.Key()] = true
		staged, err := manager.staged(request.TransactionID, unit.StagedHandle)
		if err != nil {
			return CommitResult{}, err
		}
		if staged.unit != unit.UnitIdentity || staged.sha256 != unit.ArtifactSHA256 {
			return CommitResult{}, i18n.Errorf("install.transaction.stagedUnitMismatch", map[string]string{"unit": identity.Key()})
		}
		manifestBody, err := os.ReadFile(filepath.Join(staged.path, composition.UnitManifestFile))
		if err != nil {
			return CommitResult{}, err
		}
		manifest, err := composition.ParseUnitManifest(manifestBody)
		if err != nil {
			return CommitResult{}, err
		}
		if manifest.UnitRef != identity {
			return CommitResult{}, i18n.Errorf("install.transaction.manifestUnitMismatch", map[string]string{"unit": identity.Key()})
		}
		manifests[identity.Key()] = manifest
		final := filepath.Join(request.Home, "installed", string(identity.Kind), identity.ID, identity.Version)
		if _, err := os.Lstat(final); err == nil {
			return CommitResult{}, i18n.Errorf("install.transaction.destinationExists", map[string]string{"path": final})
		} else if !os.IsNotExist(err) {
			return CommitResult{}, err
		}
		prepared = append(prepared, publishedUnit{final: final, staged: staged})
		next.Installations = replaceInstallation(next.Installations, composition.Installation{UnitRef: identity, Mode: composition.Installed, InstallPath: final, Manifest: composition.UnitManifestFile, Source: composition.Source{Type: composition.ArchiveSource, URL: unit.ArtifactURL, Repository: unit.SourceRepository, Commit: unit.SourceCommit, SHA256: unit.ArtifactSHA256}})
		if identity.Kind == composition.Plugin {
			next.Plugins = replacePluginSelection(next.Plugins, composition.PluginSelection{Plugin: identity, Enabled: true})
		}
	}
	next.Bindings = append([]composition.Binding(nil), request.Bindings...)
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
	for _, installation := range current.Installations {
		if _, replaced := manifests[installation.UnitRef.Key()]; replaced {
			continue
		}
		body, err := os.ReadFile(filepath.Join(installation.InstallPath, installation.Manifest))
		if err != nil {
			continue
		}
		manifest, err := composition.ParseUnitManifest(body)
		if err == nil {
			manifests[installation.UnitRef.Key()] = manifest
		}
	}
	graph, err := composition.Resolve(next, manifests)
	if err != nil {
		return CommitResult{}, err
	}
	for _, unit := range request.Units {
		key := composition.UnitRef{Kind: composition.UnitKind(unit.Kind), ID: unit.ID, Version: unit.Version}.Key()
		for _, node := range graph.Nodes {
			if node.UnitRef.Key() == key && node.Status != composition.Resolved {
				return CommitResult{}, i18n.Errorf("install.transaction.closureUnresolved", map[string]string{"unit": key})
			}
		}
	}
	settingsBody, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return CommitResult{}, err
	}
	settingsPath := filepath.Join(request.Home, composition.SettingsFile)
	settingsTemp := settingsPath + ".next-" + request.TransactionID
	if err := os.MkdirAll(filepath.Dir(settingsPath), 0o700); err != nil {
		return CommitResult{}, err
	}
	if err := os.WriteFile(settingsTemp, append(settingsBody, byte(10)), 0o600); err != nil {
		return CommitResult{}, err
	}
	journal := commitJournal{TransactionID: request.TransactionID, PreviousGeneration: request.ExpectedGeneration, Generation: next.Generation, Moves: make([]journalMove, 0, len(prepared))}
	for _, unit := range prepared {
		journal.Moves = append(journal.Moves, journalMove{Staged: unit.staged.path, Final: unit.final})
	}
	if err := writeCommitJournal(manager.root, journal); err != nil {
		_ = os.Remove(settingsTemp)
		return CommitResult{}, err
	}
	published := make([]publishedUnit, 0, len(prepared))
	rollback := func() {
		for index := len(published) - 1; index >= 0; index-- {
			_ = os.Rename(published[index].final, published[index].staged.path)
		}
		_ = os.Remove(settingsTemp)
	}
	for _, unit := range prepared {
		if err := os.MkdirAll(filepath.Dir(unit.final), 0o755); err != nil {
			rollback()
			return CommitResult{}, err
		}
		if err := os.Rename(unit.staged.path, unit.final); err != nil {
			rollback()
			return CommitResult{}, err
		}
		published = append(published, unit)
	}
	if err := os.Rename(settingsTemp, settingsPath); err != nil {
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

func replaceInstallation(values []composition.Installation, replacement composition.Installation) []composition.Installation {
	result := make([]composition.Installation, 0, len(values)+1)
	for _, value := range values {
		if value.UnitRef != replacement.UnitRef {
			result = append(result, value)
		}
	}
	return append(result, replacement)
}

func replacePluginSelection(values []composition.PluginSelection, replacement composition.PluginSelection) []composition.PluginSelection {
	result := make([]composition.PluginSelection, 0, len(values)+1)
	for _, value := range values {
		if value.Plugin != replacement.Plugin {
			result = append(result, value)
		}
	}
	return append(result, replacement)
}

func sortSettings(settings *composition.Settings) {
	sort.Slice(settings.Installations, func(i, j int) bool {
		return settings.Installations[i].UnitRef.Key() < settings.Installations[j].UnitRef.Key()
	})
	sort.Slice(settings.Plugins, func(i, j int) bool { return settings.Plugins[i].Plugin.Key() < settings.Plugins[j].Plugin.Key() })
	sort.Slice(settings.Bindings, func(i, j int) bool {
		return settings.Bindings[i].Consumer.Key()+":"+settings.Bindings[i].Requirement < settings.Bindings[j].Consumer.Key()+":"+settings.Bindings[j].Requirement
	})
}
