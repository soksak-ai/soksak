package install

import (
	"fmt"
	"strings"

	"github.com/soksak/soksak-core/core/files"
	"github.com/soksak/soksak-core/core/i18n"
)

// NpmDirs is where npm puts globally installed packages.
//
// The field names are the wire names the caller composes paths from:
// `<binDir>/<bin>` for the launcher and `<libDir>/node_modules/<package>` for
// the tree. Those two compositions are why this answers directories rather than
// the prefix — the shape of the join is npm's rule, not the caller's.
type NpmDirs struct {
	BinDir string `json:"bin_dir"`
	LibDir string `json:"lib_dir"`
}

// npmGlobalDirs queries the user's login shell for npm's global prefix.
//
// The login shell is the whole point. A process launched from a desktop
// environment inherits a PATH that does not include a version manager's shims,
// so asking directly would answer about a machine the user does not have. `-l`
// makes the shell re-read rc/profile and build PATH from nothing, which is why
// this answers what the user's terminal answers.
// What is missing is named in the order the command needs it — platform, then
// shell, then a way to run one — so a Windows host hears about its layout
// rather than about a runner it would not have used.
func npmGlobalDirs(shell string, goos string, runner files.Runner) (NpmDirs, error) {
	program, args, err := npmPrefixArgv(shell, goos)
	if err != nil {
		return NpmDirs{}, err
	}
	if runner == nil {
		return NpmDirs{}, i18n.Errorf("install.npm.noRunner", nil)
	}
	outcome, err := runner.Run(program, args)
	if err != nil {
		// One wrong shell path would otherwise report "npm is not installed",
		// which sends the user to install a thing they already have.
		return NpmDirs{}, fmt.Errorf("npm_global_dirs could not run %s: %w", program, err)
	}
	if outcome.ExitCode != 0 {
		return NpmDirs{}, i18n.Errorf("install.npm.exitCode", map[string]string{"program": program, "code": fmt.Sprintf("%d", outcome.ExitCode)})
	}
	return npmDirsFromPrefix(outcome.Stdout)
}

// npmPrefixArgv assembles the question.
//
// The platform is an argument. Branching on runtime.GOOS would answer what this
// binary is rather than what the caller asked, and would make the same build
// unable to show both shapes at once.
//
// Windows is refused rather than guessed. npm's global layout there is
// `<prefix>\<name>.cmd` and `<prefix>\node_modules\<package>` — neither the
// `bin`/`lib` join below nor the bare launcher name that binary_integrity would
// then stat. Answering the unix shape would make every installed tool read as
// missing, which is a wrong answer wearing the clothes of a fact. The shape has
// to be measured on a Windows machine before it can be named here.
func npmPrefixArgv(shell string, goos string) (string, []string, error) {
	if goos == "" {
		return "", nil, i18n.Errorf("install.npm.noPlatform", nil)
	}
	if goos == "windows" {
		return "", nil, i18n.Errorf("install.npm.noWindowsLayout", nil)
	}
	if shell == "" {
		return "", nil, i18n.Errorf("install.npm.noLoginShell", nil)
	}
	return shell, []string{"-lc", "npm prefix -g"}, nil
}

// npmDirsFromPrefix splits `npm prefix -g` output into the two directories.
//
// Empty output is npm absent or unable to answer, never a prefix of "". Letting
// it through builds "/bin" and "/lib", and an integrity check would then read
// the system directories and report a user's tool as installed there — a false
// present, which is the one answer this group must never give.
func npmDirsFromPrefix(stdout string) (NpmDirs, error) {
	// The last line with anything on it. A login shell runs the user's profile
	// first, and whatever that prints arrives ahead of npm's answer — taking
	// the first line would hand a version manager's greeting back as a path.
	prefix := ""
	for _, line := range strings.Split(stdout, "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			prefix = trimmed
		}
	}
	if prefix == "" {
		return NpmDirs{}, i18n.Errorf("install.npm.emptyPrefix", nil)
	}
	return NpmDirs{BinDir: prefix + "/bin", LibDir: prefix + "/lib"}, nil
}
