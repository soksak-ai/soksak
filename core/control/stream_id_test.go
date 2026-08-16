package control

import (
	"strings"
	"testing"
)

// A stream id is checked before frames are routed to it.
//
// docs/tech/NAMING.md N1 fixes the shape: three letters, a dash, and six
// characters of RFC 4648 lowercase base32. The receiver is minted in
// frontend/src/framework/wails/streams.ts under stm-, and the id is what every
// frame is addressed by.
//
// It was accepted unread. Measured 2026-08-16: the frontend minted "s-1" — a
// one-letter prefix and a counter — so two windows produced the same id and a
// reload produced it again for a different receiver. Frames then went to
// whichever receiver held the name, and the symptom is not an error: the
// receiver that should have had them produces nothing, which reads as a backend
// with nothing to send.
//
// The frontend can no longer mint a malformed one. A sidecar or a plugin caller
// still can, and the refusal is here because this is where the id is turned
// into a routing decision.
func TestAStreamIDIsRefusedUnlessItIsAnIdentifier(t *testing.T) {
	for _, probe := range []struct {
		what string
		id   string
	}{
		{"a counter behind one letter", "s-1"},
		{"a counter behind three letters", "stm-1"},
		{"a body outside base32", "stm-01lo89"},
		{"a body of the wrong length", "stm-abcde"},
		{"a prefix of two letters", "st-abcdef"},
		{"an upper-case body", "stm-ABCDEF"},
		{"no prefix at all", "abcdef"},
		{"a path", "../../etc/passwd"},
	} {
		_, err := StreamArg(streamArgs(t, map[string]string{"__stream": probe.id}), "onOutput")
		if err == nil {
			t.Errorf("%s (%q) was accepted; a frame addressed to it goes somewhere unasked", probe.what, probe.id)
			continue
		}
		// The id is in the refusal. A caller holding one malformed receiver
		// among several cannot act on a message that does not name which.
		if !strings.Contains(err.Error(), probe.id) {
			t.Errorf("the refusal for %s does not name %q: %v", probe.what, probe.id, err)
		}
	}
}

func TestAWellFormedStreamIDIsAnswered(t *testing.T) {
	const id = "stm-7k2qx3"
	answered, err := StreamArg(streamArgs(t, map[string]string{"__stream": id}), "onOutput")
	if err != nil {
		t.Fatalf("a well-formed receiver was refused: %v", err)
	}
	if answered != id {
		t.Errorf("id = %q, want %q", answered, id)
	}
}
