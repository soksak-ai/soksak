package install

// What blocks this file, measured against this repository on 2026-08-15.
//
// The fact is spelled into each reason below rather than referenced, because
// the reason travels alone: it arrives at a caller as the text of an error, with
// no file to look in.
//
// Two blockages are gone. plugin_scan reads unit directories under
// <home>/plugins as of 2026-08-15 (core/scan.Units), so a committed install is
// loadable; unit_source_set and unit_source_list write and read the declaration
// at <home>/config/development-units.json as of the same day, so a working tree
// can stand in for one.

// unbuilt is what this group refuses, and the fact that blocks each one.
//
// A refusal is not a smaller version of the command. Every entry here would
// otherwise be a handler that writes to disk, answers success, and leaves the
// user looking for a plugin that is installed and not loaded — which is a worse
// state than the feature being absent, because it looks like a defect in the
// unit rather than a gap in the build.
var unbuilt = []struct{ name, blockedBy string }{
	{
		"plugin_scaffold",
		"unit_source_set now declares a working tree, so the declaration half of this command is " +
			"served; what is missing is the scaffold itself — the manifest, the entry file and the " +
			"build script a new unit starts from. Port the scaffold",
	},
	{
		"unit_install_begin",
		installTransactionBlocked,
	},
	{
		"unit_install_stage",
		installTransactionBlocked,
	},
	{
		"unit_install_read_utf8",
		installTransactionBlocked,
	},
	{
		"unit_install_commit",
		installTransactionBlocked,
	},
	{
		"unit_install_rollback",
		installTransactionBlocked,
	},
}

// installTransactionBlocked is one reason because it is one blockage.
//
// The five commands share a single in-process transaction: begin opens it,
// stage fills it, read_utf8 inspects it, and commit or rollback ends it.
// Serving the front of that sequence without the end is not partial progress —
// it is a download that can only ever be thrown away, and it reports success at
// every step until the last one. So they land together or not at all.
const installTransactionBlocked = "unit installation is one transaction across five commands (begin, stage, read_utf8, commit, rollback) and none of the five is ported yet. Serving the front of the sequence without commit would leave a staged download that can only be rolled back. Port the five together"
