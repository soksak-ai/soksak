---
kind: canonical
status: active
canonical: MESSAGE-PROTOCOL.md
---

# Message protocol

English canonical: [`MESSAGE-PROTOCOL.md`](MESSAGE-PROTOCOL.md). Where the two differ, English wins.

The shape every command exchange has, whichever transport moves it. The wire itself is CONTROL-PROTOCOL.md, and this is what travels
on top of it.

An agent and a remote client are callers too. That is the reason the shape is fixed — a caller that has to guess
caller reads a different structure per command and writes a parser per command.

## M1. Request

```
{ command: string, params: Record<name, value> }
```

`params` is validated against the `ParamSpec` (`{type, description, required?, enum?, default?}`) that command declared
is validated centrally. Undeclared keys are refused, required ones enforced, defaults filled. A handler that validates its own arguments
validate its own arguments, so no two handlers can disagree about what "missing" means.

## M2. Response — one shape for success and failure

```
{ ok: boolean, code: string, message: string, window: string, data?: object, hint?: [{cmd, why}] }
```

Success and failure share the shape, and only `data` and `hint` are optional.

- `ok` is explicit. Inferring it from an empty error makes a success with a null result and a silent failure the same payload.
- `code` is a name, not prose. It is the value the caller branches on.
- `message` is read by a person — what is missing and who must do what (the prose rules are
  `refusalMessages.test.ts`).
- `window` identifies the window that answered. Without it, an answer from a multi-window process cannot be attributed.
- `hint` offers a follow-up command. It is a suggestion, not an instruction, and the receiving side (person or agent) chooses.

## M3. Progress — streaming commands only

```
{ kind: "command.progress", command, seq, ts, delta }
```

A long command reports what it is doing, not only what it produced. `delta` holds the content alone — a URL, a node title —
and no framing words. The feed renders `<command>: <delta>`, so the command name already gives the context.

A single-shot command emits no delta. The sources are sidecar events, terminal output, and agent streaming.

## M4. Correlation

Everything that follows from one turn holds that turn's id as `parentId`. The spawn environment is `SOKSAK_PARENT`.
It passes that through `sok` → socket → registry, so even a command a child process ran is recorded on the turn that caused it
is folded in.

Without a parent id, a consumer folds by window, command name and time window. It is a heuristic, and it is written down as one.

## M5. The sentence is the command's

A message is written by the command that answers. Neither the transport nor the consumer writes it. A consumer that attaches its own sentence
a consumer that attaches one is wrong from the first moment that command's behaviour changes and no one updates the consumer.
