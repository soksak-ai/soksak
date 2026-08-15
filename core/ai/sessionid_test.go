package ai

import "testing"

// TestOnlyAUUIDIsASessionID guards the value that ends up in a resume command.
//
// A session id read out of a transcript is later handed back to the agent to
// continue that conversation. Admitting an arbitrary string would let anything
// that can write a line into a watched directory name the session a person
// resumes into.
func TestOnlyAUUIDIsASessionID(t *testing.T) {
	valid := []string{
		"3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", // v4 shape
		"01890a5d-ac96-774b-bcce-b302099a8057", // v7 shape
		"3F1B2C4D-5E6F-4A7B-8C9D-0E1F2A3B4C5D", // hexadecimal is case-blind
	}
	for _, candidate := range valid {
		if !ValidSessionID(candidate) {
			t.Errorf("ValidSessionID(%q) = false, want true", candidate)
		}
	}

	invalid := []string{
		"",
		"3f1b2c4d5e6f4a7b8c9d0e1f2a3b4c5d",      // 32 characters, no hyphens
		"3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5",   // one short
		"3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5dd", // one long
		"3f1b2c4d-5e6f-4a7b-8c9d0-0e1f2a3b4c5",  // hyphen out of place
		"3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5z",  // not hexadecimal
		"../../../etc/passwd-aaaa-aaaa-aaaaaa",  // a path is not an identifier
	}
	for _, candidate := range invalid {
		if ValidSessionID(candidate) {
			t.Errorf("ValidSessionID(%q) = true, want false", candidate)
		}
	}
}

// TestOnlyAUUIDNamedTranscriptIsOne keeps the two readers of a session
// directory agreeing about which files are transcripts. The tracker and the
// on-demand lookup both use this rule, and if they disagreed the newest file to
// one would be invisible to the other.
func TestOnlyAUUIDNamedTranscriptIsOne(t *testing.T) {
	const identifier = "3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"

	id, ok := sessionFileID(identifier + ".jsonl")
	if !ok || id != identifier {
		t.Errorf("sessionFileID(<uuid>.jsonl) = %q,%v; want %q,true", id, ok, identifier)
	}

	for _, name := range []string{
		identifier,                // no suffix
		identifier + ".json",      // a different suffix
		identifier + ".jsonl.tmp", // a partial write in progress
		"notes.jsonl",             // not an identifier
		".jsonl",                  // nothing in front of the suffix
	} {
		if _, ok := sessionFileID(name); ok {
			t.Errorf("sessionFileID(%q) accepted it; want refused", name)
		}
	}
}
