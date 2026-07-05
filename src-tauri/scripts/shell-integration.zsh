# vsterm shell integration for zsh — emits the cross-terminal OSC 133 semantic
# prompt sequences plus OSC 7 (cwd). The frontend also parses editor's OSC 633,
# but we emit the portable standard here.
#
# OSC 133 (FinalTerm / iTerm2 semantic prompt):
#   A          prompt start
#   B          prompt end (command input begins)
#   C          command output begins (pre-execution)
#   D;<exit>   command finished, with exit code
# OSC 7:
#   file://<host><path>   current working directory
#
# Loaded via ZDOTDIR: vsterm writes a temporary .zshrc that sources the user's
# real zsh startup files first, then this script, so the user's config is intact.

if [[ -n "${VSTERM_SHELL_INTEGRATION:-}" ]]; then
  return 0
fi
VSTERM_SHELL_INTEGRATION=1

__vsterm_osc133() { builtin print -n "\e]133;$1\a"; }

# Percent-encode a string, preserving the unreserved set — shared by OSC 7 (cwd)
# and OSC 633;E (command line) so paths/commands with spaces/non-ascii survive.
__vsterm_pctenc() {
  local s="$1" enc="" i ch
  for (( i = 1; i <= ${#s}; i++ )); do
    ch="${s[i]}"
    case "$ch" in
      [a-zA-Z0-9/._~-]) enc+="$ch" ;;
      *) enc+=$(builtin printf '%%%02X' "'$ch") ;;
    esac
  done
  builtin print -n "$enc"
}

# OSC 7: report cwd as a file URI.
__vsterm_osc7() {
  builtin print -n "\e]7;file://${HOST}$(__vsterm_pctenc "${PWD}")\a"
}

# OSC 633;E: report the just-submitted command line (percent-encoded). The frontend
# re-emits this as a generic plugin "command.started" event so plugins (e.g. a
# claude GUI) can react to specific commands — the core itself stays domain-agnostic.
__vsterm_osc633E() {
  builtin print -n "\e]633;E;$(__vsterm_pctenc "$1")\a"
}

# preexec: user submitted a command, before it runs. $1 = the command line as
# submitted → report it (E), then mark command output begin (C).
__vsterm_preexec() {
  __vsterm_osc633E "$1"
  __vsterm_osc133 "C"
  __vsterm_preexec_ran=1
}

# precmd: re-wrap the prompt (A/B) and report cwd every cycle. D (command finished)
# is emitted ONLY when a command actually ran (preexec marked C) — FinalTerm semantics:
# D pairs with C. The first prompt and empty-Enter cycles run precmd without preexec;
# emitting D there fabricates "a command finished" out of nothing, and every consumer
# downstream (activity stream, narration, turn detection) inherits the lie.
__vsterm_precmd() {
  local exit_code=$?
  if [[ -n "${__vsterm_preexec_ran:-}" ]]; then
    __vsterm_osc133 "D;${exit_code}"
    unset __vsterm_preexec_ran
  fi
  __vsterm_osc7
  PS1="%{$(__vsterm_osc133 'A')%}${__vsterm_original_ps1}%{$(__vsterm_osc133 'B')%}"
}

__vsterm_original_ps1="${PS1}"

autoload -Uz add-zsh-hook 2>/dev/null
if (( $+functions[add-zsh-hook] )); then
  add-zsh-hook preexec __vsterm_preexec
  add-zsh-hook precmd __vsterm_precmd
fi
