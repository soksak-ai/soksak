package i18n

import "testing"

func TestAnUndeclaredKeyAnswersTheKeyRatherThanNothing(t *testing.T) {
	// A caller that reads "plugin.enable.blocked" on screen has something to
	// look up. A caller that reads an empty line takes it for a feature that did
	// nothing and files a different bug.
	if got := T(English, "no.such.key", nil); got != "no.such.key" {
		t.Errorf("T = %q, want the key itself", got)
	}
}

func TestAKeyWithNoKoreanAnswersEnglishRatherThanEmpty(t *testing.T) {
	Declare(map[string]Sentence{"test.englishOnly": {EN: "only English here"}})
	if got := T(Korean, "test.englishOnly", nil); got != "only English here" {
		t.Errorf("T(ko) = %q, want the English line", got)
	}
}

func TestEachLanguageAnswersItsOwnLine(t *testing.T) {
	Declare(map[string]Sentence{"test.both": {EN: "a shell is running", KO: "셸이 실행 중입니다"}})
	if got := T(English, "test.both", nil); got != "a shell is running" {
		t.Errorf("T(en) = %q", got)
	}
	if got := T(Korean, "test.both", nil); got != "셸이 실행 중입니다" {
		t.Errorf("T(ko) = %q", got)
	}
}

func TestAPlaceholderWithNoParamStays(t *testing.T) {
	// Dropping it hides from the reader that a value was expected, and the
	// sentence then reads as if nothing was missing.
	Declare(map[string]Sentence{"test.holder": {EN: "no file at {path}"}})
	if got := T(English, "test.holder", nil); got != "no file at {path}" {
		t.Errorf("T = %q, want the placeholder kept", got)
	}
	if got := T(English, "test.holder", map[string]string{"path": "/tmp/x"}); got != "no file at /tmp/x" {
		t.Errorf("T = %q", got)
	}
}

func TestAnUnknownLanguageIsRefusedRatherThanAnsweredInEnglish(t *testing.T) {
	// A client that asked for "jp" and received English cannot tell whether
	// this build has no Japanese or whether its request was ignored.
	if _, err := ParseLanguage("jp"); err == nil {
		t.Fatal("an unknown language was accepted")
	}
	for _, tag := range []string{"", "en", "ko", "ko-KR", "EN_us"} {
		if _, err := ParseLanguage(tag); err != nil {
			t.Errorf("ParseLanguage(%q): %v", tag, err)
		}
	}
}

func TestARefusalCarriesItsKeyRatherThanAFinishedSentence(t *testing.T) {
	// The handler runs before the reader of the answer is determined.
	Declare(map[string]Sentence{
		"test.refusal": {EN: "{name} is not installed", KO: "{name} 이(가) 설치되지 않았습니다"},
	})
	err := Errorf("test.refusal", map[string]string{"name": "terminal"})

	if got := err.Error(); got != "terminal is not installed" {
		t.Errorf("Error() = %q, want the English line so a log stays readable", got)
	}
	if got := Render(err, Korean); got != "terminal 이(가) 설치되지 않았습니다" {
		t.Errorf("Render(ko) = %q", got)
	}
}

func TestAnErrorWithNoKeyIsRenderedAsItStands(t *testing.T) {
	// This build has sentences that are not moved yet. Answering an empty
	// string for them would turn a partial migration into a silent one.
	plain := errorString("a plain error")
	if got := Render(plain, Korean); got != "a plain error" {
		t.Errorf("Render = %q, want the error's own text", got)
	}
	if got := Render(nil, Korean); got != "" {
		t.Errorf("Render(nil) = %q", got)
	}
}

type errorString string

func (e errorString) Error() string { return string(e) }

func TestDeclaringOneKeyTwiceStopsTheBuildRatherThanPickingOne(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("a duplicate key was accepted; the answer would depend on load order")
		}
	}()
	Declare(map[string]Sentence{"test.twice": {EN: "first"}})
	Declare(map[string]Sentence{"test.twice": {EN: "second"}})
}
