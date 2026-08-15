// Package i18n holds the sentences this core shows to a person.
//
// A sentence a person reads goes through this package. The rule is who reads
// it, not what language it is written in: an English label hardcoded in a
// handler is exactly as unlocalised as a Korean one, and it only looks correct
// because the default language is English.
//
// Out of scope here: a wrap that hands a cause to a log
// (fmt.Errorf("reading %s: %w", ...)), an invariant a developer reads, a test
// fixture. Those stay plain English literals.
package i18n

import (
	"fmt"
	"sort"
	"strings"
)

// Language is the language a caller reads.
//
// The core does not derive it. Home, socket and identity are handed in by
// whoever started this process, and language is the same kind of fact: reading
// LANG or a locale API here would make the core answer differently depending on
// the environment it happens to run in, which is what the ambient rule refuses.
type Language string

const (
	// English is the fallback. A key with no sentence in the asked language
	// answers in English rather than answering with the key.
	English Language = "en"
	Korean  Language = "ko"
)

// Known is every language this build serves, in a fixed order.
func Known() []Language { return []Language{English, Korean} }

// ParseLanguage reads a language a caller asked for.
//
// An unknown tag is refused rather than silently answered in English: a client
// that asked for "jp" and received English cannot tell whether this build has
// no Japanese or whether its request was ignored.
func ParseLanguage(tag string) (Language, error) {
	if tag == "" {
		return English, nil
	}
	base := strings.ToLower(tag)
	if index := strings.IndexAny(base, "-_"); index >= 0 {
		base = base[:index]
	}
	for _, known := range Known() {
		if string(known) == base {
			return known, nil
		}
	}
	return "", fmt.Errorf("this build has no sentences in %q; it serves %s", tag, joined(Known()))
}

func joined(languages []Language) string {
	tags := make([]string, 0, len(languages))
	for _, language := range languages {
		tags = append(tags, string(language))
	}
	return strings.Join(tags, ", ")
}

// Sentence is one line in every language this build serves.
//
// A missing translation is an empty field rather than a missing key, so the
// parity check reads the same table the renderer does instead of comparing two.
type Sentence struct {
	EN string
	KO string
}

func (sentence Sentence) in(language Language) string {
	if language == Korean && sentence.KO != "" {
		return sentence.KO
	}
	return sentence.EN
}

// table is the single owner of these sentences. A second table would let two
// answers to the same key exist, and the one a caller receives would depend on
// which package it reached.
var table = map[string]Sentence{}

// Declare adds sentences to the table.
//
// A key declared twice is a programming error and panics at start rather than
// answering whichever line loaded last. Adding a language is adding a field to
// Sentence and filling this table — no call site changes.
func Declare(sentences map[string]Sentence) {
	for key, sentence := range sentences {
		if _, taken := table[key]; taken {
			panic("i18n: key declared twice: " + key)
		}
		if sentence.EN == "" {
			panic("i18n: key has no English sentence: " + key)
		}
		table[key] = sentence
	}
}

// Keys is every declared key, sorted, for the parity gate.
func Keys() []string {
	keys := make([]string, 0, len(table))
	for key := range table {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// Has reports whether a key is declared.
func Has(key string) bool {
	_, declared := table[key]
	return declared
}

// T renders one key in one language.
//
// An undeclared key answers with the key itself rather than an empty string: a
// caller that sees "plugin.enable.blocked" on screen has something to look up,
// and a caller that sees nothing reads it as a feature that did nothing.
//
// Params fill {name} placeholders. A placeholder with no param is left as it
// stands — dropping it would hide from the reader that a value was expected.
func T(language Language, key string, params map[string]string) string {
	sentence, declared := table[key]
	if !declared {
		return key
	}
	text := sentence.in(language)
	for name, value := range params {
		text = strings.ReplaceAll(text, "{"+name+"}", value)
	}
	return text
}
