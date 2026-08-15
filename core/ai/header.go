package ai

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"strings"
)

// headBytes is how much of a transcript is read to identify it.
//
// A transcript grows for as long as the conversation does — megabytes — and its
// identity is written into the first records. Reading the whole file to learn
// its id is work proportional to how long someone has been talking, repeated
// every time a command in that terminal ends.
const headBytes = 64 * 1024

// readHead reads the front of a transcript, ending on a record boundary.
//
// Only whole lines come back. A line cut by the window is not a record, and
// handing half of one to the parser makes a file that was truncated here look
// like a file the agent wrote badly.
func readHead(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer func() { _ = file.Close() }()

	// One byte past the window, so a file that exactly fills it is still known
	// to be complete rather than assumed to be cut.
	buffer := make([]byte, headBytes+1)
	read, err := io.ReadFull(file, buffer)
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		return "", err
	}
	content := buffer[:read]
	if read > headBytes {
		content = content[:headBytes]
		end := bytes.LastIndexByte(content, '\n')
		if end < 0 {
			// Not one complete record inside the window. Nothing to read is
			// the honest answer; guessing at the fragment is not.
			return "", nil
		}
		content = content[:end+1]
	}
	return string(content), nil
}

// ParseHeader reads the identity a transcript declares.
//
// Nothing found is a nil answer rather than a failure: an agent creates its
// transcript before it writes the record naming it, and the terminal asks right
// after the command starts. A transcript that cannot be named yet is not a
// broken one.
func ParseHeader(kind Kind, head string) *SessionInfo {
	switch kind {
	case Claude:
		return parseClaudeHeader(head)
	case Codex:
		return parseCodexHeader(head)
	}
	// An unrecognised agent names nothing. Falling through to one of the
	// parsers would answer with a claude session for a file that is not one.
	return nil
}

// parseClaudeHeader takes the first valid session id and the first working
// directory it meets, which need not be on the same line — measured against
// claude's own transcripts, where the identity is spread across the records
// rather than gathered into a header.
//
// A line that will not parse is skipped rather than ending the read: the tail
// of a live transcript is mid-write often enough that stopping there would
// answer "no session" for a session running right now.
func parseClaudeHeader(head string) *SessionInfo {
	session := SessionInfo{Kind: Claude}
	for _, line := range strings.Split(head, "\n") {
		record, ok := decodeRecord(line)
		if !ok {
			continue
		}
		if session.SessionID == "" {
			if identifier, present := stringField(record, "sessionId"); present && ValidSessionID(identifier) {
				session.SessionID = identifier
			}
		}
		if session.Cwd == "" {
			if directory, present := stringField(record, "cwd"); present && directory != "" {
				session.Cwd = directory
			}
		}
		if session.SessionID != "" && session.Cwd != "" {
			return &session
		}
	}
	// Half an identity is none of one: a session with no working directory
	// cannot be placed, and one with no id cannot be resumed.
	return nil
}

// parseCodexHeader reads the one session_meta record, which codex writes first.
// The first one decides: a transcript whose meta record does not name a valid
// session is not identified by a later record that looks similar.
func parseCodexHeader(head string) *SessionInfo {
	for _, line := range strings.Split(head, "\n") {
		record, ok := decodeRecord(line)
		if !ok {
			continue
		}
		if kind, present := stringField(record, "type"); !present || kind != "session_meta" {
			continue
		}
		payload, present := record["payload"]
		if !present {
			return nil
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(payload, &fields); err != nil {
			return nil
		}
		identifier, hasIdentifier := stringField(fields, "id")
		directory, hasDirectory := stringField(fields, "cwd")
		if !hasIdentifier || !ValidSessionID(identifier) || !hasDirectory || directory == "" {
			return nil
		}
		return &SessionInfo{Kind: Codex, SessionID: identifier, Cwd: directory}
	}
	return nil
}

func decodeRecord(line string) (map[string]json.RawMessage, bool) {
	var record map[string]json.RawMessage
	if err := json.Unmarshal([]byte(line), &record); err != nil {
		return nil, false
	}
	return record, record != nil
}

func stringField(record map[string]json.RawMessage, name string) (string, bool) {
	raw, present := record[name]
	if !present {
		return "", false
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false
	}
	return value, true
}
