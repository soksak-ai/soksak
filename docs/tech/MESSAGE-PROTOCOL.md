---
kind: canonical
status: active
canonical: self
---

# Message protocol

Korean edition: [`MESSAGE-PROTOCOL_KO.md`](MESSAGE-PROTOCOL_KO.md). English is canonical.

The shape of every command exchange, whichever transport carries it. The wire itself is
CONTROL-PROTOCOL.md; this is what travels on it.

An agent and a remote client are first-class callers here, not an afterthought. That is the whole
reason the shape is fixed: a caller that has to guess reads a different structure per command and
writes a parser per command.

## M1. Request

```
{ command: string, params: Record<name, value> }
```

`params` is validated centrally against the command's declared `ParamSpec`
(`{type, description, required?, enum?, default?}`): undeclared keys are refused, required ones
enforced, defaults filled. A handler never validates its own arguments, so no two handlers can
disagree about what "missing" means.

## M2. Response, one shape for success and failure

```
{ ok: boolean, code: string, message: string, window: string, data?: object, hint?: [{cmd, why}] }
```

Success and failure share the shape; only `data` and `hint` are optional.

- `ok` is explicit. Inferring it from an empty error makes a null result and a silent failure the
  same payload.
- `code` is a name, not prose. It is what a caller branches on.
- `message` is for a person: what is missing and who has to do what next (see the style rule in
  `refusalMessages.test.ts`).
- `window` names the window that answered. Without it, an answer from a multi-window process cannot
  be attributed.
- `hint` offers follow-up commands. It is a suggestion, never an instruction: the receiver — person
  or agent — decides.

## M3. Progress, for streaming commands only

```
{ kind: "command.progress", command, seq, ts, delta }
```

A long command reports what it is doing rather than only what it produced. `delta` carries the
content alone — a URL, a node title — and no framing words, because the feed renders
`<command>: <delta>` and the command name already supplies the context.

A single-shot command emits no delta. Sources are sidecar events, terminal output, and agent
streaming.

## M4. Correlation

Everything that follows from one turn carries that turn's id as `parentId`. The spawn environment
(`SOKSAK_PARENT`) carries it through `sok` → socket → registry, so a command executed by a child
process is folded into the turn that caused it.

Without a parent id, a consumer folds by window, command name and time window — a heuristic, and
documented as one.

## M5. The message belongs to the command

A message is written by the command that answers, not by the transport and not by the consumer. A
consumer that writes its own sentence for a result it did not produce will be wrong the first time
the command's behaviour changes and no one updates the consumer.
