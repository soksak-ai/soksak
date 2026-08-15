package files

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// maxPreviewBytes caps a preview read.
//
// Over it the command refuses by name and size rather than answering a prefix:
// a truncated PNG reaches the decoder and reads as a decoder bug, which sends
// the reader looking in the wrong place.
const maxPreviewBytes int64 = 40_000_000

// FileData is one binary read, as the caller receives it. The frontend builds a
// data URL from the pair, so the mime has to arrive with the bytes.
type FileData struct {
	Mime   string `json:"mime"`
	Base64 string `json:"base64"`
}

// WriteResult is what a binary write answers. It names the file so the caller
// can render or re-read it without reconstructing the path it sent.
type WriteResult struct {
	Path  string `json:"path"`
	Bytes int64  `json:"bytes"`
}

// mimeByExtension is data, not logic — an earlier build's table, carried over.
// It covers what a preview can render: images, PDF, video, audio.
var mimeByExtension = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
	".bmp":  "image/bmp",
	".ico":  "image/x-icon",
	".avif": "image/avif",
	".apng": "image/apng",
	".svg":  "image/svg+xml",
	".pdf":  "application/pdf",
	".mp4":  "video/mp4",
	".webm": "video/webm",
	".mov":  "video/quicktime",
	".m4v":  "video/x-m4v",
	".mkv":  "video/x-matroska",
	".ogv":  "video/ogg",
	".mp3":  "audio/mpeg",
	".wav":  "audio/wav",
	".ogg":  "audio/ogg",
	".flac": "audio/flac",
	".m4a":  "audio/mp4",
	".aac":  "audio/aac",
}

// mimeFor maps an extension to a media type.
//
// The extension is lowercased first: a camera writes IMG_0001.JPG, and an
// octet-stream answer for it renders as nothing at all.
func mimeFor(path string) string {
	if mime, known := mimeByExtension[strings.ToLower(filepath.Ext(path))]; known {
		return mime
	}
	return "application/octet-stream"
}

// readBase64 reads a file for preview.
//
// An earlier build refused to expand `~` here and argued continuity of
// behaviour. That is backward compatibility, which this repository forbids, and
// a fresh port has no yesterday to be continuous with — so the package has one
// home rule. A per-command tilde exception surfaces only as a file "missing"
// that is plainly there.
func readBase64(path string, home string) (FileData, error) {
	return readBase64Limited(path, home, maxPreviewBytes)
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
		return FileData{}, fmt.Errorf("not a file: %s", real)
	}
	if info.Size() > limit {
		return FileData{}, fmt.Errorf("preview limit exceeded: %d bytes", info.Size())
	}
	payload, err := os.ReadFile(real)
	if err != nil {
		return FileData{}, fmt.Errorf("read_file_base64: %w", err)
	}
	return FileData{
		Mime: mimeFor(real),
		// Standard alphabet, padded — what a data: URL and every browser
		// decoder expect.
		Base64: base64.StdEncoding.EncodeToString(payload),
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
