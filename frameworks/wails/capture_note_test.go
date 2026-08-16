package wails

import (
	"encoding/json"
	"testing"
)

// A capture answers the image and what the capture was.
//
// Pixels is the capture with no file left behind to inspect afterwards, and it
// answered a bare base64 string — so the one path an agent looks through was
// the one path with no statement beside the picture.
//
// The statement is small now, and that is the point. While the core composited
// each surface's own render into the image, the note had to carry how many
// surfaces were held, how many were drawn, and why each of the rest was not:
// the image could be missing a pane and say nothing. A capture that only reads
// the window cannot omit a pane and stay quiet about it, because it makes no
// per-surface decision at all.
func TestTheCaptureAnAgentLooksThroughCarriesItsNote(t *testing.T) {
	encoded, err := json.Marshal(CapturePixels{
		PNG:  "iVBORw0KGgo=",
		Note: CaptureNote{Path: "/evidence/shot.png"},
	})
	if err != nil {
		t.Fatalf("encoding the answer: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(encoded, &payload); err != nil {
		t.Fatalf("decoding the answer: %v", err)
	}
	for _, key := range []string{"png", "note"} {
		if _, given := payload[key]; !given {
			t.Errorf("the answer has no %q; the image and what it was travel together", key)
		}
	}
}
