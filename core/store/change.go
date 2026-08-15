package store

// The shape of "something in the store changed".
//
// More than one place makes this fact, and a subscriber cannot tell which. If
// the shape or the operation names differ between makers, the same subscriber
// code sees different things depending on who answered — and that difference is
// not an error, it is a view that stops updating.

// WholeStore is the namespace for a change nobody can pin. Import and restore
// replace the store outright: saying nothing leaves another reader holding the
// old values as true, and naming a namespace makes subscribers re-read the
// wrong thing.
const WholeStore = "*"

// The operation names. Measured on an earlier build (2026-08-01): the app
// published `kv_set` and the daemon published `kv-set`. Nothing had broken,
// because subscribers filtered on namespace — but the first one to read `op`
// would behave differently depending on who answered, and by then nobody would
// trace it back to two spellings.
const (
	OpKVSet    = "kv_set"
	OpKVDelete = "kv_delete"
	OpNsRemove = "ns_remove"
	OpPut      = "put"
	OpDelete   = "delete"
	OpReap     = "reap"
	OpTrim     = "trim"
	OpImport   = "import"
	OpRestore  = "restore"
)

// Change is one published fact. The axes an operation has no value for are
// carried as null rather than dropped: drop the key and the receiving side
// cannot tell "this operation has no collection" from "whoever sent this forgot
// to fill it in" — one is normal and one is a defect.
type Change struct {
	Ns    string  `json:"ns"`
	Coll  *string `json:"coll"`
	Scope *string `json:"scope"`
	Op    string  `json:"op"`
	ID    *string `json:"id"`
}

// OpNsMigrate names a namespace being moved onto another name.
//
// An earlier build published this one as a bare `"ns-migrate"` literal beside
// the module whose whole reason is that these names are constants — the same
// drift, one file over, in the other spelling. It is a constant here, and
// spelled like its siblings.
const OpNsMigrate = "ns_migrate"
