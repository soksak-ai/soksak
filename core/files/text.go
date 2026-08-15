package files

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// textReadLimit caps one text read.
//
// This number was set to match the editor's
// LARGE_FILE_HEAP_OPERATION_THRESHOLD and named two reasons: that pairing, and
// the webview/IPC transport. Half of that is gone — the editor is a plugin here
// and no such constant exists in this frontend — so the number is kept for the
// half that survives: Wails ships a command result as JSON through the webview
// bridge, so a whole huge file exists twice in memory before the caller sees a
// byte. The dead pairing is recorded rather than restated.
const textReadLimit int64 = 256 * 1024 * 1024

// TextData is one text read, as the caller receives it.
type TextData struct {
	Content   string `json:"content"`
	Truncated bool   `json:"truncated"`
	ReadBytes int64  `json:"read_bytes"`
	// TotalBytes is the whole file, not the window. Feeding it back as the next
	// offset is what makes a growing log readable in O(delta) with no polling.
	TotalBytes int64 `json:"total_bytes"`
	LineCount  int64 `json:"line_count"`
}

// readText reads a file as text.
func readText(path string, offset *int64, home string) (TextData, error) {
	return readTextLimited(path, offset, home, textReadLimit)
}

// readTextLimited is readText with the cap as a value, so the cap is checkable
// without a 256 MiB fixture.
func readTextLimited(path string, offset *int64, home string, limit int64) (TextData, error) {
	real, err := expand(path, home)
	if err != nil {
		return TextData{}, err
	}
	info, err := os.Stat(real)
	if err != nil {
		// The error already names the path. Absence is a failure here, unlike
		// scan.Directory: that answers what is installed, where nothing is a
		// real state; this answers one named file, and an empty document handed
		// to an editor that then saves erases a file the user believes exists.
		return TextData{}, fmt.Errorf("read_text_file: %w", err)
	}
	if info.IsDir() || !info.Mode().IsRegular() {
		return TextData{}, fmt.Errorf("not a file: %s", real)
	}
	total := info.Size()

	start := int64(0)
	if offset != nil && *offset > 0 {
		start = *offset
		if start > total {
			// The file shrank or was replaced. Clamping rather than failing
			// lets the caller see the real size and decide to re-read whole.
			start = total
		}
	}

	file, err := os.Open(real)
	if err != nil {
		return TextData{}, fmt.Errorf("read_text_file: %w", err)
	}
	defer func() { _ = file.Close() }()
	if start > 0 {
		if _, err := file.Seek(start, io.SeekStart); err != nil {
			return TextData{}, fmt.Errorf("read_text_file: %w", err)
		}
	}
	window, err := io.ReadAll(io.LimitReader(file, limit))
	if err != nil {
		return TextData{}, fmt.Errorf("read_text_file: %w", err)
	}

	if bytes.IndexByte(window, 0) >= 0 {
		// Text has no NUL. Only the read window is inspected, and only for NUL:
		// a stray high byte is ordinary in a legacy encoding, and refusing it
		// would make an editable file unopenable. The caller branches to
		// read_file_base64 on this name.
		return TextData{}, fmt.Errorf("binary file: %s", real)
	}

	read := int64(len(window))
	return TextData{
		// The bytes are kept as they are. Replacing invalid sequences on
		// the way in; encoding/json substitutes U+FFFD on the way out, so the
		// caller sees the same answer through one pass instead of two.
		Content:    string(window),
		Truncated:  total > start+read,
		ReadBytes:  read,
		TotalBytes: total,
		LineCount:  int64(bytes.Count(window, []byte{'\n'})),
	}, nil
}

// writeText saves a file whole.
//
// It does not lock. The store locks because app.data is our file and a single
// writer is its invariant; this path names someone else's file, where we hold
// no invariant to keep — the tree is already shared with the user's editor,
// git, and their build, and that set was never one writer. A lock would also be
// invisible to the only real competitor, so the rule is the OS's: per file, the
// last write wins.
//
// It does not write to a temp file and rename, which is the obvious Go reflex.
// Rename replaces the *path*, so saving through a symlinked dotfile would
// destroy the link and leave a regular file behind.
func writeText(path string, content string, home string) error {
	real, err := expand(path, home)
	if err != nil {
		return err
	}
	return writeBytes(real, []byte(content))
}

// writeBytes creates the missing parents and writes to an already-expanded
// path. A folder that does not exist yet is not an error, it is a state to
// make.
func writeBytes(path string, payload []byte) error {
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("could not create the parent folder %s: %w", dir, err)
		}
	}
	return os.WriteFile(path, payload, 0o644)
}
