# BB mirror

Back to the [README](../README.md).

BB (the `bb` command) is the agent harness this office's owner runs their threads,
projects and environments in. With `--bb`, the building stops being a building of GitHub repos
and becomes a live picture of that BB instead — you walk around your own agent world:

```bash
agent-office --bb
```

The `bb` command has to be on the PATH of the user that runs the office, signed in — that's the
only requirement. Nothing else changes: same office, same password, same controls.

## What you see

- **A floor per BB project.** The elevator lists them (up to the twelve busiest), named as BB
  knows them. A floor's boards still show the GitHub issues and pull requests of the project's
  repository, like any floor's.
- **A desk per BB thread.** The threads that matter — the ones waiting on you, running, pinned,
  or touched in the last week — sit at the desks, at most sixteen per floor. Quieter threads sit
  them out (spawn one from BB and it walks in within seconds). A thread keeps the same desk as
  long as it stays, whoever else arrives.
- **What a thread is doing, at a glance.** Working, waiting on you, or done shows like it does
  for a hired worker: the glow over the desk, the red beacon and the alarm when it needs you,
  and **N** jumps you there. The thread's title is its task, its BB provider its face (Pi, Claude,
  Codex). Its terminal (walk up, **E**) shows what the thread has been doing, as BB logged it.
- **Read-only by design.** This is a window onto BB, not a remote control: typing into a
  mirrored terminal tells you so, and nothing you do in the office launches, stops or changes a
  real BB thread. Hiring at a desk in `--bb` mode works as it always did — that worker is the
  office's own, in the floor's checkout, not a BB thread.

## How it works

Every few seconds the office runs `bb thread list --json` (and `bb project list --json` once a
minute) and seats what changed; a watched terminal follows `bb thread log`. The floors are real
floors, so their writable state — boards' cache, queue, whiteboard — lives under the office's
own data directory, `<home>/bb/<project>/`, never in the BB projects' checkouts. Mirrored
workers are never persisted: restart the office and they walk back in from BB, fresh.

The wiring lives in `src/server/bbmirror.ts` (the polling and seating) and
`src/server/workers/mirror.ts` (how a mirrored thread takes a desk without being run), built on
the same seams as everything else — see [code layout](code-layout.md).

## Not in this first stage

Handing a thread new work, approving its plans, hiring through BB's roles, the task tracker on
the walls: those are the next stages, tracked separately.
