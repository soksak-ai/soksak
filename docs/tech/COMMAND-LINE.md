---
kind: canonical
status: active
canonical: self
---

# sok command line

sok sends one request to the application command registry. It does not implement a second command
path.

## Command names

Public commands use dotted domain names such as plugin.enable, plugin.install.local and
window.snapshot. Native backend command names may use snake case internally and are not
public CLI vocabulary.

Local installation is a two-command transaction. `plugin.install.local.plan` or
`sidecar.install.local.plan` receives an absolute store path, exact id, and exact version and returns
the complete release closure plus a plan digest. The matching install command requires that digest.
If any release byte changes after planning, installation fails before staging. Raw source paths and
`file:` locators are not command parameters.

`sidecar.request` is the operator and system-test relay for an installed sidecar control request.
It accepts a sidecar name and one request object, forwards the object without interpreting its
command, and returns the sidecar response. Plugin code cannot call this operator command; plugins
use their declared sidecar capability instead.

## Parameter forms

Two forms produce the same parameter map.

Name-value form:

    sok plugin.install.local.plan store=/absolute/releases pluginId=demo version=0.0.1

JSON object form in POSIX shells and PowerShell:

    sok plugin.install.local.plan '{"store":"/absolute/releases","pluginId":"demo","version":"0.0.1"}'

The JSON object must be the only argument after the command. Mixing an object and name-value
arguments is rejected. A JSON array, scalar or null is rejected.

In name-value form each value that parses as JSON keeps its JSON type. generation=3 is a number.
Other values are strings. Quote a string that itself looks
like JSON by passing JSON string syntax.

The two forms are syntax alternatives for the same command schema. A command must not interpret
them differently.

Name-value form is preferred in Windows cmd because single quotes do not quote there. PowerShell
and POSIX shells may use either form. Paths with spaces are quoted as one complete name-value
argument, for example "path=C:\Work Area\plugin".

## Discovery and output

- sok commands returns the served and refused command table.
- sok help followed by a command returns its public schema.
- success writes one formatted JSON value to stdout and exits zero;
- failure writes the reason to stderr and exits nonzero.

The CLI derives the identity socket from the same identity package as the application. It does not
fall back to another installation.
