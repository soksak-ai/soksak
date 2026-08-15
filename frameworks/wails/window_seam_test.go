package wails

import (
	"os"
	"strings"
	"testing"
)

// windowRuleFiles are the files that must stay answerable with no window.
var windowRuleFiles = []string{"window_rules.go", "window_commands.go", "window_host.go"}

// windowGroupFiles is everything this group owns.
var windowGroupFiles = append([]string{
	"window_host_wails.go", "window_native_darwin.go", "window_native_other.go",
}, windowRuleFiles...)

// readCode returns a file with its comments removed.
//
// The prose is excluded deliberately: every rule below is a rule about what the
// code calls, and each of these files explains in a comment why it does
// not reach for it. Scanning the prose too would make writing down the reason
// break the gate that protects the reason.
func readCode(t *testing.T, name string) string {
	t.Helper()
	source, err := os.ReadFile(name)
	if err != nil {
		t.Fatalf("reading %s: %v", name, err)
	}
	return stripComments(string(source))
}

// stripComments removes // and /* */ comments. Go, C and Objective-C all share
// this syntax, and a quoted string is respected so a comment marker inside one
// is left alone.
func stripComments(source string) string {
	var code strings.Builder
	const (
		plain = iota
		lineComment
		blockComment
		quoted
	)
	state := plain
	for index := 0; index < len(source); index++ {
		character := source[index]
		switch state {
		case plain:
			switch {
			case character == '/' && index+1 < len(source) && source[index+1] == '/':
				state, index = lineComment, index+1
			case character == '/' && index+1 < len(source) && source[index+1] == '*':
				state, index = blockComment, index+1
			case character == '"':
				state = quoted
				code.WriteByte(character)
			default:
				code.WriteByte(character)
			}
		case lineComment:
			if character == '\n' {
				state = plain
				code.WriteByte(character)
			}
		case blockComment:
			if character == '*' && index+1 < len(source) && source[index+1] == '/' {
				state, index = plain, index+1
			}
		case quoted:
			if character == '\\' {
				index++
				continue
			}
			if character == '"' {
				state = plain
			}
			code.WriteByte(character)
		}
	}
	return code.String()
}

// The vendor stops at the host. A function that takes the framework's
// application handle can never leave the application process, and then the
// rules above it cannot be answered in a test, in a headless process, or by any
// second host — which is the whole reason those facts arrive through an
// interface.
func TestTheRulesNameNoVendorType(t *testing.T) {
	for _, name := range windowRuleFiles {
		source := readCode(t, name)
		for _, vendor := range []string{`wails/v3/pkg/application`, "application.", "events."} {
			if strings.Contains(source, vendor) {
				t.Errorf("%s names the framework (%q); these rules must answer with no window at all", name, vendor)
			}
		}
	}
}

// Current() answers with whatever holds the focus, which is wrong precisely
// when the caller is a background repaint, a restore, or a focus-free capture —
// the moments this group exists to serve.
func TestNothingInThisGroupAsksWhichWindowIsCurrent(t *testing.T) {
	for _, name := range windowGroupFiles {
		source := readCode(t, name)
		for _, ambient := range []string{"Window.Current(", "getCurrentWindow"} {
			if strings.Contains(source, ambient) {
				t.Errorf("%s asks the framework which window is current (%q); the caller names the window", name, ambient)
			}
		}
	}
}

// The caller passes what it read. A branch on the environment or on the
// operating system here would make the same command answer differently in a
// window, in a headless process, and in a test — and the difference would only
// show up as one of the three being wrong.
func TestNothingInThisGroupReadsAmbientState(t *testing.T) {
	for _, name := range windowGroupFiles {
		source := readCode(t, name)
		for _, ambient := range []string{"os.Getenv", "os.Getwd", "os.Executable", "runtime.GOOS"} {
			if strings.Contains(source, ambient) {
				t.Errorf("%s reads %s; the platform split is a build tag and everything else is an argument", name, ambient)
			}
		}
	}
}

// The framework's own focus path activates with a call current macOS ignores
// for a background application, so the window comes forward and the keyboard
// never arrives. Reaching for it here would reintroduce exactly that.
func TestTheNativeLayerNeverUsesTheInertActivation(t *testing.T) {
	for _, name := range []string{"window_native_darwin.m", "window_native_darwin.h", "window_native_darwin.go"} {
		if strings.Contains(readCode(t, name), "activateIgnoringOtherApps") {
			t.Errorf("%s uses the deprecated activation; it reports success while nothing comes forward", name)
		}
	}
}
