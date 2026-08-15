package secret

import (
	"encoding/json"
	"fmt"
	"io"
)

// Key material never prints.
//
// A key written to a log line, a panic, or an activity entry is a leaked key,
// and one `%v` on a struct that happens to hold one is enough to put it there.
// Forbidding that in a review catches it until the day it does not, so the
// bytes live behind a type that answers a fixed label for every verb instead.
//
// fmt.Formatter rather than fmt.Stringer: Stringer is consulted for %v, %s, %q,
// %x and %X only, so `%d` on a struct holding a Stringer would still print the
// byte values. A Formatter is asked first, for every verb there is.

const redacted = "[redacted]"

// material is key bytes — the device key, or one record's data key.
type material struct{ bytes []byte }

func (material) Format(state fmt.State, verb rune) {
	_, _ = io.WriteString(state, redacted)
}

// MarshalJSON covers the other way out. A command answer is JSON, and
// encoding/json does not consult Formatter.
func (material) MarshalJSON() ([]byte, error) {
	return json.Marshal(redacted)
}

func (held material) empty() bool { return len(held.bytes) == 0 }

// Format makes the vault print as a vault.
//
// The device key is cached in an unexported field, and fmt cannot call a method
// on one: it uses reflection on the field and prints the bytes. So the redaction has
// to sit on the value a caller actually holds, which is this one — Register
// hands back a *Vault and a host is free to put it in a message.
func (vault *Vault) Format(state fmt.State, verb rune) {
	_, _ = io.WriteString(state, "secret.Vault"+redacted)
}
