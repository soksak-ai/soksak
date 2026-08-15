package files

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The extension is lowercased before the lookup, because a camera writes
// IMG_0001.JPG and the tree would otherwise hand the webview an
// octet-stream that renders as nothing.
func TestTheMimeComesFromTheExtensionCaseFolded(t *testing.T) {
	for path, want := range map[string]string{
		"/a/dot.PNG":     "image/png",
		"/a/dot.png":     "image/png",
		"/a/clip.MOV":    "video/quicktime",
		"/a/paper.pdf":   "application/pdf",
		"/a/x.unknown":   "application/octet-stream",
		"/a/no-ext":      "application/octet-stream",
		"/a/song.Flac":   "audio/flac",
		"/a/photo.jpeg":  "image/jpeg",
		"/a/vector.svg":  "image/svg+xml",
		"/a/movie.WEBM":  "video/webm",
		"/a/archive.tar": "application/octet-stream",
	} {
		if got := mimeFor(path); got != want {
			t.Errorf("mimeFor(%q) = %q, want %q", path, got, want)
		}
	}
}

func TestAPreviewCarriesPaddedStandardBase64(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dot.png")
	if err := os.WriteFile(path, []byte{0, 1, 2}, 0o644); err != nil {
		t.Fatalf("preparing the fixture: %v", err)
	}

	got, err := readBase64(path, "")
	if err != nil {
		t.Fatalf("reading: %v", err)
	}
	if got.Mime != "image/png" {
		t.Errorf("mime = %q", got.Mime)
	}
	if got.Base64 != "AAEC" {
		t.Errorf("base64 = %q, want AAEC", got.Base64)
	}
}

// The pair goes straight into a `data:` URL, so the alphabet and the padding
// are both contract, and neither is visible in the AAEC fixture above: three
// bytes need no padding and encode to characters the standard and url-safe
// alphabets share, so that fixture reads the same under either. These two bytes
// are the ones where the two alphabets differ (+/ against -_), and two bytes is
// the length that needs a =.
func TestAPreviewUsesTheStandardAlphabetAndKeepsThePadding(t *testing.T) {
	path := filepath.Join(t.TempDir(), "edge.png")
	if err := os.WriteFile(path, []byte{0xFB, 0xFF}, 0o644); err != nil {
		t.Fatalf("preparing the fixture: %v", err)
	}

	got, err := readBase64(path, "")
	if err != nil {
		t.Fatalf("reading: %v", err)
	}
	if got.Base64 != "+/8=" {
		t.Errorf("base64 = %q, want the standard alphabet with its padding", got.Base64)
	}
}

// A truncated PNG would reach the decoder and read as a decoder bug rather than
// as a limit, so the limit refuses by name and by size.
func TestOverThePreviewLimitIsRefusedByTheSize(t *testing.T) {
	path := filepath.Join(t.TempDir(), "huge.bin")
	if err := os.WriteFile(path, make([]byte, 9), 0o644); err != nil {
		t.Fatalf("preparing the fixture: %v", err)
	}

	if _, err := readBase64Limited(path, "", 9); err != nil {
		t.Fatalf("a file exactly at the limit must be read: %v", err)
	}
	_, err := readBase64Limited(path, "", 8)
	if err == nil {
		t.Fatal("a file over the limit must be refused rather than cut")
	}
	if !strings.Contains(err.Error(), "9") {
		t.Errorf("the refusal must name the size: %v", err)
	}
}

func TestThePreviewLimitIsTheOneWrittenDown(t *testing.T) {
	if maxPreviewBytes != 40_000_000 {
		t.Errorf("maxPreviewBytes = %d", maxPreviewBytes)
	}
}

// The measurement this command exists for, 2026-07-31: window.snapshot with a
// rect answered base64 and ignored `path` entirely — the caller got ok:true and
// there was no file. A silent ignore caused by a missing surface.
func TestABase64WriteAnswersThePathAndTheDecodedLength(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shot.png")

	got, err := writeBase64(path, "AAEC", "")
	if err != nil {
		t.Fatalf("writing: %v", err)
	}
	if got.Path != path {
		t.Errorf("path = %q, want the file that was written", got.Path)
	}
	if got.Bytes != 3 {
		t.Errorf("bytes = %d, want the decoded length", got.Bytes)
	}
	on, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("the file the answer names does not exist: %v", err)
	}
	if string(on) != string([]byte{0, 1, 2}) {
		t.Errorf("file = %v, want the decoded bytes", on)
	}
}

// The answer includes the resolved path so the caller can pass it straight back
// as a media path; `~/shot.png` would name nothing to a renderer.
func TestABase64WriteAnswersTheResolvedPath(t *testing.T) {
	home := t.TempDir()

	got, err := writeBase64("~/shot.png", "AAEC", home)
	if err != nil {
		t.Fatalf("writing: %v", err)
	}
	if got.Path != filepath.Join(home, "shot.png") {
		t.Errorf("path = %q, want the expanded path", got.Path)
	}
}

// Nothing is written on a decode failure. A zero-byte file left where the
// caller believes a PNG is turns a reported error into a corrupt artefact that
// outlives it.
func TestAnUndecodablePayloadLeavesNoFileBehind(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shot.png")

	_, err := writeBase64(path, "not base64!!", "")
	if err == nil {
		t.Fatal("an undecodable payload must be refused")
	}
	if !strings.Contains(err.Error(), "base64") {
		t.Errorf("the refusal must name the decode failure: %v", err)
	}
	if _, statErr := os.Stat(path); statErr == nil {
		t.Error("a file was left behind by a write that failed")
	}
}

// Refusing to expand `~` here would argue continuity of
// behaviour — backward compatibility, which this repository forbids, and there
// is no yesterday in a fresh port. One home rule for the whole package.
func TestTheBinaryReadSeesTheSameTildeAsTheTextRead(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, "dot.png"), []byte{0, 1, 2}, 0o644); err != nil {
		t.Fatalf("preparing the fixture: %v", err)
	}

	got, err := readBase64("~/dot.png", home)
	if err != nil {
		t.Fatalf("reading through the tilde: %v", err)
	}
	if got.Base64 != "AAEC" {
		t.Errorf("base64 = %q", got.Base64)
	}
}

func TestABinaryReadOfADirectoryIsNotAFile(t *testing.T) {
	dir := t.TempDir()

	_, err := readBase64(dir, "")
	if err == nil {
		t.Fatal("a directory is not a file")
	}
	if !strings.Contains(err.Error(), "not a file") {
		t.Errorf("the refusal must name it: %v", err)
	}
}
