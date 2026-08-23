//go:build !windows

package control

import (
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTheSocketIsReachableOnlyByItsOwner(t *testing.T) {
	// This socket answers every command the build has. Group or world access
	// would hand that to every process the user runs.
	path := filepath.Join(shortDir(t), "s.sock")
	listener, err := Listen(path)
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer func() { _ = listener.Close() }()

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if permissions := info.Mode().Perm(); permissions != 0o600 {
		t.Errorf("the socket is mode %o, want 600", permissions)
	}
}

func TestClosingTheOwnerRemovesTheSocketPath(t *testing.T) {
	path := filepath.Join(shortDir(t), "s.sock")
	listener, err := Listen(path)
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	if err := listener.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("released socket path remains: %v", err)
	}
	if err := listener.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
}

func TestClosingAnOldOwnerDoesNotRemoveAReplacement(t *testing.T) {
	path := filepath.Join(shortDir(t), "s.sock")
	listener, err := Listen(path)
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatalf("unlink socket: %v", err)
	}
	if err := os.WriteFile(path, []byte("replacement"), 0o600); err != nil {
		t.Fatalf("replacement: %v", err)
	}
	if err := listener.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if body, err := os.ReadFile(path); err != nil || string(body) != "replacement" {
		t.Fatalf("replacement changed: %q, %v", body, err)
	}
}

func TestASocketLeftByADeadProcessIsReplaced(t *testing.T) {
	// Refusing would make every crash need a manual cleanup before the
	// application could start again.
	path := filepath.Join(shortDir(t), "s.sock")
	first, err := net.Listen("unix", path)
	if err != nil {
		t.Fatalf("first listen: %v", err)
	}
	// Closing unbinds the address and leaves the file, which is exactly the
	// state a crash leaves behind.
	_ = first.Close()
	if _, err := os.Stat(path); err != nil {
		t.Skipf("this platform removed the socket file on close: %v", err)
	}

	listener, err := Listen(path)
	if err != nil {
		t.Fatalf("Listen over a dead socket: %v", err)
	}
	_ = listener.Close()
}

func TestALiveBackendIsNotEvicted(t *testing.T) {
	// The file is not what holds the address. Removing it and binding again
	// would leave two backends on one home, and the second would answer for
	// state the first still owns.
	path := filepath.Join(shortDir(t), "s.sock")
	first, err := Listen(path)
	if err != nil {
		t.Fatalf("first Listen: %v", err)
	}
	defer func() { _ = first.Close() }()
	go func() { _ = Serve(first, NewRegistry(), "com.soksak.test") }()

	_, err = Listen(path)
	if err == nil {
		t.Fatal("a second backend bound over a live one")
	}
	if !strings.Contains(err.Error(), path) {
		t.Errorf("the refusal did not name the address: %v", err)
	}
}

func TestSomethingThatIsNotASocketIsNotDeleted(t *testing.T) {
	// Whatever this is, this build cannot identify it, and removing a file it
	// cannot identify is not a recovery.
	path := filepath.Join(shortDir(t), "s.sock")
	if err := os.WriteFile(path, []byte("not a socket"), 0o600); err != nil {
		t.Fatalf("writing: %v", err)
	}

	if _, err := Listen(path); err == nil {
		t.Fatal("Listen bound over a regular file")
	}
	if _, err := os.Stat(path); err != nil {
		t.Errorf("the file was removed: %v", err)
	}
}

func TestAnOverlongPathFailsByNameRatherThanByErrno(t *testing.T) {
	// The kernel answers "invalid argument", which states nothing about paths and
	// sends the reader looking at the wrong thing.
	path := filepath.Join(shortDir(t), strings.Repeat("d", socketPathLimit), "s.sock")

	_, err := Listen(path)
	if err == nil {
		t.Fatal("an overlong socket path was accepted")
	}
	if !strings.Contains(err.Error(), "bytes") {
		t.Errorf("the refusal did not say the path was too long: %v", err)
	}
}
