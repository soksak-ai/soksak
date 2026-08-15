// Package ai identifies the agent sessions a terminal leaves behind.
//
// This build runs no model. A turn is run by spawning the vendor's
// command-line agent as an ordinary child process — the orchestrator does it
// through process_spawn — and everything answered here is read back out of what
// that agent wrote to disk: which command line started one, where its
// transcript lives, which transcript it is writing now, and how those
// transcripts followed one another. No command in this package talks to a
// model, and none of them answers as though it had.
//
// The transcript layouts, measured against the agents' own trees:
//
//	claude: <home>/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
//	        Every line is a record; "sessionId" and "cwd" appear on whichever
//	        lines carry them rather than in a header.
//	codex:  <home>/.codex/sessions/YYYY/MM/DD/rollout-<stamp>-<sessionId>.jsonl
//	        The first record is type="session_meta" with payload.{id, cwd}.
//
// The home and the working directory are arguments everywhere. Read from the
// environment they would make the same command answer from a different tree
// depending on which process asked, and the wrong tree does not fail — it
// answers "no sessions" for a project full of them.
package ai

import "strings"

// Kind is an agent whose sessions this build tracks.
//
// The value is the wire form as well as the Go one: it is what the frontend
// compares against when it decides whether to start watching a directory.
type Kind string

const (
	Claude Kind = "claude"
	Codex  Kind = "codex"
)

// Detect answers which agent a shell command line launches.
//
// The first token's basename decides, so a full path
// ("/usr/local/bin/claude"), arguments ("codex --model o3"), and both at once
// are all caught. The match is on the whole basename: a prefix or suffix test
// would tag "claude-monitor" as an agent, and a terminal block would then
// claim a session that never existed.
//
// A command line that launches no agent is an answer rather than a failure —
// most command lines do not, and this is asked of every one of them.
func Detect(commandLine string) (Kind, bool) {
	fields := strings.Fields(commandLine)
	if len(fields) == 0 {
		return "", false
	}
	binary := fields[0]
	if at := strings.LastIndex(binary, "/"); at >= 0 {
		binary = binary[at+1:]
	}
	switch Kind(binary) {
	case Claude:
		return Claude, true
	case Codex:
		return Codex, true
	}
	return "", false
}
