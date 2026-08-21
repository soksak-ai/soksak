package install

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/soksak/soksak-core/core/i18n"
)

const (
	archiveMaxFiles        = 10000
	archiveMaxFileBytes    = 256 << 20
	archiveMaxTotalBytes   = 1 << 30
	archiveMaxPathBytes    = 512
	archiveMaxSegmentBytes = 255
)

type Fetcher interface {
	Fetch(context.Context, string) ([]byte, error)
}

type UnitIdentity struct {
	Kind    string `json:"kind"`
	ID      string `json:"id"`
	Version string `json:"version"`
}

func (unit UnitIdentity) key() string { return unit.Kind + ":" + unit.ID + "@" + unit.Version }

type Artifact struct {
	URL         string   `json:"url"`
	SHA256      string   `json:"sha256"`
	Format      string   `json:"format"`
	Entrypoints []string `json:"entrypoints"`
}

type StageRequest struct {
	TransactionID string
	RegistryID    string
	Unit          UnitIdentity
	Artifact      Artifact
}

type Transaction struct {
	TransactionID string `json:"transactionId"`
}

type StagedArtifact struct {
	Handle              string   `json:"handle"`
	SHA256              string   `json:"sha256"`
	Extraction          string   `json:"extraction"`
	VerifiedEntrypoints []string `json:"verifiedEntrypoints"`
}

type transactionState struct {
	registryID string
	root       UnitIdentity
	handles    map[string]stagedState
}

type stagedState struct {
	path   string
	unit   UnitIdentity
	sha256 string
}

type TransactionManager struct {
	mu           sync.Mutex
	root         string
	fetcher      Fetcher
	transactions map[string]*transactionState
}

func NewTransactionManager(root string, fetcher Fetcher) *TransactionManager {
	return &TransactionManager{root: root, fetcher: fetcher, transactions: map[string]*transactionState{}}
}

func (manager *TransactionManager) Begin(registryID string, root UnitIdentity) (Transaction, error) {
	if manager.fetcher == nil {
		return Transaction{}, i18n.Errorf("install.transaction.noFetcher", nil)
	}
	if registryID == "" || root.Kind == "" || root.ID == "" || root.Version == "" {
		return Transaction{}, i18n.Errorf("install.transaction.identityRequired", nil)
	}
	id, err := randomID()
	if err != nil {
		return Transaction{}, err
	}
	path := filepath.Join(manager.root, id)
	if err := os.MkdirAll(path, 0o700); err != nil {
		return Transaction{}, fmt.Errorf("create install transaction: %w", err)
	}
	manager.mu.Lock()
	manager.transactions[id] = &transactionState{registryID: registryID, root: root, handles: map[string]stagedState{}}
	manager.mu.Unlock()
	return Transaction{TransactionID: id}, nil
}

func (manager *TransactionManager) Stage(ctx context.Context, request StageRequest) (StagedArtifact, error) {
	manager.mu.Lock()
	transaction := manager.transactions[request.TransactionID]
	manager.mu.Unlock()
	if transaction == nil {
		return StagedArtifact{}, i18n.Errorf("install.transaction.notFound", map[string]string{"id": request.TransactionID})
	}
	if request.RegistryID != transaction.registryID {
		return StagedArtifact{}, i18n.Errorf("install.transaction.registryMismatch", nil)
	}
	if request.Artifact.Format != "tgz" && request.Artifact.Format != "tar.gz" {
		return StagedArtifact{}, i18n.Errorf("install.transaction.unsupportedFormat", map[string]string{"format": request.Artifact.Format})
	}
	body, err := manager.fetcher.Fetch(ctx, request.Artifact.URL)
	if err != nil {
		return StagedArtifact{}, fmt.Errorf("fetch artifact: %w", err)
	}
	digest := sha256Hex(body)
	if digest != request.Artifact.SHA256 {
		return StagedArtifact{}, i18n.Errorf("install.transaction.digestMismatch", map[string]string{"digest": digest})
	}
	handle, err := randomID()
	if err != nil {
		return StagedArtifact{}, err
	}
	destination := filepath.Join(manager.root, request.TransactionID, handle)
	if err := os.MkdirAll(destination, 0o700); err != nil {
		return StagedArtifact{}, err
	}
	if err := extractTGZ(body, destination); err != nil {
		_ = os.RemoveAll(destination)
		return StagedArtifact{}, err
	}
	verified := make([]string, 0, len(request.Artifact.Entrypoints))
	for _, entrypoint := range request.Artifact.Entrypoints {
		if !safeArchivePath(entrypoint) {
			_ = os.RemoveAll(destination)
			return StagedArtifact{}, i18n.Errorf("install.transaction.entrypointUnsafe", map[string]string{"path": entrypoint})
		}
		info, err := os.Lstat(filepath.Join(destination, filepath.FromSlash(entrypoint)))
		if err != nil || !info.Mode().IsRegular() {
			_ = os.RemoveAll(destination)
			return StagedArtifact{}, i18n.Errorf("install.transaction.entrypointNotRegular", map[string]string{"path": entrypoint})
		}
		verified = append(verified, entrypoint)
	}
	manager.mu.Lock()
	if manager.transactions[request.TransactionID] == nil {
		manager.mu.Unlock()
		_ = os.RemoveAll(destination)
		return StagedArtifact{}, i18n.Errorf("install.transaction.ended", nil)
	}
	transaction.handles[handle] = stagedState{path: destination, unit: request.Unit, sha256: digest}
	manager.mu.Unlock()
	return StagedArtifact{Handle: handle, SHA256: digest, Extraction: "regular-files-only", VerifiedEntrypoints: verified}, nil
}

