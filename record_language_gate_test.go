package main

import (
	"os/exec"
	"strings"
	"testing"
	"unicode"
)

// The record is English, commit messages included (AGENTS 6-1).
//
// 6-1 names commit messages in the same breath as comments, and until 2026-08-16
// nothing read them. `korean_gate_test.go` opens files; a message is not a file,
// so the one place the rule was never checked is the one place it was broken —
// a commit body about the status bar carried a Korean word for "terminal".
//
// A repository is read by whoever opens it, and `git log` is most of what they
// read. A message in another language is a hole in that reading, and it cannot
// be corrected later once the branch is shared: history is the one part of the
// record that hardens.
//
// The floor is zero and there is no allowlist. A commit is written once by
// someone who is present; unlike a file it costs nothing to write correctly the
// first time, and an exemption here would be an exemption for the next one too.
//
// Bundle values are the sole Korean in this repository, and a message names the
// key rather than quoting the value: the key identifies the change, and the value
// is what the change is about.
func TestTheRecordIsEnglish(t *testing.T) {
	log := exec.Command("git", "log", "--format=%H%x00%s%x00%b%x00")
	out, err := log.Output()
	if err != nil {
		t.Skipf("git log is unavailable here: %v", err)
	}
	fields := strings.Split(string(out), "\x00")
	var offenders []string
	commits := 0
	for i := 0; i+2 < len(fields); i += 3 {
		hash := strings.TrimSpace(fields[i])
		if hash == "" {
			continue
		}
		commits++
		short := hash
		if len(short) > 8 {
			short = short[:8]
		}
		for _, part := range []struct {
			name string
			body string
		}{{"subject", fields[i+1]}, {"body", fields[i+2]}} {
			for index, line := range strings.Split(part.body, "\n") {
				if !holdsHangul(line) {
					continue
				}
				offenders = append(offenders,
					short+" "+part.name+" line "+itoa(index+1)+": "+strings.TrimSpace(line))
			}
		}
	}
	if commits == 0 {
		t.Fatal("no commit was read; the log command is wrong")
	}
	if len(offenders) > 0 {
		t.Errorf("the record holds Korean in %d places:\n%s\n"+
			"Rewrite the message in English. A branch nobody has pulled still can be; "+
			"once it is shared this is permanent.",
			len(offenders), strings.Join(offenders, "\n"))
	}
}

// holdsHangul reports whether the line holds a Hangul rune. Syllables, jamo and
// the compatibility block alike — one letter is the same violation as a sentence,
// and unicode.Is answers the range without a table here.
func holdsHangul(line string) bool {
	for _, r := range line {
		if unicode.Is(unicode.Hangul, r) {
			return true
		}
	}
	return false
}
