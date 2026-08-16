package control

import (
	"encoding/base64"
	"encoding/json"
	"testing"
)

func streamArgs(t *testing.T, value any) Args {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return Args{"onOutput": encoded}
}

func TestAStreamArgumentAnswersTheIdTheCallerMinted(t *testing.T) {
	id, err := StreamArg(streamArgs(t, map[string]string{"__stream": "stm-7k2qx3"}), "onOutput")
	if err != nil {
		t.Fatal(err)
	}
	if id != "stm-7k2qx3" {
		t.Errorf("id = %q, want stm-7k2qx3", id)
	}
}

func TestAnArgumentThatIsNotAStreamIsRefused(t *testing.T) {
	// A caller that meant to receive frames gets a refusal here. Reading it as
	// absent makes a stream that never delivers look like a backend with
	// nothing to send.
	for name, value := range map[string]any{
		"a bare string":      "stm-7k2qx3",
		"an empty object":    map[string]string{},
		"a wrong field":      map[string]string{"id": "stm-7k2qx3"},
		"an empty stream id": map[string]string{"__stream": ""},
	} {
		if _, err := StreamArg(streamArgs(t, value), "onOutput"); err == nil {
			t.Errorf("%s was accepted as a stream", name)
		}
	}
	if _, err := StreamArg(Args{}, "onOutput"); err == nil {
		t.Error("a missing argument was accepted as a stream")
	}
}

func TestAnOmittedStreamIsACallerThatWantsNoFrames(t *testing.T) {
	for name, args := range map[string]Args{
		"absent": {},
		"null":   {"onOutput": json.RawMessage("null")},
	} {
		id, wanted, err := OptionalStreamArg(args, "onOutput")
		if err != nil {
			t.Errorf("%s: %v", name, err)
		}
		if wanted || id != "" {
			t.Errorf("%s: wanted=%v id=%q, want no stream", name, wanted, id)
		}
	}

	// A malformed reference is an attempt to receive, not a decision not to.
	if _, _, err := OptionalStreamArg(streamArgs(t, "stm-7k2qx3"), "onOutput"); err == nil {
		t.Error("a malformed reference passed as absence")
	}
}

func TestBytesTravelBase64UnderAFieldThatSaysSo(t *testing.T) {
	// A bare string would make a receiver guess whether a text frame is text or
	// base64, and it guesses wrong for one of them.
	frame := Bytes([]byte{0x00, 0x1b, 0x5b, 0x41})
	encoded, err := json.Marshal(StreamFrame{Stream: "stm-7k2qx3", Frame: frame})
	if err != nil {
		t.Fatal(err)
	}
	var read struct {
		Stream string `json:"stream"`
		Frame  struct {
			Bytes string `json:"bytes"`
		} `json:"frame"`
	}
	if err := json.Unmarshal(encoded, &read); err != nil {
		t.Fatal(err)
	}
	if read.Stream != "stm-7k2qx3" {
		t.Errorf("stream = %q", read.Stream)
	}
	decoded, err := base64.StdEncoding.DecodeString(read.Frame.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	if string(decoded) != "\x00\x1b[A" {
		t.Errorf("frame = %q", decoded)
	}
}