func (manager *TransactionManager) ReadUTF8(transactionID, handle, path string) (string, error) {
	if !safeArchivePath(path) {
		return "", i18n.Errorf("install.transaction.stagedPathUnsafe", map[string]string{"path": path})
	}
	manager.mu.Lock()
	transaction := manager.transactions[transactionID]
	var root string
	if transaction != nil {
		root = transaction.handles[handle].path
	}
	manager.mu.Unlock()
	if root == "" {
		return "", i18n.Errorf("install.transaction.stagedNotFound", nil)
	}
	info, err := os.Lstat(filepath.Join(root, filepath.FromSlash(path)))
	if err != nil || !info.Mode().IsRegular() {
		return "", i18n.Errorf("install.transaction.stagedNotRegular", map[string]string{"path": path})
	}
	body, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(path)))
	if err != nil {
		return "", err
	}
	if !utf8.Valid(body) {
		return "", i18n.Errorf("install.transaction.stagedNotUTF8", map[string]string{"path": path})
	}
	return string(body), nil
}

func (manager *TransactionManager) staged(transactionID, handle string) (stagedState, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	transaction := manager.transactions[transactionID]
	if transaction == nil {
		return stagedState{}, i18n.Errorf("install.transaction.notFound", map[string]string{"id": transactionID})
	}
	state, found := transaction.handles[handle]
	if !found {
		return stagedState{}, i18n.Errorf("install.transaction.stagedNotFound", nil)
	}
	return state, nil
}

func (manager *TransactionManager) Rollback(transactionID string) error {
	manager.mu.Lock()
	if manager.transactions[transactionID] == nil {
		manager.mu.Unlock()
		return i18n.Errorf("install.transaction.notFound", map[string]string{"id": transactionID})
	}
	delete(manager.transactions, transactionID)
	manager.mu.Unlock()
	return os.RemoveAll(filepath.Join(manager.root, transactionID))
}

func extractTGZ(body []byte, destination string) error {
	gzipReader, err := gzip.NewReader(bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("open tgz: %w", err)
	}
	defer gzipReader.Close()
	tarReader := tar.NewReader(gzipReader)
	files := 0
	var total int64
	for {
		header, err := tarReader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("read tgz: %w", err)
		}
		if !safeArchivePath(header.Name) {
			return i18n.Errorf("install.transaction.archivePathUnsafe", map[string]string{"path": header.Name})
		}
		if header.Typeflag != tar.TypeReg && header.Typeflag != tar.TypeDir {
			return i18n.Errorf("install.transaction.archiveEntryType", map[string]string{"path": header.Name})
		}
		path := filepath.Join(destination, filepath.FromSlash(header.Name))
		if header.Typeflag == tar.TypeDir {
			if err := os.MkdirAll(path, 0o755); err != nil {
				return err
			}
			continue
		}
		files++
		total += header.Size
		if files > archiveMaxFiles || header.Size < 0 || header.Size > archiveMaxFileBytes || total > archiveMaxTotalBytes {
			return i18n.Errorf("install.transaction.archiveLimit", nil)
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return err
		}
		file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, os.FileMode(header.Mode)&0o755)
		if err != nil {
			return fmt.Errorf("create archive file %s: %w", header.Name, err)
		}
		_, copyErr := io.CopyN(file, tarReader, header.Size)
		closeErr := file.Close()
		if copyErr != nil {
			return fmt.Errorf("extract archive file %s: %w", header.Name, copyErr)
		}
		if closeErr != nil {
			return closeErr
		}
	}
	return nil
}

var windowsReserved = regexp.MustCompile(`^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$`)

func safeArchivePath(path string) bool {
	if path == "" || len(path) > archiveMaxPathBytes || strings.HasPrefix(path, "/") || strings.Contains(path, "\\") {
		return false
	}
	for _, segment := range strings.Split(path, "/") {
		if segment == "" || segment == "." || segment == ".." || len(segment) > archiveMaxSegmentBytes || strings.HasSuffix(segment, " ") || strings.HasSuffix(segment, ".") || strings.ContainsAny(segment, `<>:"|?*`) || windowsReserved.MatchString(strings.ToUpper(segment)) {
			return false
		}
		for _, value := range []byte(segment) {
			if value < 0x20 || value > 0x7e {
				return false
			}
		}
	}
	return true
}

func randomID() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw), nil
}
func sha256Hex(body []byte) string {
	digest := sha256.Sum256(body)
	return hex.EncodeToString(digest[:])
}
