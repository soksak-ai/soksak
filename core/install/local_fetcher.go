package install

import (
	"context"
	"errors"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"

	"github.com/soksak-ai/soksak-core/core/i18n"
)

var localKindDirectory = map[string]string{"plugin": "plugins", "sidecar": "sidecars"}

func (manager *TransactionManager) fetchArtifact(ctx context.Context, transaction *transactionState, identity ArtifactIdentity, remote string, progress func(uint64)) ([]byte, error) {
	if transaction.localStore == "" {
		return manager.fetcher.Fetch(ctx, remote, progress)
	}
	directory := localKindDirectory[identity.Kind]
	parsed, err := url.Parse(remote)
	if directory == "" || err != nil || parsed.Scheme != "https" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, i18n.Errorf("install.fetch.localReferenceInvalid", nil)
	}
	name := filepath.Base(parsed.Path)
	if name == "" || name == "." {
		return nil, i18n.Errorf("install.fetch.localReferenceInvalid", nil)
	}
	releaseRoot := filepath.Join(transaction.localStore, directory, identity.ID, identity.Version)
	info, err := os.Lstat(releaseRoot)
	if errors.Is(err, fs.ErrNotExist) {
		if identity == transaction.root {
			return nil, i18n.Errorf("install.fetch.localReleaseMissing", map[string]string{"artifact": identity.key()})
		}
		return manager.fetcher.Fetch(ctx, remote, progress)
	}
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return nil, i18n.Errorf("install.fetch.localReleaseInvalid", map[string]string{"artifact": identity.key()})
	}
	asset := filepath.Join(releaseRoot, name)
	assetInfo, err := os.Lstat(asset)
	if err != nil || assetInfo.Mode()&os.ModeSymlink != 0 || !assetInfo.Mode().IsRegular() {
		return nil, i18n.Errorf("install.fetch.localAssetInvalid", map[string]string{"name": name})
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
