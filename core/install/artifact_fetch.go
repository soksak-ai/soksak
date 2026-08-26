package install

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/soksak-ai/soksak-core/core/i18n"
	platformspec "github.com/soksak-ai/soksak-spec/go/platformspec"
)

// No document records a location. A release directory is derived from (kind, id, version):
// published, https://github.com/<GitHubOrg>/<id>/releases/download/v<version>/;
// local store, <store>/<kind>s/<id>/<version>/. A file inside is addressed by its bare name.

var localKindDirectory = map[string]string{"plugin": "plugins", "sidecar": "sidecars"}

func releaseFileURL(id, version, file string) string {
	return "https://github.com/" + platformspec.GitHubOrg + "/" + id + "/releases/download/v" + version + "/" + file
}

// fetchArtifact reads file of identity's release. A remote transaction reads the published
// location. A local transaction reads the store only: a release absent from the store, root or
// dependency, is refused by name (the closure walker composes every dependency into the store first).
func (manager *TransactionManager) fetchArtifact(ctx context.Context, transaction *transactionState, identity ArtifactIdentity, file string, progress func(uint64)) ([]byte, error) {
	if transaction.localStore == "" {
		return manager.fetcher.Fetch(ctx, releaseFileURL(identity.ID, identity.Version, file), progress)
	}
	directory := localKindDirectory[identity.Kind]
	// id, version, and file are path segments of the derived location; the spec grammars bound them.
	if directory == "" {
		return nil, i18n.Errorf("install.fetch.localReferenceInvalid", nil)
	}
	if !platformspec.IsComponentID(identity.ID) || !platformspec.IsStrictSemver(identity.Version) || !platformspec.IsReleaseFile(file) {
		return nil, i18n.Errorf("install.fetch.localIdentityInvalid", map[string]string{"artifact": identity.key()})
	}
	releaseRoot := filepath.Join(transaction.localStore, directory, identity.ID, identity.Version)
	info, err := os.Lstat(releaseRoot)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, i18n.Errorf("install.fetch.localReleaseMissing", map[string]string{"artifact": identity.key()})
	}
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return nil, i18n.Errorf("install.fetch.localReleaseInvalid", map[string]string{"artifact": identity.key()})
	}
	asset := filepath.Join(releaseRoot, file)
	assetInfo, err := os.Lstat(asset)
	if err != nil || assetInfo.Mode()&os.ModeSymlink != 0 || !assetInfo.Mode().IsRegular() {
		return nil, i18n.Errorf("install.fetch.localAssetInvalid", map[string]string{"name": file})
	}
	body, err := os.ReadFile(asset)
	if err != nil {
		return nil, err
	}
	if progress != nil {
		progress(uint64(len(body)))
	}
	return body, nil
}
