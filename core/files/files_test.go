package files

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/soksak/soksak-core/core/control"
)

func args(t *testing.T, pairs map[string]any) control.Args {
	t.Helper()
	built := control.Args{}
	for name, value := range pairs {
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatalf("encoding argument %q: %v", name, err)
		}
		built[name] = encoded
	}
	return built
}

func TestEveryCommandRegistersOnceAsCore(t *testing.T) {
	registry := control.NewRegistry()
	Register(registry, Deps{})

	owners := map[string]control.Owner{}
	for _, served := range registry.Describe().Commands {
		owners[served.Name] = served.Owner
	}
	// Every one of these answers with no window, which is the whole reason the
	// group is core rather than framework.
	for _, name := range []string{
		"read_text_file", "write_text_file",
		"read_file_base64", "write_file_base64",
		"list_children", "shell_which",
		"watch_dir", "unwatch_dir",
	} {
		owner, served := owners[name]
		if !served {
			t.Errorf("%s is not registered", name)
			continue
		}
		if owner != control.OwnerCore {
			t.Errorf("%s is owned by %q, want core", name, owner)
		}
	}
	if len(owners) != 8 {
		t.Errorf("registered %d commands, want the assigned eight: %v", len(owners), owners)
	}
}

// Nothing in the package is global: two registries built from two Register
// calls answer from their own injected homes.
func TestTwoRegistriesKeepTheirOwnHomes(t *testing.T) {
	homeA, homeB := t.TempDir(), t.TempDir()
	write(t, filepath.Join(homeA, "only-a"), "x")
	write(t, filepath.Join(homeB, "only-b"), "x")

	registryA := control.NewRegistry()
	Register(registryA, Deps{UserHome: homeA})
	registryB := control.NewRegistry()
	Register(registryB, Deps{UserHome: homeB})

	fromA, err := registryA.Invoke("list_children", args(t, map[string]any{"path": nil}))
	if err != nil {
		t.Fatalf("listing A: %v", err)
	}
	fromB, err := registryB.Invoke("list_children", args(t, map[string]any{"path": nil}))
	if err != nil {
		t.Fatalf("listing B: %v", err)
	}
	if nameList(fromA.(ChildListing))[0] != "only-a" || nameList(fromB.(ChildListing))[0] != "only-b" {
		t.Errorf("the two builds share state: %v / %v", fromA, fromB)
	}
}

func TestAMissingPathFailsNamingTheArgument(t *testing.T) {
	registry := control.NewRegistry()
	Register(registry, Deps{})

	for _, name := range []string{"read_text_file", "read_file_base64", "watch_dir", "unwatch_dir"} {
		_, err := registry.Invoke(name, control.Args{})
		if err == nil {
			t.Errorf("%s answered with no path", name)
			continue
		}
		if !strings.Contains(err.Error(), "path") {
			t.Errorf("%s does not name the missing argument: %v", name, err)
		}
	}
	if _, err := registry.Invoke("shell_which", control.Args{}); err == nil || !strings.Contains(err.Error(), "bin") {
		t.Errorf("shell_which does not name the missing argument: %v", err)
	}
}

// A JS caller sends null for an unset optional. Treating that as a decode
// failure would make `read_text_file({path, offset: undefined})` — the ordinary
// first read — fail at the boundary.
func TestAnExplicitNullIsAbsenceNotADecodeError(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "log")
	write(t, path, "aaaa\nbbbb\n")

	registry := control.NewRegistry()
	Register(registry, Deps{})

	answer, err := registry.Invoke("read_text_file", args(t, map[string]any{"path": path, "offset": nil}))
	if err != nil {
		t.Fatalf("a null offset must read from the start: %v", err)
	}
	if answer.(TextData).Content != "aaaa\nbbbb\n" {
		t.Errorf("content = %q", answer.(TextData).Content)
	}

	fromOffset, err := registry.Invoke("read_text_file", args(t, map[string]any{"path": path, "offset": 5}))
	if err != nil {
		t.Fatalf("reading from an offset: %v", err)
	}
	if fromOffset.(TextData).Content != "bbbb\n" {
		t.Errorf("content = %q", fromOffset.(TextData).Content)
	}
}

func TestANullMetaIsAbsenceNotADecodeError(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "a"), "x")

	registry := control.NewRegistry()
	Register(registry, Deps{})

	answer, err := registry.Invoke("list_children", args(t, map[string]any{"path": dir, "meta": nil}))
	if err != nil {
		t.Fatalf("a null meta must list without stat: %v", err)
	}
	if answer.(ChildListing).Children[0].Modified != nil {
		t.Error("a null meta was read as true")
	}
}

