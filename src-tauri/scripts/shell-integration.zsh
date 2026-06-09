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

# OSC 7: report cwd as a file URI. Percent-encode bytes outside the unreserved
# set so paths with spaces/non-ascii survive.
__vsterm_osc7() {
  local path="${PWD}" enc="" i ch
  for (( i = 1; i <= ${#path}; i++ )); do
    ch="${path[i]}"
    case "$ch" in
      [a-zA-Z0-9/._~-]) enc+="$ch" ;;
      *) enc+=$(builtin printf '%%%02X' "'$ch") ;;
    esac
  done
  builtin print -n "\e]7;file://${HOST}${enc}\a"
}

# preexec: user submitted a command, before it runs → output begins (C).
__vsterm_preexec() {
  __vsterm_osc133 "C"
  __vsterm_preexec_ran=1
}

# precmd: a command finished (or first prompt) → emit D with exit code, cwd,
# then re-wrap the prompt with A (start) / B (end) markers.
__vsterm_precmd() {
  local exit_code=$?
  if [[ -n "${__vsterm_preexec_ran:-}" ]]; then
    __vsterm_osc133 "D;${exit_code}"
    unset __vsterm_preexec_ran
  else
    __vsterm_osc133 "D"
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
