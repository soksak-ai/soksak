package install

// What blocks this file, measured against this repository on 2026-08-15.
//
// The fact is spelled into each reason below rather than referenced, because
// the reason travels alone: it arrives at a caller as the text of an error, with
// no file to look in.
//
// unbuilt is what this group refuses, and the fact that blocks each one.
//
// A refusal is not a smaller version of the command. Every entry here would
// otherwise be a handler that writes to disk, answers success, and leaves the
// user looking for a plugin that is installed and not loaded — which is a worse
// state than the feature being absent, because it looks like a plugin defect.
var unbuilt = []struct{ name, blockedBy string }{
	{
		"plugin_scaffold",
		"plugin.source.set declares a working tree, but the plugin manifest, entry file and " +
			"build files are not generated. Port plugin_scaffold",
	},
	{
		"artifact_install_begin",
		installTransactionBlocked,
	},
	{
		"artifact_install_stage",
		installTransactionBlocked,
	},
	{
		"artifact_install_status",
		installTransactionBlocked,
	},
	{
		"artifact_install_wait",
		installTransactionBlocked,
	},
	{
		"artifact_install_read_utf8",
		installTransactionBlocked,
	},
	{
		"artifact_install_commit",
		installTransactionBlocked,
	},
	{
		"artifact_install_rollback",
		installTransactionBlocked,
	},
}

// installTransactionBlocked is one reason because it is one blockage.
//
// The seven commands share a single in-process transaction: begin opens it,
// status and wait expose progress, stage fills it, read_utf8 inspects it, and commit or rollback ends it.
// Serving the front of that sequence without the end is not partial progress —
// it is a download that can only ever be thrown away, and it reports success at
// every step until the last one. So they land together or not at all.
const installTransactionBlocked = "artifact installation is one transaction across seven commands (begin, status, wait, stage, read_utf8, commit, rollback) and none of the seven is ported yet. Serving the front of the sequence without commit would leave a staged download that can only be rolled back. Port the seven together"
