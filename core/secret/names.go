package secret

import (
	"strconv"

	"github.com/soksak-ai/soksak-core/core/i18n"
)

// One rule for the two names a secret is addressed by.
//
// Every record is in a single store namespace under the row key
// `<ns>/<key>`, so `/` is the separator and nothing that could carry one may
// pass. The character set is the whole defence: with no `/` in either half,
// `..` has nothing to escape through and one namespace cannot be spelled so
// that it reads as the start of another.

// vaultNamespace is where the sealed records live in core/store.
//
// One namespace and a prefix rather than one namespace per caller: the row key
// rule is then in one place, and listing a caller's keys is one prefix scan
// instead of a namespace enumeration that would also have to say which
// namespaces are the vault's.
const vaultNamespace = "secrets"

const separator = "/"

// A namespace is a plugin id or `core`. It matches core/store's namespace rule
// deliberately — the same spelling has to address the same owner on both sides
// — and this copy is about the separator, which is this package's alone.
func validateNamespace(ns string) error {
	if ns == "" {
		return i18n.Errorf("secret.namespace.empty", nil)
	}
	for index, r := range ns {
		lower := r >= 'a' && r <= 'z'
		digit := r >= '0' && r <= '9'
		switch {
		case lower || digit:
		case r == '-' && index > 0:
		default:
			return i18n.Errorf("secret.namespace.illegal", map[string]string{"ns": ns})
		}
	}
	return nil
}

// A key names one secret inside a namespace. `.` is allowed, so bare `.` and
// `..` are refused by name — the character set alone does not catch them.
func validateKey(key string) error {
	if key == "" || key == "." || key == ".." {
		return i18n.Errorf("secret.key.notAName", map[string]string{"key": key})
	}
	for _, r := range key {
		alpha := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z')
		digit := r >= '0' && r <= '9'
		if !alpha && !digit && r != '.' && r != '_' && r != '-' {
			return i18n.Errorf("secret.key.illegalCharacter", map[string]string{"key": key, "char": strconv.QuoteRune(r)})
		}
	}
	return nil
}

// address is the pair a record is stored at and bound to.
func address(ns, key string) (string, error) {
	if err := validateNamespace(ns); err != nil {
		return "", err
	}
	if err := validateKey(key); err != nil {
		return "", err
	}
	return ns + separator + key, nil
}

// namespacePrefix is what a namespace's rows all start with. It ends in the
// separator, so `a` never matches `ab`'s rows.
func namespacePrefix(ns string) (string, error) {
	if err := validateNamespace(ns); err != nil {
		return "", err
	}
	return ns + separator, nil
}