// catalogFsWatch.ts reads `invoke<number>`, so the answer is a bare number and
// not an envelope.
func TestWatchAnswersABareNumber(t *testing.T) {
	backend := &fakeBackend{}
	clock := &fakeClock{}
	sink := &recorder{}
	registry := control.NewRegistry()
	Register(registry, Deps{Watch: backend, EmitChange: sink.emit, After: clock.After})

	first, err := registry.Invoke("watch_dir", args(t, map[string]any{"path": "/work"}))
	if err != nil {
		t.Fatalf("watching: %v", err)
	}
	if count, isNumber := first.(int); !isNumber || count != 1 {
		t.Errorf("watch_dir = %#v, want 1", first)
	}
	released, err := registry.Invoke("unwatch_dir", args(t, map[string]any{"path": "/work"}))
	if err != nil {
		t.Fatalf("releasing: %v", err)
	}
	if count, isNumber := released.(int); !isNumber || count != 0 {
		t.Errorf("unwatch_dir = %#v, want 0", released)
	}
}

// state/plugins.ts reads `invoke<boolean>`, so the answer is a bare bool.
func TestShellWhichAnswersABareBool(t *testing.T) {
	registry := control.NewRegistry()
	Register(registry, Deps{LoginShell: "/bin/sh", Run: &fakeRunner{outcome: Outcome{ExitCode: 0}}})

	answer, err := registry.Invoke("shell_which", args(t, map[string]any{"bin": "node"}))
	if err != nil {
		t.Fatalf("asking: %v", err)
	}
	if present, isBool := answer.(bool); !isBool || !present {
		t.Errorf("shell_which = %#v, want true", answer)
	}
}

// catalogCapture.ts reads w.path and w.bytes off the answer, and the field
// names are what cross the boundary — snake_case, matched to the live caller.
func TestABase64WriteCrossesTheBoundaryAsPathAndBytes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shot.png")
	registry := control.NewRegistry()
	Register(registry, Deps{})

	answer, err := registry.Invoke("write_file_base64", args(t, map[string]any{"path": path, "base64": "AAEC"}))
	if err != nil {
		t.Fatalf("writing: %v", err)
	}
	encoded, err := json.Marshal(answer)
	if err != nil {
		t.Fatalf("encoding: %v", err)
	}
	var crossed map[string]any
	if err := json.Unmarshal(encoded, &crossed); err != nil {
		t.Fatalf("decoding: %v", err)
	}
	if crossed["path"] != path {
		t.Errorf("path = %v", crossed["path"])
	}
	if crossed["bytes"] != float64(3) {
		t.Errorf("bytes = %v", crossed["bytes"])
	}
}

// plugins/api.ts reads data.total_bytes, so the tags are the contract.
func TestTheTextAnswerCrossesTheBoundaryInSnakeCase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "a.txt")
	write(t, path, "one\ntwo\n")
	registry := control.NewRegistry()
	Register(registry, Deps{})

	answer, err := registry.Invoke("read_text_file", args(t, map[string]any{"path": path}))
	if err != nil {
		t.Fatalf("reading: %v", err)
	}
	encoded, err := json.Marshal(answer)
	if err != nil {
		t.Fatalf("encoding: %v", err)
	}
	for _, key := range []string{`"content"`, `"truncated"`, `"read_bytes"`, `"total_bytes"`, `"line_count"`} {
		if !strings.Contains(string(encoded), key) {
			t.Errorf("%s is missing from %s", key, encoded)
		}
	}
}

func TestWriteTextAnswersNull(t *testing.T) {
	path := filepath.Join(t.TempDir(), "a.txt")
	registry := control.NewRegistry()
	Register(registry, Deps{})

	answer, err := registry.Invoke("write_text_file", args(t, map[string]any{"path": path, "content": "written"}))
	if err != nil {
		t.Fatalf("writing: %v", err)
	}
	if answer != nil {
		t.Errorf("write_text_file = %#v, want null", answer)
	}
	if got, readErr := os.ReadFile(path); readErr != nil || string(got) != "written" {
		t.Errorf("the file was not written: %q %v", got, readErr)
	}
}

// Go's json package treats null as a no-op for most destinations: no error, and
// the value keeps its zero. So a required argument sent as null used to decode
// to "" and travel on. The worst of those was write_text_file — "content": null
// truncated the named file to nothing and answered success, which is the user's
// file erased and reported as a save.
func TestARequiredArgumentSentAsNullIsRefusedRatherThanRead(t *testing.T) {
	dir := t.TempDir()
	existing := filepath.Join(dir, "notes.txt")
	write(t, existing, "the user's work")
	untouched := filepath.Join(dir, "shot.png")

	registry := control.NewRegistry()
	Register(registry, Deps{})

	if _, err := registry.Invoke("write_text_file", args(t, map[string]any{
		"path": existing, "content": nil,
	})); err == nil {
		t.Error("a null content was accepted")
	}
	if got := read(t, existing); got != "the user's work" {
		t.Errorf("the file now reads %q — a null content erased it", got)
	}

	for name, invocation := range map[string]control.Args{
		"read_text_file":    args(t, map[string]any{"path": nil}),
		"read_file_base64":  args(t, map[string]any{"path": nil}),
		"write_file_base64": args(t, map[string]any{"path": untouched, "base64": nil}),
		"list_children":     args(t, map[string]any{"path": dir, "meta": 7}),
		"shell_which":       args(t, map[string]any{"bin": nil}),
		"watch_dir":         args(t, map[string]any{"path": nil}),
		"unwatch_dir":       args(t, map[string]any{"path": nil}),
	} {
		if _, err := registry.Invoke(name, invocation); err == nil {
			t.Errorf("%s accepted an argument it cannot read", name)
		} else if !strings.Contains(err.Error(), "argument") {
			t.Errorf("%s does not name the argument: %v", name, err)
		}
	}
	if _, err := os.Stat(untouched); err == nil {
		t.Error("a null payload still created a file")
	}
}

