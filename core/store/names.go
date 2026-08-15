package store

import (
	"fmt"
	"strings"
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
		return fmt.Errorf("store: a collection name is empty")
	}
	for _, r := range coll {
		if (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '_' {
			return fmt.Errorf("store: collection %q is not lowercase alphanumeric with underscores", coll)
		}
	}
	return nil
}

// A field name is interpolated into a JSON path (`$.<field>`) and into an index
// name, so nothing escapes it — the whitelist is the defence. `id`, `created`
// and `updated` are real columns and need no declaration.
func validateField(field string) error {
	if field == "" {
		return fmt.Errorf("store: a field name is empty")
	}
	for index, r := range field {
		alpha := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z')
		digit := r >= '0' && r <= '9'
		switch {
		case alpha || r == '_':
		case digit && index > 0:
		default:
			return fmt.Errorf("store: field %q is not an identifier", field)
		}
	}
	return nil
}

// A plugin identifier becomes a directory name under plugins-data. Path escape
// is blocked by the character set itself: there is no `.` and no `/`, so `..`
// is gone before any rule looks for it.
func validatePluginID(id string) error {
	if id == "" {
		return fmt.Errorf("store: a plugin id is empty")
	}
	for index, r := range id {
		lower := r >= 'a' && r <= 'z'
		digit := r >= '0' && r <= '9'
		switch {
		case lower || digit:
		case r == '-' && index > 0:
		default:
			return fmt.Errorf("store: plugin id %q is not lowercase alphanumeric with hyphens", id)
		}
	}
	return nil
}

// A storage key becomes `<key>.json`. `.` is an allowed character, so bare `.`
// and `..` are refused by name — the character set alone does not catch them.
func validatePluginKey(key string) error {
	if key == "" || key == "." || key == ".." {
		return fmt.Errorf("store: storage key %q is not a name", key)
	}
	for _, r := range key {
		alpha := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z')
		digit := r >= '0' && r <= '9'
		if !alpha && !digit && r != '.' && r != '_' && r != '-' {
			return fmt.Errorf("store: storage key %q holds %q", key, r)
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
