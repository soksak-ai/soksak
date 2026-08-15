package terminal

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/soksak/soksak-core/core/control"
)

func raw(text string) json.RawMessage { return json.RawMessage(text) }

func TestASizeIsRequiredAndNeverZero(t *testing.T) {
	// A defaulted size would mis-render a pane whose caller forgot to send one,
	// and a zero winsize tells a full-screen program the screen has no columns.
	// Every rejection has to name the argument, or the caller has to guess
	// which of cols and rows it got wrong.
	for _, testCase := range []struct {
		name string
		args control.Args
	}{
		{"absent", control.Args{}},
		{"null", control.Args{"cols": raw(`null`)}},
		{"zero", control.Args{"cols": raw(`0`)}},
		{"negative", control.Args{"cols": raw(`-1`)}},
		{"fractional", control.Args{"cols": raw(`80.5`)}},
		{"text", control.Args{"cols": raw(`"80"`)}},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := size("spawn_terminal", testCase.args, "cols")
			if err == nil {
				t.Fatal("a size that is not a usable screen dimension must be refused")
			}
			if !strings.Contains(err.Error(), `"cols"`) || !strings.Contains(err.Error(), "spawn_terminal") {
				t.Fatalf("error = %v, want it to name the command and the argument", err)
			}
		})
	}

	got, err := size("spawn_terminal", control.Args{"cols": raw(`80`)}, "cols")
	if err != nil || got != 80 {
		t.Fatalf("size = %d, %v, want 80", got, err)
	}
}

func TestAnOptionalTextSeparatesAbsenceFromEmptiness(t *testing.T) {
	// null is how the frontend spells "the caller named none" — it sends
	// `cwd: opts.cwd ?? null`. An empty string is a value the caller chose, so
	// collapsing the two would let "" silently mean "unspecified".
	for _, testCase := range []struct {
		name    string
		args    control.Args
		want    string
		present bool
	}{
		{"absent", control.Args{}, "", false},
		{"null", control.Args{"cwd": raw(`null`)}, "", false},
		{"empty", control.Args{"cwd": raw(`""`)}, "", true},
		{"value", control.Args{"cwd": raw(`"<local-evidence>"`)}, "<local-evidence>", true},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			got, present, err := optionalText("spawn_terminal", testCase.args, "cwd")
			if err != nil {
				t.Fatalf("optionalText: %v", err)
			}
			if got != testCase.want || present != testCase.present {
				t.Fatalf("optionalText = %q, %v, want %q, %v", got, present, testCase.want, testCase.present)
			}
		})
	}

	if _, _, err := optionalText("spawn_terminal", control.Args{"cwd": raw(`7`)}, "cwd"); err == nil {
		t.Fatal("a non-string cwd must be refused rather than coerced")
	}
}

func TestReplaySpawnsForEveryFormThatOwnsItsOwnScreen(t *testing.T) {
	// An earlier build pinned three wire forms: absent, "none", and {fromSeq}.
	// The first two mean the consumer draws its own screen, which is exactly
	// what happens here. fromSeq is a coordinate into a ring this generation
	// does not keep, so honouring it would hand back a silently empty tail.
	for _, testCase := range []struct {
		name string
		args control.Args
	}{
		{"absent", control.Args{}},
		{"null", control.Args{"replay": raw(`null`)}},
		{"none", control.Args{"replay": raw(`"none"`)}},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			if err := replaySpawns("spawn_terminal", testCase.args); err != nil {
				t.Fatalf("replaySpawns: %v", err)
			}
		})
	}

	for _, testCase := range []struct {
		name string
		args control.Args
	}{
		{"fromSeq", control.Args{"replay": raw(`{"fromSeq":4096}`)}},
		{"other mode", control.Args{"replay": raw(`"ring"`)}},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			err := replaySpawns("spawn_terminal", testCase.args)
			if err == nil {
				t.Fatal("a replay this build cannot perform must be refused, not ignored")
			}
			if !strings.Contains(err.Error(), "replay") {
				t.Fatalf("error = %v, want it to name replay", err)
			}
		})
	}
}

func TestAByteCountRefusesNegativesAndAcceptsZero(t *testing.T) {
	// Zero acknowledged bytes is an ordinary answer from a consumer that drew
	// nothing. A negative one would credit the window instead of debiting it,
	// and the reader would never pause.
	got, err := byteCount("ack_terminal", control.Args{"bytes": raw(`0`)}, "bytes")
	if err != nil || got != 0 {
		t.Fatalf("byteCount = %d, %v, want 0", got, err)
	}

	for _, testCase := range []struct {
		name string
		args control.Args
	}{
		{"absent", control.Args{}},
		{"negative", control.Args{"bytes": raw(`-1`)}},
		{"text", control.Args{"bytes": raw(`"12"`)}},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := byteCount("ack_terminal", testCase.args, "bytes"); err == nil {
				t.Fatal("a byte count that is not a count must be refused")
			}
		})
	}
}

func TestASessionIdIsRequiredAndNeverZero(t *testing.T) {
	// Ids are minted from 1, so 0 is a caller that never received one — most
	// often a field that was never filled in. Accepting it would look up a row
	// that cannot exist and report "no such terminal" for a caller error.
	for _, testCase := range []struct {
		name string
		args control.Args
	}{
		{"absent", control.Args{}},
		{"null", control.Args{"id": raw(`null`)}},
		{"zero", control.Args{"id": raw(`0`)}},
		{"negative", control.Args{"id": raw(`-3`)}},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := sessionID("write_terminal", testCase.args)
			if err == nil {
				t.Fatal("an id that was never minted must be refused")
			}
			if !strings.Contains(err.Error(), `"id"`) {
				t.Fatalf("error = %v, want it to name the argument", err)
			}
		})
	}

	got, err := sessionID("write_terminal", control.Args{"id": raw(`7`)})
	if err != nil || got != 7 {
		t.Fatalf("sessionID = %d, %v, want 7", got, err)
	}
}

func TestARequiredTextAcceptsEmptyButNotAbsent(t *testing.T) {
	// A zero-byte write is not an error; a missing data field is. Collapsing
	// them would turn a caller's dropped argument into a silent no-op.
	got, err := requiredText("write_terminal", control.Args{"data": raw(`""`)}, "data")
	if err != nil || got != "" {
		t.Fatalf("requiredText = %q, %v, want the empty string", got, err)
	}
	if _, err := requiredText("write_terminal", control.Args{}, "data"); err == nil {
		t.Fatal("a missing data argument must be refused")
	}
	if _, err := requiredText("write_terminal", control.Args{"data": raw(`null`)}, "data"); err == nil {
		t.Fatal("a null data argument must be refused")
	}
}
