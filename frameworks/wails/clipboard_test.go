package wails

import (
	"encoding/json"
	"testing"

	"github.com/soksak-ai/soksak-core/core/control"
)

type memoryClipboard struct {
	text string
}

func (clipboard *memoryClipboard) SetText(text string) bool {
	clipboard.text = text
	return true
}

func (clipboard *memoryClipboard) Text() (string, bool) {
	return clipboard.text, true
}

func clipboardArgs(text string) control.Args {
	encoded, _ := json.Marshal(text)
	return control.Args{"text": encoded}
}

func TestClipboardCommandsUseTheInjectedFrameworkClipboard(t *testing.T) {
	registry := control.NewRegistry()
	clipboard := &memoryClipboard{text: "before"}
	RegisterClipboard(registry, clipboard)

	if _, err := registry.Invoke("clipboard_write", clipboardArgs("SELECT_FINAL_13579")); err != nil {
		t.Fatalf("clipboard_write: %v", err)
	}
	if clipboard.text != "SELECT_FINAL_13579" {
		t.Fatalf("clipboard text = %q", clipboard.text)
	}
	got, err := registry.Invoke("clipboard_read", nil)
	if err != nil {
		t.Fatalf("clipboard_read: %v", err)
	}
	if got != "SELECT_FINAL_13579" {
		t.Fatalf("clipboard_read = %#v", got)
	}
}