// Deps.UserHome is one field in the wiring and the package header says passing
// the wrong one is a single mistake away. Every command that expands `~` has to
// be reached through the registry to see that Register hands the home down at
// all: calling the bodies directly, as the unit tests do, cannot show a handler
// that dropped it — and the symptom of a dropped home is not an error here but
// a refusal naming UserHome in a process that supplied one.
func TestEveryTildeCommandReachesTheInjectedHome(t *testing.T) {
	home := t.TempDir()
	write(t, filepath.Join(home, "notes.txt"), "in-home")
	if err := os.WriteFile(filepath.Join(home, "dot.png"), []byte{0, 1, 2}, 0o644); err != nil {
		t.Fatalf("preparing the fixture: %v", err)
	}
	work := filepath.Join(home, "work")
	if err := os.Mkdir(work, 0o755); err != nil {
		t.Fatalf("preparing the fixture: %v", err)
	}
	write(t, filepath.Join(work, "child.txt"), "x")
	resolvedWork, err := filepath.EvalSymlinks(work)
	if err != nil {
		t.Fatalf("preparing the fixture: %v", err)
	}

	backend := &fakeBackend{}
	registry := control.NewRegistry()
	Register(registry, Deps{
		UserHome:   home,
		Watch:      backend,
		EmitChange: (&recorder{}).emit,
		After:      (&fakeClock{}).After,
	})

	text, err := registry.Invoke("read_text_file", args(t, map[string]any{"path": "~/notes.txt"}))
	if err != nil {
		t.Fatalf("read_text_file: %v", err)
	}
	if text.(TextData).Content != "in-home" {
		t.Errorf("read_text_file read %q", text.(TextData).Content)
	}

	if _, err := registry.Invoke("write_text_file", args(t, map[string]any{
		"path": "~/written.txt", "content": "saved",
	})); err != nil {
		t.Fatalf("write_text_file: %v", err)
	}
	if got := read(t, filepath.Join(home, "written.txt")); got != "saved" {
		t.Errorf("write_text_file landed %q outside the injected home", got)
	}

	preview, err := registry.Invoke("read_file_base64", args(t, map[string]any{"path": "~/dot.png"}))
	if err != nil {
		t.Fatalf("read_file_base64: %v", err)
	}
	if preview.(FileData).Base64 != "AAEC" {
		t.Errorf("read_file_base64 = %q", preview.(FileData).Base64)
	}

	written, err := registry.Invoke("write_file_base64", args(t, map[string]any{
		"path": "~/shot.png", "base64": "AAEC",
	}))
	if err != nil {
		t.Fatalf("write_file_base64: %v", err)
	}
	if written.(WriteResult).Path != filepath.Join(home, "shot.png") {
		t.Errorf("write_file_base64 answered %q", written.(WriteResult).Path)
	}

	listing, err := registry.Invoke("list_children", args(t, map[string]any{"path": "~/work"}))
	if err != nil {
		t.Fatalf("list_children: %v", err)
	}
	if names := nameList(listing.(ChildListing)); !equal(names, []string{"child.txt"}) {
		t.Errorf("list_children = %v", names)
	}

	if _, err := registry.Invoke("watch_dir", args(t, map[string]any{"path": "~/work"})); err != nil {
		t.Fatalf("watch_dir: %v", err)
	}
	if !equal(backend.armed, []string{resolvedWork}) {
		t.Errorf("watch_dir armed %v, want %q", backend.armed, resolvedWork)
	}
	if _, err := registry.Invoke("unwatch_dir", args(t, map[string]any{"path": "~/work"})); err != nil {
		t.Fatalf("unwatch_dir: %v", err)
	}
	if !equal(backend.disarmed, []string{resolvedWork}) {
		t.Errorf("unwatch_dir disarmed %v, want %q", backend.disarmed, resolvedWork)
	}
}

// A build with nothing injected still registers every name and refuses each by
// what it needs, rather than answering a plausible value it cannot stand
// behind.
func TestAnUnwiredBuildRefusesByNameRatherThanAnsweringNothing(t *testing.T) {
	registry := control.NewRegistry()
	Register(registry, Deps{})

	for name, invocation := range map[string]control.Args{
		"shell_which": args(t, map[string]any{"bin": "node"}),
		"watch_dir":   args(t, map[string]any{"path": "/work"}),
	} {
		if _, err := registry.Invoke(name, invocation); err == nil {
			t.Errorf("%s answered in a build that cannot do it", name)
		}
	}
	if _, err := registry.Invoke("list_children", args(t, map[string]any{"path": nil})); err == nil {
		t.Error("list_children answered with no home injected")
	}
}
