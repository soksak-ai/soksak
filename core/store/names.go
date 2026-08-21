package store

import (
	"fmt"
	"strings"

	"github.com/soksak-ai/soksak-core/core/i18n"
)

// Name rules for everything that arrives in SQL as an identifier or a path.
//
// One rule per name, in one place. Two copies drift, and a drifted rule lets
// one surface create a name another surface cannot address. A measurement
// measured exactly that: an import planted a namespace no command could read or
// delete, because every command validated and the creating path did not.

// A collection produces an index name (`idx_<cid>_<field>`) and is beside a
// virtual table name, so `[a-z0-9_]` is the whole set. It is disjoint from the
// namespace set, which allows `-`: a collection therefore cannot collide with a
// meta key.
func validateCollection(coll string) error {
	if coll == "" {
		return i18n.Errorf("store.name.collectionEmpty", nil)
	}
	for _, r := range coll {
		if (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '_' {
			return i18n.Errorf("store.name.collectionInvalid", map[string]string{"name": fmt.Sprintf("%q", coll)})
		}
	}
	return nil
}

// A field name is interpolated into a JSON path (`$.<field>`) and into an index
// name, so nothing escapes it — the whitelist is the defence. `id`, `created`
// and `updated` are real columns and need no declaration.
func validateField(field string) error {
	if field == "" {
		return i18n.Errorf("store.name.fieldEmpty", nil)
	}
	for index, r := range field {
		alpha := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z')
		digit := r >= '0' && r <= '9'
		switch {
		case alpha || r == '_':
		case digit && index > 0:
		default:
			return i18n.Errorf("store.name.fieldInvalid", map[string]string{"name": fmt.Sprintf("%q", field)})
		}
	}
	return nil
}

// A plugin identifier becomes a directory name under plugins-data. Path escape
// is blocked by the character set itself: there is no `.` and no `/`, so `..`
// is gone before any rule looks for it.
func validatePluginID(id string) error {
	if id == "" {
		return i18n.Errorf("store.name.pluginIdEmpty", nil)
	}
	for index, r := range id {
		lower := r >= 'a' && r <= 'z'
		digit := r >= '0' && r <= '9'
		switch {
		case lower || digit:
		case r == '-' && index > 0:
		default:
			return i18n.Errorf("store.name.pluginIdInvalid", map[string]string{"id": fmt.Sprintf("%q", id)})
		}
	}
	return nil
}

// A storage key becomes `<key>.json`. `.` is an allowed character, so bare `.`
// and `..` are refused by name — the character set alone does not catch them.
func validatePluginKey(key string) error {
	if key == "" || key == "." || key == ".." {
		return i18n.Errorf("store.name.storageKeyInvalid", map[string]string{"key": fmt.Sprintf("%q", key)})
	}
	for _, r := range key {
		alpha := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z')
		digit := r >= '0' && r <= '9'
		if !alpha && !digit && r != '.' && r != '_' && r != '-' {
			return i18n.Errorf("store.name.storageKeyCharacter", map[string]string{"key": fmt.Sprintf("%q", key), "char": fmt.Sprintf("%q", r)})
		}
	}
	return nil
}

// quoteIdentifier wraps a table or index name for PRAGMA and REINDEX. The store
// holds tables a plugin's define created, so their names are not ours to trust
// even though our own rules made them.
func quoteIdentifier(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}
