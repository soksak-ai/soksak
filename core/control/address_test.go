package control

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSocketPathIsTheOneTheLauncherClaimed(t *testing.T) {
	// Not derived. A second derivation of "where does this installation live"
	// drifts from the first, and the caller reading the wrong one starts an
	// agent that succeeds against a neighbouring installation.
	registry := NewRegistry()
	Register(registry, Deps{Socket: "/tmp/user/.soksak-dev/com.soksak.dev.sock"})

	answer, err := registry.Invoke(commandSocketPath, Args{})
	if err != nil {
		t.Fatalf("ipc_socket_path: %v", err)
	}
	if answer != "/tmp/user/.soksak-dev/com.soksak.dev.sock" {
		t.Errorf("socket path = %v", answer)
	}
}

func TestNoSocketIsRefusedRatherThanAnsweredEmpty(t *testing.T) {
	// An empty string would reach the caller as a path, and the agent spawned
	// with it would bind SOKSAK_SOCKET="" and fail somewhere else entirely.
	registry := NewRegistry()
	Register(registry, Deps{})

	if _, err := registry.Invoke(commandSocketPath, Args{}); err == nil {
		t.Fatal("a process that was told no socket must not answer one")
	} else if !strings.Contains(err.Error(), "which socket") {
		t.Errorf("the refusal reads %q", err)
	}
}

func TestClientDirectoryIsAnsweredOnlyWhenTheClientIsThere(t *testing.T) {
	directory := t.TempDir()
	registry := NewRegistry()
	Register(registry, Deps{CLIDir: directory, CLIName: "sok-dev"})

	// The client has not been built yet.
	_, err := registry.Invoke(commandCLIDir, Args{})
	if err == nil {
		t.Fatal("a directory that does not hold the client must not be answered")
	}
	if !strings.Contains(err.Error(), filepath.Join(directory, "sok-dev")) {
		t.Errorf("the failure reads %q and does not carry the path that was searched", err)
	}

	// Built while the application is already running: the answer is asked per
	// call, so it is found now.
	if err := os.WriteFile(filepath.Join(directory, "sok-dev"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatalf("writing the client binary: %v", err)
	}
	answer, err := registry.Invoke(commandCLIDir, Args{})
	if err != nil {
		t.Fatalf("ipc_cli_dir after the client was built: %v", err)
	}
	if answer != directory {
		t.Errorf("client directory = %v, want %s", answer, directory)
	}
}

func TestADirectoryWhereTheClientShouldBeIsNotTheClient(t *testing.T) {
	directory := t.TempDir()
	if err := os.Mkdir(filepath.Join(directory, "sok"), 0o755); err != nil {
		t.Fatalf("making the decoy: %v", err)
	}
	registry := NewRegistry()
	Register(registry, Deps{CLIDir: directory, CLIName: "sok"})

	if _, err := registry.Invoke(commandCLIDir, Args{}); err == nil {
		t.Fatal("a directory named like the client is not the client")
	} else if !strings.Contains(err.Error(), "is a directory") {
		t.Errorf("the failure reads %q", err)
	}
}

func TestAnUnnamedClientIsRefusedByWhichHalfIsMissing(t *testing.T) {
	// Two different wiring mistakes. A caller told only "unserved" cannot tell
	// which field the launcher left empty.
	noDirectory := NewRegistry()
	Register(noDirectory, Deps{CLIName: "sok"})
	if _, err := noDirectory.Invoke(commandCLIDir, Args{}); err == nil ||
		!strings.Contains(err.Error(), "which directory") {
		t.Errorf("a missing directory refuses with %v", err)
	}

	noName := NewRegistry()
	Register(noName, Deps{CLIDir: t.TempDir()})
	if _, err := noName.Invoke(commandCLIDir, Args{}); err == nil ||
		!strings.Contains(err.Error(), "what its client binary is called") {
		t.Errorf("a missing client name refuses with %v", err)
	}
}
