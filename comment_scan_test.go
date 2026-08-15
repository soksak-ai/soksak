package main

import "strings"

// scanSource separates a source file into its comments and everything else.
//
// A line-prefix match misses two comment forms this repository uses heavily: a
// comment after code (`flush() // reason`) and a JSX comment (`{/* reason */}`).
// Measured 2026-08-15: prefix matching saw 8,783 Korean comment lines; scanning
// saw 9,491. The 708 it could not see were exempt from every prose rule.
//
// The four states are code, string, comment and regular expression. The last
// one is not optional: a regular expression may hold a backtick, a quote or a
// `//`, and without it the walk enters a string it never leaves. Measured
// 2026-08-15 in state/ids.test.ts — one regex holding a backtick put every
// comment below it on the code side, and a comment sweep then read as a code
// change.
//
// byLine is the comment text on each 1-indexed line. outside is the source with
// every comment removed, delimiters included; newlines are kept so the two
// sides of a sweep line up.
func scanSource(source string) (byLine map[int]string, outside string) {
	byLine = map[int]string{}
	var kept []rune

	const (
		code = iota
		str
		lineComment
		blockComment
		regex
	)
	state := code
	var quote rune
	// significant is the last character read in code, which is the test for
	// whether a `/` opens a regular expression or divides.
	var significant rune
	inClass := false
	line := 1

	runes := []rune(source)
	for index := 0; index < len(runes); index++ {
		char := runes[index]
		next := rune(0)
		if index+1 < len(runes) {
			next = runes[index+1]
		}
		newline := char == '\n'

		switch state {
		case code:
			switch {
			case char == '/' && next == '/':
				state = lineComment
				index++
				continue
			case char == '/' && next == '*':
				state = blockComment
				index++
				continue
			case char == '/' && opensRegex(significant):
				state, inClass = regex, false
			case char == '"' || char == '\'' || char == '`':
				state, quote = str, char
			}
			kept = append(kept, char)
			if !isSpace(char) {
				significant = char
			}
		case str:
			kept = append(kept, char)
			switch {
			case char == '\\':
				if index+1 < len(runes) {
					kept = append(kept, next)
				}
				index++
				continue
			case char == quote:
				state, significant = code, char
			case newline && quote != '`':
				// An unterminated quote is a scanner error, not a string that
				// runs to the end of the file. Recovering at the newline keeps
				// one bad line from hiding every comment below it.
				state = code
			}
		case regex:
			kept = append(kept, char)
			switch {
			case char == '\\':
				if index+1 < len(runes) {
					kept = append(kept, next)
				}
				index++
				continue
			case char == '[':
				inClass = true
			case char == ']':
				inClass = false
			case char == '/' && !inClass:
				state, significant = code, char
			case newline:
				// A regular expression cannot hold a newline. Reaching one
				// means the `/` divided after all.
				state = code
			}
		case lineComment:
			if newline {
				state = code
				kept = append(kept, char)
			} else {
				byLine[line] += string(char)
			}
		case blockComment:
			if char == '*' && next == '/' {
				state, significant = code, '/'
				index++
				continue
			}
			if newline {
				kept = append(kept, char)
			} else {
				byLine[line] += string(char)
			}
		}

		if newline {
			line++
		}
	}
	return byLine, string(kept)
}

// opensRegex reports whether a `/` after this character starts a regular
// expression rather than dividing.
//
// A value cannot be divided by nothing, so a `/` that follows an operator, an
// opening bracket, a comma or nothing at all opens a pattern. After a name, a
// number or a closing bracket it divides. Keywords that end a statement
// (`return /x/`) fall under the empty case only at the start of a file; the
// remaining case is rare enough here that the newline recovery in regex covers
// it.
func opensRegex(significant rune) bool {
	if significant == 0 {
		return true
	}
	return strings.ContainsRune("(,=:[!&|?{};+-*%~^<>", significant)
}

func isSpace(char rune) bool {
	return char == ' ' || char == '\t' || char == '\n' || char == '\r'
}

// commentText is the comment on each 1-indexed line.
func commentText(source string) map[int]string {
	byLine, _ := scanSource(source)
	return byLine
}

// codeOutside is the source with every comment removed.
func codeOutside(source string) string {
	_, outside := scanSource(source)
	return outside
}

// hasHangul reports whether the text holds a Korean syllable.
func hasHangul(text string) bool {
	for _, char := range text {
		if char >= 0xAC00 && char <= 0xD7A3 {
			return true
		}
	}
	return false
}

// sortedLines is the deterministic order for reporting a file's findings.
func sortedLines(byLine map[int]string) []int {
	lines := make([]int, 0, len(byLine))
	for line := range byLine {
		lines = append(lines, line)
	}
	for i := 1; i < len(lines); i++ {
		for j := i; j > 0 && lines[j] < lines[j-1]; j-- {
			lines[j], lines[j-1] = lines[j-1], lines[j]
		}
	}
	return lines
}
