package install

// The two facts that block everything in this file, measured against this
// repository on 2026-08-15.
//
// noDirectoryLoader: the only command in this build that loads a plugin is
// plugin_scan, and it is scan.Directory(<home>/plugins, ".json") — it reads
// files and skips directories outright. Every acquisition path here produces a
// unit *directory*. So the write succeeds, the answer is a success, and the
// unit is loaded by nobody.
//
// noDevDeclaration: unit_dev_set is not served in this build. A unit tree that
// is not declared as a development source is not read by unit_dev_list either,
// which is scan.Directory(<home>/units, ".json").
//
// Both are spelled into each reason below rather than referenced, because the
// reason travels alone: it reaches a caller as the text of an error, with no
// file to look in.
const (
	noDirectoryLoader = "this build's only plugin loader is plugin_scan, which reads <home>/plugins/*.json and skips directories, so an installed unit directory is loaded by nobody"
	noDevDeclaration  = "this build serves no unit_dev_set, so a scaffolded tree cannot be declared as a development source and unit_dev_list (which reads <home>/units/*.json) never sees it"
)

// unbuilt is what this group refuses, and the fact that blocks each one.
//
// A refusal is not a smaller version of the command. Every entry here would
// otherwise be a handler that writes to disk, answers success, and leaves the
// user looking for a plugin that is installed and not loaded — which is a worse
// state than the feature being absent, because it looks like a defect in the
// unit rather than a gap in the build.
var unbuilt = []struct{ name, blockedBy string }{
	{
		"plugin_dev_new",
		"scaffolding is half of this command and the declaration is the other half: " + noDevDeclaration +
			"; " + noDirectoryLoader + ". Serve unit_dev_set and give the loader a directory form, then port the scaffold",
	},
	{
		"plugin_dev_new2",
		"the releasable scaffold emits release-files.json and a release workflow that reference a publish pipeline this build has none of, and the scaffold itself is blocked before that: " + noDevDeclaration +
			". Serve unit_dev_set and name a release pipeline, then port the scaffold",
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
const installTransactionBlocked = "unit installation is one transaction across five commands (begin, stage, read_utf8, commit, rollback) and it cannot end here: commit publishes each unit as a directory at <home>/plugins/<id>, and " +
	noDirectoryLoader + ". Serving the front of the sequence without commit would leave a staged download that can only be rolled back. Give the loader a directory form, then port the five together"
