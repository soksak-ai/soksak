package files

import "fmt"

// Outcome is what one run answered. Stdout is carried because `command -v`
// prints the resolved path, even though the verdict below reads only the exit
// status.
type Outcome struct {
	ExitCode int
	Stdout   string
}

// Runner runs one program to completion.
//
// It is an interface because assembling the argv is the rule and spawning is
// not: spawning belongs to whoever owns processes. That split is what lets
// every rule here be checked with no shell on the machine.
//
// A returned error means the program could not be run at all. A program that
// ran and failed answers through Outcome.ExitCode — collapsing the two would
// make one wrong shell path report every binary as missing.
type Runner interface {
	Run(program string, args []string) (Outcome, error)
}

// safeBinaryName says whether a name may be interpolated into a shell line.
//
// Without this check `;`, `$(`, and backticks become shell syntax, and the
// result is not a refusal but the execution of a different command.
func safeBinaryName(bin string) bool {
	if bin == "" {
		return false
	}
	for _, letter := range bin {
		switch {
		case letter >= 'a' && letter <= 'z':
		case letter >= 'A' && letter <= 'Z':
		case letter >= '0' && letter <= '9':
		case letter == '-' || letter == '_' || letter == '.':
		default:
			return false
		}
	}
	return true
}

// whichArgv assembles "is this binary on the user's PATH".
//
// The platform is an argument. Branching on runtime.GOOS would answer "what
// this binary is" rather than what the caller asked, and would make the same
// build unable to show both shapes at once.
//
// On unix `-l` is the load-bearing flag: the login shell re-reads rc/profile
// and builds PATH from scratch, so a process launched from the GUI with a
// narrow PATH still answers what the user's terminal answers.
//
// Windows has no login shell whose rc rebuilds PATH, so there is nothing for
// `-l` to do and no shell line to build: where.exe takes the name as an argv
// element, which leaves no place for shell syntax at all. Handing COMSPEC
// (cmd.exe) a PowerShell-only `-Command Get-Command` flag is a
// pairing that cannot succeed — so every binary read as missing on Windows.
func whichArgv(shell string, bin string, windows bool) (string, []string, error) {
	if !safeBinaryName(bin) {
		return "", nil, fmt.Errorf("shell_which: %q is not a binary name — only letters, digits, '-', '_' and '.'", bin)
	}
	if windows {
		return "where.exe", []string{bin}, nil
	}
	if shell == "" {
		return "", nil, fmt.Errorf("shell_which needs a login shell and this process was not given one — set files.Deps.LoginShell")
	}
	return shell, []string{"-lc", "command -v " + bin}, nil
}

// shellWhich answers whether the binary is on the user's PATH.
//
// Three answers stay separate. A name that cannot be asked is an error, not
// false — answering false conflates the two, as a measured build did in its own
// comment. A shell that cannot start is an error, not false, because one wrong
// injected path would otherwise report every binary as missing, which reads as
// "nothing is installed" instead of as a misconfiguration. Only a shell that
// ran and answered non-zero is false.
func shellWhich(bin string, shell string, windows bool, runner Runner) (bool, error) {
	if runner == nil {
		return false, fmt.Errorf("shell_which cannot run anything in this build — set files.Deps.Run")
	}
	program, args, err := whichArgv(shell, bin, windows)
	if err != nil {
		return false, err
	}
	outcome, err := runner.Run(program, args)
	if err != nil {
		return false, fmt.Errorf("shell_which could not run %s: %w", program, err)
	}
	return outcome.ExitCode == 0, nil
}
