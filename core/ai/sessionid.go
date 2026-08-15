package ai

import "strings"

// SessionInfo is one agent session, as its own transcript names it.
//
// The field names on the wire are the frontend's vocabulary, because the
// catalog entry that documents these commands promises a session id and a
// working directory under those names.
type SessionInfo struct {
	Kind      Kind   `json:"kind"`
	SessionID string `json:"sessionId"`
	Cwd       string `json:"cwd"`
}

// transcriptSuffix is what an agent names its transcripts.
const transcriptSuffix = ".jsonl"

// ValidSessionID admits the UUID shape and nothing else.
//
// A session id read out of a transcript is later handed back to an agent to
// continue that conversation. Accepting an arbitrary string would let anything
// able to write a line into a watched directory choose the session a person
// resumes into, so the whitelist is the boundary rather than the escaping.
//
// Both the v4 and v7 layouts satisfy it: 36 characters, hyphens at 8, 13, 18
// and 23, hexadecimal everywhere else.
func ValidSessionID(candidate string) bool {
	if len(candidate) != 36 {
		return false
	}
	for index := 0; index < len(candidate); index++ {
		character := candidate[index]
		switch index {
		case 8, 13, 18, 23:
			if character != '-' {
				return false
			}
		default:
			if !isHexadecimal(character) {
				return false
			}
		}
	}
	return true
}

func isHexadecimal(character byte) bool {
	switch {
	case character >= '0' && character <= '9':
		return true
	case character >= 'a' && character <= 'f':
		return true
	case character >= 'A' && character <= 'F':
		return true
	}
	return false
}

// sessionFileID answers the session a transcript's file name carries.
//
// One rule, used by both readers of a session directory: the tracker comparing
// snapshots and the on-demand lookup for the newest transcript. Two rules would
// disagree about which files count, and then the newest transcript to one of
// them would be invisible to the other.
func sessionFileID(name string) (string, bool) {
	stem, found := strings.CutSuffix(name, transcriptSuffix)
	if !found || !ValidSessionID(stem) {
		return "", false
	}
	return stem, true
}
