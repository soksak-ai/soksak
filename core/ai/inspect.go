package ai

import (
	"fmt"
	"strings"
)

// Inspect reads one transcript and answers which session it is.
//
// The path must be inside an agent's transcript tree. Without that rule this is
// a read of any file on the machine, reachable from every transport the
// registry answers on.
func Inspect(path string) (*SessionInfo, error) {
	kind, err := transcriptKind(path)
	if err != nil {
		return nil, err
	}
	head, err := readHead(path)
	if err != nil {
		// The caller named this file. "It is not there" is not the same answer
		// as "it holds no session".
		return nil, fmt.Errorf("ai: could not read %s: %w", path, err)
	}
	return ParseHeader(kind, head), nil
}

// transcriptKind decides whether a path is a transcript, and whose.
//
// The judgement is on adjacent path components, never on a substring: a
// substring test passes for a directory somebody named ".claude_projects", and
// it says nothing at all about a path that enters the tree and then walks back
// out. The path is also not cleaned first — resolving ".." here would silently
// turn a path that leaves the tree into one that never did.
func transcriptKind(path string) (Kind, error) {
	if err := requireAbsolute("the transcript path", path); err != nil {
		return "", err
	}
	parts := strings.Split(path, "/")
	for _, part := range parts {
		if part == ".." {
			return "", fmt.Errorf(
				"ai: %q walks back out through %q; a transcript path is judged by its components, and a path that leaves the tree is no longer inside it",
				path, "..")
		}
	}
	for index := 0; index+1 < len(parts); index++ {
		switch {
		case parts[index] == ".claude" && parts[index+1] == "projects":
			return Claude, nil
		case parts[index] == ".codex" && parts[index+1] == "sessions":
			return Codex, nil
		}
	}
	return "", fmt.Errorf(
		"ai: %q is under neither .claude/projects nor .codex/sessions; this command reads agent transcripts and refuses to be a general file read",
		path)
}
