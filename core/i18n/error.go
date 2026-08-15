package i18n

// Error is a refusal that holds its key instead of a finished sentence.
//
// A handler runs before the reader of the answer is determined: the same
// refusal goes to a window, to `sok`, and to a log line in one process.
// Formatting the sentence in the handler picks a language there, and the
// transport can no longer render it for the caller that actually asked.
//
// Error() answers English so a log line and a %v stay readable, and so this
// value is an ordinary error to every package that does not know about
// languages.
type Error struct {
	Key    string
	Params map[string]string
	// Cause keeps the underlying error for errors.Is and errors.As. It is not
	// rendered: a caller reads the sentence, and the cause is for the log.
	Cause error
}

func (e *Error) Error() string { return T(English, e.Key, e.Params) }

func (e *Error) Unwrap() error { return e.Cause }

// In renders this refusal for one caller.
func (e *Error) In(language Language) string { return T(language, e.Key, e.Params) }

// Errorf builds a refusal from a declared key.
func Errorf(key string, params map[string]string) *Error {
	return &Error{Key: key, Params: params}
}

// Wrap builds a refusal that keeps a cause.
func Wrap(cause error, key string, params map[string]string) *Error {
	return &Error{Key: key, Params: params, Cause: cause}
}

// Render answers what a caller in this language should read for any error.
//
// An error with no key is rendered as it stands. That is deliberate:
// this build has sentences that are not translated yet, and answering an empty
// string for them would turn a partial migration into a silent one.
func Render(err error, language Language) string {
	if err == nil {
		return ""
	}
	var carried *Error
	if as(err, &carried) {
		return carried.In(language)
	}
	return err.Error()
}
