package store

import "testing"

// A collection name goes into an index name and into the FTS table's
// neighbourhood, so its character set is the whole defence. It is disjoint from
// the namespace set (no `-`) so a collection cannot collide with a meta key.
func TestCollectionNamesAreConstrained(t *testing.T) {
	for _, good := range []string{"messages", "t", "a_b", "x9"} {
		if err := validateCollection(good); err != nil {
			t.Errorf("collection %q was refused: %v", good, err)
		}
	}
	for _, bad := range []string{"", "Messages", "a-b", "a.b", "a/b", "a b", "레코드"} {
		if err := validateCollection(bad); err == nil {
			t.Errorf("collection %q was accepted", bad)
		}
	}
}

// A field name is interpolated twice — into a JSON path (`$.field`) and into an
// index name — so it is a strict whitelist rather than an escape.
func TestFieldNamesAreConstrained(t *testing.T) {
	for _, good := range []string{"title", "_x", "a1", "createdBy"} {
		if err := validateField(good); err != nil {
			t.Errorf("field %q was refused: %v", good, err)
		}
	}
	for _, bad := range []string{"", "1a", "a-b", "a.b", "a'); DROP TABLE records;--", "제목"} {
		if err := validateField(bad); err == nil {
			t.Errorf("field %q was accepted", bad)
		}
	}
}

// The plugin id's character set holds no `.` and no `/`, so `..` is gone before
// any rule looks for it.
func TestPluginIdentifiersAreConstrained(t *testing.T) {
	for _, good := range []string{"memo", "git-2", "a0"} {
		if err := validatePluginID(good); err != nil {
			t.Errorf("plugin id %q was refused: %v", good, err)
		}
	}
	for _, bad := range []string{"", "-a", "A", "a/b", "a..b", "../etc", "한글"} {
		if err := validatePluginID(bad); err == nil {
			t.Errorf("plugin id %q was accepted", bad)
		}
	}
}

// `.` is an allowed character in a storage key, so bare `.` and `..` are
// refused by name — the character set alone does not catch them.
func TestPluginStorageKeysAreConstrained(t *testing.T) {
	for _, good := range []string{"notes", "a.b", "a_b-c", "v1.2.3"} {
		if err := validatePluginKey(good); err != nil {
			t.Errorf("key %q was refused: %v", good, err)
		}
	}
	for _, bad := range []string{"", ".", "..", "a/b", "a b", "키"} {
		if err := validatePluginKey(bad); err == nil {
			t.Errorf("key %q was accepted", bad)
		}
	}
}

// Table and index names reach PRAGMA and REINDEX as identifiers. They are ours,
// but the store also holds tables a plugin's define created.
func TestIdentifiersAreQuoted(t *testing.T) {
	if got := quoteIdentifier(`re"cords`); got != `"re""cords"` {
		t.Errorf("quoteIdentifier = %s", got)
	}
}
