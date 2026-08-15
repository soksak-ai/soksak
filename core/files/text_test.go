package files

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func at(offset int64) *int64 { return &offset }

func TestATextFileCarriesItsSizeAndLineCount(t *testing.T) {
	path := filepath.Join(t.TempDir(), "a.txt")
	write(t, path, "one\ntwo\n")

	got, err := readText(path, nil, "")
	if err != nil {
		t.Fatalf("reading: %v", err)
	}
	if got.Content != "one\ntwo\n" {
		t.Errorf("content = %q", got.Content)
	}
	if got.TotalBytes != 8 || got.ReadBytes != 8 {
		t.Errorf("read %d of %d bytes, want 8 of 8", got.ReadBytes, got.TotalBytes)
	}
	if got.LineCount != 2 {
		t.Errorf("line_count = %d, want 2", got.LineCount)
	}
	if got.Truncated {
		t.Error("a whole file is not truncated")
	}
}

// The offset axis is what makes a growing log readable without polling: the
// caller feeds total_bytes back as the next offset and reads O(delta).
func TestAnOffsetReadsOnlyTheDeltaAndStillReportsTheWholeSize(t *testing.T) {
	path := filepath.Join(t.TempDir(), "log")
	write(t, path, "aaaa\nbbbb\n")

	got, err := readText(path, at(5), "")
	if err != nil {
		t.Fatalf("reading: %v", err)
	}
	if got.Content != "bbbb\n" {
		t.Errorf("content = %q, want only the delta", got.Content)
	}
	if got.ReadBytes != 5 {
		t.Errorf("read_bytes = %d, want 5", got.ReadBytes)
	}
	if got.TotalBytes != 10 {
		t.Errorf("total_bytes = %d, want the whole file", got.TotalBytes)
	}
}

// A log that was rotated or replaced is shorter than the offset the caller
// remembers. Answering `truncated` there would leave the caller believing there
// is more to read forever; the real size is what tells it to start over.
func TestAnOffsetPastTheEndReadsEmptyWithTheRealSize(t *testing.T) {
	path := filepath.Join(t.TempDir(), "log")
	write(t, path, "ab")

	got, err := readText(path, at(99), "")
	if err != nil {
		t.Fatalf("reading: %v", err)
	}
	if got.Content != "" {
		t.Errorf("content = %q, want empty", got.Content)
	}
	if got.TotalBytes != 2 {
		t.Errorf("total_bytes = %d, want the real size", got.TotalBytes)
	}
	if got.Truncated {
		t.Error("everything there was to read was read — that is not truncation")
	}
}

// Absence and "not a file" are different answers. scan.Directory answers
// absence with an empty list because it reports what is installed; this command
// reports one named file, and an empty document handed to an editor that then
// saves would erase a file the user believes exists.
func TestAMissingFileAndADirectoryFailDifferently(t *testing.T) {
	dir := t.TempDir()

	_, missing := readText(filepath.Join(dir, "nope.txt"), nil, "")
	if missing == nil {
		t.Fatal("a missing file must fail rather than read as empty")
	}
	if !strings.Contains(missing.Error(), "nope.txt") {
		t.Errorf("the refusal does not name the path: %v", missing)
	}

	_, notFile := readText(dir, nil, "")
	if notFile == nil {
		t.Fatal("a directory is not a file")
	}
	if !strings.Contains(notFile.Error(), "not a file") {
		t.Errorf("a directory must be refused as not a file: %v", notFile)
	}
	if missing.Error() == notFile.Error() {
		t.Error("absence and not-a-file collapsed into one answer")
	}
}

// The caller branches to read_file_base64 on this refusal, so it has to be
// distinguishable from every other failure.
func TestABinaryFileIsRefusedByName(t *testing.T) {
	path := filepath.Join(t.TempDir(), "b.bin")
	if err := os.WriteFile(path, []byte{0, 1}, 0o644); err != nil {
		t.Fatalf("preparing the fixture: %v", err)
	}

	_, err := readText(path, nil, "")
	if err == nil {
		t.Fatal("a NUL byte means binary")
	}
	if !strings.Contains(err.Error(), "binary file") {
		t.Errorf("the refusal must name binary: %v", err)
	}
}

// Only the read window is inspected, and only for NUL. A stray high byte is
// ordinary in a text file written in a legacy encoding; refusing it would make
// the editor unable to open files it can plainly repair.
func TestAStrayNonUTF8ByteWithoutNULStillReads(t *testing.T) {
	path := filepath.Join(t.TempDir(), "latin.txt")
	if err := os.WriteFile(path, []byte{'c', 'a', 'f', 0x80, '\n'}, 0o644); err != nil {
		t.Fatalf("preparing the fixture: %v", err)
	}

	got, err := readText(path, nil, "")
	if err != nil {
		t.Fatalf("a file without NUL must read: %v", err)
	}
	if got.ReadBytes != 5 {
		t.Errorf("read_bytes = %d, want 5", got.ReadBytes)
	}
	// Rust replaced the byte on the way in (from_utf8_lossy); Go keeps it and
	// encoding/json substitutes U+FFFD on the way out. The caller sees the same
	// answer through one pass instead of two — pinned here rather than assumed.
	encoded, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("encoding: %v", err)
	}
	if !strings.Contains(string(encoded), "\"content\":\"caf\\ufffd\\n\"") {
		t.Errorf("the invalid byte did not become U+FFFD at the boundary: %s", encoded)
	}
}

