//go:build darwin && applicationgate

package application

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
)

func TestNativeTrafficLightCloseEndsTheAddressedWindowWithoutTakingInput(t *testing.T) {
	gate := newGate(t, "<local-evidence>/soksak-native-close-gate", "com.soksak.nativeclosegate")
	inputOwner := activeInputOwner(t)
	gate.start()
	first := gate.openWorkspace()
	closing := openNativeCloseWorkspace(t, gate, t.TempDir())

	var status struct {
		Data struct {
			Present       bool    `json:"present"`
			Enabled       bool    `json:"enabled"`
			Visible       bool    `json:"visible"`
			WindowVisible bool    `json:"windowVisible"`
			Width         float64 `json:"width"`
			Height        float64 `json:"height"`
		} `json:"data"`
	}
	statusRaw := gate.run("window_native_close_status", "window="+closing)
	if err := json.Unmarshal([]byte(statusRaw), &status); err != nil {
		t.Fatalf("decode native close status: %v\n%s", err, statusRaw)
	}
	if !status.Data.Present || !status.Data.Enabled || !status.Data.Visible ||
		status.Data.WindowVisible || status.Data.Width <= 0 || status.Data.Height <= 0 {
		t.Fatalf("native close status=%+v", status.Data)
	}

	var clicked struct {
		Data struct {
			Sequence uint64 `json:"sequence"`
			Posted   bool   `json:"posted"`
			Tracked  bool   `json:"tracked"`
		} `json:"data"`
	}
	clickRaw := gate.run("window_native_close_click", "window="+closing)
	if err := json.Unmarshal([]byte(clickRaw), &clicked); err != nil {
		t.Fatalf("decode native close receipt: %v\n%s", err, clickRaw)
	}
	if !clicked.Data.Posted || !clicked.Data.Tracked || clicked.Data.Sequence == 0 {
		t.Fatalf("native close click=%+v", clicked.Data)
	}
	sequence := strconv.FormatUint(clicked.Data.Sequence, 10)
	_, closeErr := gate.try("window_native_close_wait", "window="+first,
		"sequence="+sequence, "timeoutMs=5000")
	if closeErr != nil {
		pointer, pointerErr := gate.try("window.input.pointer.wait", "window="+first,
			"sequence="+sequence, "timeoutMs=100")
		windows, _ := gate.try("window_list", "window="+first)
		t.Fatalf("native close was not completed: %v\nfirst=%s closing=%s\npointer=%s pointerErr=%v\nwindows=%s",
			closeErr, first, closing, pointer, pointerErr, windows)
	}
	windows := gate.run("window_list", "window="+first)
	if strings.Contains(windows, closing) || !strings.Contains(windows, first) {
		t.Fatalf("window list after native close=%s", windows)
	}
	if current := activeInputOwner(t); current != inputOwner {
		t.Fatalf("native close changed the input owner: %s -> %s", inputOwner, current)
	}
	gate.opened = gate.opened[:len(gate.opened)-1]
}

func openNativeCloseWorkspace(t *testing.T, gate *restoreGate, root string) string {
	t.Helper()
	var answer struct {
		Data struct {
			Label string `json:"label"`
		} `json:"data"`
	}
	raw := gate.run("window.open", "window="+gate.answeringWindow(), "root="+root, "focus=false")
	if err := json.Unmarshal([]byte(raw), &answer); err != nil || answer.Data.Label == "" {
		t.Fatalf("open distinct native-close workspace: %v\n%s", err, raw)
	}
	gate.awaitWindow(answer.Data.Label)
	gate.opened = append(gate.opened, answer.Data.Label)
	return answer.Data.Label
}
