package install

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"

	"github.com/soksak-ai/soksak-core/core/i18n"
	platformspec "github.com/soksak-ai/soksak-spec/go/platformspec"
)

type LocalRelease struct {
	Found  bool   `json:"found"`
	Body   string `json:"body,omitempty"`
	Size   uint64 `json:"size,omitempty"`
	SHA256 string `json:"sha256,omitempty"`
}

func ReadLocalRelease(store, kind, id, version string) (LocalRelease, error) {
	directory := localKindDirectory[kind]
	// id and version are path segments of the derived location; the spec grammars bound them.
	if !filepath.IsAbs(store) || directory == "" {
		return LocalRelease{}, i18n.Errorf("install.transaction.localStoreInvalid", nil)
	}
	if !platformspec.IsComponentID(id) || !platformspec.IsStrictSemver(version) {
		return LocalRelease{}, i18n.Errorf("install.fetch.localIdentityInvalid", map[string]string{"artifact": kind + ":" + id + "@" + version})
	}
	root := filepath.Join(filepath.Clean(store), directory, id, version)
	info, err := os.Lstat(root)
	if os.IsNotExist(err) {
		return LocalRelease{Found: false}, nil
	}
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return LocalRelease{}, i18n.Errorf("install.fetch.localReleaseInvalid", map[string]string{"artifact": kind + ":" + id + "@" + version})
	}
	path := filepath.Join(root, "release.json")
	file, err := os.Lstat(path)
	if err != nil || file.Mode()&os.ModeSymlink != 0 || !file.Mode().IsRegular() {
		return LocalRelease{}, i18n.Errorf("install.fetch.localAssetInvalid", map[string]string{"name": "release.json"})
	}
	body, err := os.ReadFile(path)
	if err != nil {
		return LocalRelease{}, err
	}
	// The document is validated as the spec defines it: a url key, or any other unknown key, is refused.
	release, err := platformspec.ParseReleaseManifest(body)
	if err != nil || release.Kind != kind || release.ID != id || release.Version != version {
		return LocalRelease{}, i18n.Errorf("install.fetch.localReleaseInvalid", map[string]string{"artifact": kind + ":" + id + "@" + version})
	}
	digest := sha256.Sum256(body)
	return LocalRelease{Found: true, Body: string(body), Size: uint64(len(body)), SHA256: hex.EncodeToString(digest[:])}, nil
}
