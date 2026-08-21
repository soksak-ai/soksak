---
kind: canonical
status: active
canonical: self
---

# sok command line

sok sends one request to the application command registry. It does not implement a second command
path.

## Command names

Public commands use dotted domain names such as plugin.enable, window.snapshot and
plugin.development.set. Native backend command names may use snake case internally and are not
public CLI vocabulary.

## Parameter forms

Two forms produce the same parameter map.

Name-value form:

    sok plugin.development.set id=demo version=0.0.1 development=true path=/absolute/path

JSON object form in POSIX shells and PowerShell:

    sok plugin.development.set '{"id":"demo","version":"0.0.1","development":true,"path":"/absolute/path"}'

The JSON object must be the only argument after the command. Mixing an object and name-value
arguments is rejected. A JSON array, scalar or null is rejected.

In name-value form each value that parses as JSON keeps its JSON type. development=true is a
boolean and generation=3 is a number. Other values are strings. Quote a string that itself looks
like JSON by passing JSON string syntax.

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
