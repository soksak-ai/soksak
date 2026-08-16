package files

import (
	"encoding/base64"
	"fmt"
	"os"
	"strconv"

	"github.com/soksak/soksak-core/core/i18n"
)

// maxReadBytes caps one base64 read.
//
// Over it the command refuses by name and size rather than answering a prefix:
// a truncated PNG arrives at the decoder and reads as a decoder bug, which sends
// the reader looking in the wrong place.
const maxReadBytes int64 = 40_000_000

// FileData is one binary read, as the caller receives it.
//
// Bytes and their size, and no media type. The core held a table of 24
// extensions until 2026-08-16 and answered application/octet-stream for
// everything else, which meant a plugin for a format outside that list had to
// edit the core to be answered — the missing capability A9 names, and C6's
// second question failing outright.
//
// What a file *is* is answered by whoever renders it — an editor for its
// languages, an image plugin for its formats, an HWP plugin for one. The caller
// states the type it already holds; this reads the bytes and validates the path,
// which is the part that cannot leave the process that owns the disk.
type FileData struct {
	Base64 string `json:"base64"`
	Bytes  int64  `json:"bytes"`
}

// WriteResult is what a binary write answers. It names the file so the caller
// can render or re-read it without reconstructing the path it sent.
type WriteResult struct {
	Path  string `json:"path"`
	Bytes int64  `json:"bytes"`
}

// readBase64 reads a file as bytes.
//
// Refusing to expand `~` here and arguing continuity of
// behaviour would be backward compatibility, which this repository forbids, and
// a fresh port has no yesterday to be continuous with — so the package has one
// home rule. A per-command tilde exception surfaces only as a file "missing"
// that is plainly there.
func readBase64(path string, home string) (FileData, error) {
	return readBase64Limited(path, home, maxReadBytes)
}

// readBase64Limited is readBase64 with the cap as a value, so the cap is
// checkable without a 40 MB fixture.
func readBase64Limited(path string, home string, limit int64) (FileData, error) {
	real, err := expand(path, home)
	if err != nil {
		return FileData{}, err
	}
	info, err := os.Stat(real)
	if err != nil {
		return FileData{}, fmt.Errorf("read_file_base64: %w", err)
	}
	if info.IsDir() || !info.Mode().IsRegular() {
		return FileData{}, i18n.Errorf("files.readBase64.notAFile", map[string]string{"path": real})
	}
	if info.Size() > limit {
		return FileData{}, i18n.Errorf("files.readBase64.sizeLimit", map[string]string{
			"bytes": strconv.FormatInt(info.Size(), 10),
		})
	}
	payload, err := os.ReadFile(real)
	if err != nil {
		return FileData{}, fmt.Errorf("read_file_base64: %w", err)
	}
	return FileData{
		// Standard alphabet, padded — what a data: URL and every browser
		// decoder expect.
		Base64: base64.StdEncoding.EncodeToString(payload),
		Bytes:  info.Size(),
	}, nil
}

// writeBase64 saves binary that arrived as base64 — the symmetry of
// readBase64.
//
// Without this surface, whatever produced binary had no way to leave it on
// disk. Measured 2026-07-31: window.snapshot with a rect answered base64 and
// ignored `path` entirely — the caller got ok:true and there was no file. A
// silent ignore caused by a missing surface.
func writeBase64(path string, payload string, home string) (WriteResult, error) {
	real, err := expand(path, home)
	if err != nil {
		return WriteResult{}, err
	}
	// Decoded before anything is created. A zero-byte file left where the
	// caller believes a PNG is outlives the error it reported.
	decoded, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		return WriteResult{}, fmt.Errorf("base64 decode failed: %w", err)
	}
	if err := writeBytes(real, decoded); err != nil {
		return WriteResult{}, err
	}
	// The resolved path, not the one that was sent: the caller hands this
	// straight to a renderer as a media path, and `~/shot.png` names nothing
	// there.
	return WriteResult{Path: real, Bytes: int64(len(decoded))}, nil
}