// The cap exists for the transport: Wails ships command results as JSON through
// the webview bridge, so a whole huge file would be built in memory twice.
// Exercised through the limit parameter, because a 256 MiB fixture would make
// the rule cost a minute to check.
func TestOverTheLimitReadsThePrefixAndSaysSo(t *testing.T) {
	path := filepath.Join(t.TempDir(), "big.txt")
	write(t, path, "abcdefghij")

	got, err := readTextLimited(path, nil, "", 4)
	if err != nil {
		t.Fatalf("reading: %v", err)
	}
	if got.Content != "abcd" {
		t.Errorf("content = %q, want the first four bytes", got.Content)
	}
	if got.ReadBytes != 4 || got.TotalBytes != 10 {
		t.Errorf("read %d of %d, want 4 of 10", got.ReadBytes, got.TotalBytes)
	}
	if !got.Truncated {
		t.Error("a capped read must say it was capped")
	}
}

func TestTheTextLimitIsTheOneWrittenDown(t *testing.T) {
	// An earlier build paired this number with the editor's
	// LARGE_FILE_HEAP_OPERATION_THRESHOLD. That constant no longer exists here
	// — the editor is a plugin — so only the transport half of the reason
	// survives, and the number stays in one place.
	if textReadLimit != 256*1024*1024 {
		t.Errorf("textReadLimit = %d", textReadLimit)
	}
}

func TestASecondShorterWriteReplacesTheWholeFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "edit.txt")

	if err := writeText(path, "first\nedit", ""); err != nil {
		t.Fatalf("writing: %v", err)
	}
	if got := read(t, path); got != "first\nedit" {
		t.Fatalf("content = %q", got)
	}
	// The re-save case. A write that did not truncate leaves the tail of the
	// longer version behind, which reads as a file the user did not write.
	if err := writeText(path, "x", ""); err != nil {
		t.Fatalf("re-writing: %v", err)
	}
	if got := read(t, path); got != "x" {
		t.Errorf("content = %q, want the whole file replaced", got)
	}
}

// A folder that does not exist yet is not an error, it is a state to make.
func TestAWriteCreatesMissingParents(t *testing.T) {
	path := filepath.Join(t.TempDir(), "a", "b", "c.txt")

	if err := writeText(path, "deep", ""); err != nil {
		t.Fatalf("writing: %v", err)
	}
	if got := read(t, path); got != "deep" {
		t.Errorf("content = %q", got)
	}
}

// The obvious Go "improvement" here is a temp file plus rename. It is wrong:
// rename replaces the *path*, so saving a symlinked dotfile would destroy the
// link and leave a regular file where the user had a link into their dotfiles
// repository. Plain truncate-write keeps the OS semantics the tree already has.
func TestAWriteThroughASymlinkWritesTheTargetAndKeepsTheLink(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "real.txt")
	link := filepath.Join(dir, "link.txt")
	write(t, target, "before")
	if err := os.Symlink(target, link); err != nil {
		t.Fatalf("preparing the fixture: %v", err)
	}

	if err := writeText(link, "after", ""); err != nil {
		t.Fatalf("writing through the link: %v", err)
	}
	if got := read(t, target); got != "after" {
		t.Errorf("the target was not written: %q", got)
	}
	info, err := os.Lstat(link)
	if err != nil {
		t.Fatalf("stat of the link: %v", err)
	}
	if info.Mode()&os.ModeSymlink == 0 {
		t.Error("the write replaced the link with a regular file")
	}
}

// This surface is the user browsing their own disk. Refusing links here — the
// rule installers need, where a planted link redirects a write — would make a
// symlinked working folder fail to open at all.
func TestAReadThroughASymlinkedDirectorySucceeds(t *testing.T) {
	dir := t.TempDir()
	real := filepath.Join(dir, "real")
	if err := os.MkdirAll(real, 0o755); err != nil {
		t.Fatalf("preparing the fixture: %v", err)
	}
	write(t, filepath.Join(real, "f.txt"), "through")
	if err := os.Symlink(real, filepath.Join(dir, "link")); err != nil {
		t.Fatalf("preparing the fixture: %v", err)
	}

	got, err := readText(filepath.Join(dir, "link", "f.txt"), nil, "")
	if err != nil {
		t.Fatalf("reading through the link: %v", err)
	}
	if got.Content != "through" {
		t.Errorf("content = %q", got.Content)
	}
}

// One home rule for the whole package: the read and the write see the same
// tilde. A per-command exception shows up as a file "missing" that is plainly
// there.
func TestTheTildeIsTheSameOnReadAndWrite(t *testing.T) {
	home := t.TempDir()

	if err := writeText("~/notes.txt", "hello", home); err != nil {
		t.Fatalf("writing: %v", err)
	}
	if got := read(t, filepath.Join(home, "notes.txt")); got != "hello" {
		t.Errorf("the write did not land under the injected home: %q", got)
	}
	got, err := readText("~/notes.txt", nil, home)
	if err != nil {
		t.Fatalf("reading: %v", err)
	}
	if got.Content != "hello" {
		t.Errorf("content = %q", got.Content)
	}
}

func write(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("preparing the fixture: %v", err)
	}
}

func read(t *testing.T, path string) string {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading the fixture back: %v", err)
	}
	return string(got)
}
