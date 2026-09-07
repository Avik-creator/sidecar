# Changelog

All notable changes to Sidecar are recorded here. Versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] — 2026-09-08

The release that stops depending on hooks. Every harness already writes its
live state to disk, so Sidecar now reads that directly, tells you what each
agent is doing and for how long, and takes you to the window it is running in.

### Added

- **Native state readers.** Claude Code's session registry
  (`~/.claude/sessions/<pid>.json`), Codex's thread tables and lock files, and
  Cursor's composer records each set a session's state on their own. Hooks
  remain the sub-second signal for permission prompts, but nothing depends on
  them any more.
- **Process liveness.** A session whose process is gone reads as ended at once,
  and a live process keeps a busy session active however long the turn runs.
  Codex publishes no pid, so a locked thread is matched to its process by
  working directory.
- **Codex subagents** are linked to their parent through `thread_spawn_edges`.
- **An activity line per session**: `Running command · 1m 12s`, `Editing`,
  `Thinking`, `Needs permission`, `Your turn`. The tool comes from Claude
  `tool_use` blocks, Codex tool-call items, or PreToolUse hooks, and clears
  when the result arrives.
- **Facts per session**: model, tokens and estimated spend with subagents
  rolled into their parent, task progress, lines added and removed, and queued
  messages, each shown only when the harness publishes it.
- **Go to.** Click a row to bring the window running that agent to the front.
  Terminal and iTerm2 get the exact tab by tty; VS Code, Cursor, and other
  hosts come to the front. A notification click lands on the same window.
- **Copy resume** puts `claude --resume <id>` or `codex resume <id>` on the
  clipboard, with a `cd` into the session's folder.
- **Preferences**: open at login, a panel shortcut (default `Alt+Shift+S`),
  quiet hours, and a quota alert at a chosen percent of a plan window.
- **Dark mode**, following the system theme, and a translucent popover surface.
- The tray mark turns solid while any agent is working.
- Setup flags a hook that is installed but has never fired as **Installed,
  silent**, since that was the failure hiding every state on this machine.

### Changed

- **The Agents tab lists rows, not cards.** One line per session with the
  harness glyph, title, activity, and facts; a spinner or dot for state; and the
  time. Editor and Copy resume appear on hover or keyboard focus, and the arrow
  keys walk the list.
- The tab bar is a text segmented control, the wordmark is small, and the
  footer with its harness chips is gone.
- The bell badge and the "Needs you" section no longer restate each other.

### Fixed

- Session state no longer stays at "Not reporting" when hooks never fire.
- The Codex note in Setup wraps at word boundaries instead of mid-word.

### Migrations

- **5** adds `state_source`, `pid`, and `last_hook_ts` to `session`, and
  backfills provenance for rows that already had a hook event.
- **6** adds `last_tool`, `tasks_done`, `tasks_total`, `queued`, `lines_added`,
  and `lines_removed` to `session`. No transcripts are re-read.

### Known limitations

- Codex and Cursor have no on-disk signal for a permission prompt, so
  **Needs permission** for them still requires the hook, which in Codex means
  trusting the entries in `/hooks`.
- Why Claude Code never runs Sidecar's hook entries is still open; the native
  readers make it non-blocking.
- Cursor CLI sessions under `~/.cursor/projects/*/agent-transcripts` are not
  ingested yet.
- Spend uses the existing price table, which prices unknown models at the
  default.

## [0.2.0] — 2026-09-06

The release that makes session state trustworthy. Sidecar used to infer what an
agent was doing by reading its transcript, which meant guessing from a file
written after the fact. It now learns state from hooks the agents fire as they
work, and installs those hooks itself.

### Added

- **Hooks install themselves at launch.** Sidecar writes its helper and repairs
  missing entries on start, for the agents whose home directory exists on the
  machine. Removing hooks from Setup turns the automatic install off so they
  stay removed.
- **Subagents are tracked as their own sessions.** Each one gets a row keyed by
  its agent id, linked to the session that spawned it and labelled with its
  type, and appears nested under its parent in the panel rather than as a peer.
  Covers Claude Code and Cursor; Codex reports subagent state through hooks but
  its parent linkage is not yet derivable from its transcripts.
- **Notifications when an agent needs you**, with a click that opens the panel.
- **Open a session in your editor or terminal** from its card.
- **A "Not reporting" section** listing recently active sessions that have never
  fired a hook, so silence is visible instead of being mistaken for idleness.
- **Setup gained a Reporting section** showing per-agent hook status, including
  the extra `/hooks` trust step Codex requires.

### Changed

- **Session state comes only from hooks.** Transcripts supply content; they no
  longer imply that a session is running. A session with no hook events reads as
  unknown rather than guessed.
- **Improve is off by default**, and never edits a global rules file unless that
  is separately enabled. It reads transcripts and writes rule files, so it stays
  off until asked for.
- **Sidecar never renews an agent's OAuth token.** It reads them to report plan
  usage and stops there; refreshing can rotate a stored token and sign you out
  of your own agent. An expired sign-in is reported, not repaired.
- Every database write runs on the worker thread, leaving the main process
  responsive.

### Fixed

- **Subagent turns no longer land on their parent's row.** Claude stamps a
  subagent's transcript with the parent's session id, so all of its turns were
  folded into the parent, and the parent's sidechain flag became whichever file
  ingested last.
- The file watcher watches source directories again; it had been watching glob
  patterns that chokidar v4 stopped supporting, so changes were missed.
- Live usage no longer reports a stale window after a probe fails.

### Performance

Measured on a real 260MB database over 400 sessions and 170,000 turns:

| | before | after |
|---|---|---|
| Cold ingest | 14.4 s | 5.3 s |
| Peak memory | 2.05 GB | 0.44 GB |
| Database size | 260 MB | 172 MB |
| Usage report | 763 ms | 71 ms |

Transcripts stream rather than loading whole, prepared statements are reused
across writes, duplicate session rows are folded before writing, the usage
report scopes its window in SQL and reuses its date formatter, and the unread
`event` table was dropped.

### Migrations

Schema versions 2 through 4 apply automatically on first launch. Version 3 drops
the `event` table and vacuums; version 4 adds subagent columns, discards turns
that were attributed to the wrong session, and re-reads the subagent
transcripts. Expect one slower launch: roughly 5 seconds on a database of the
size above, then normal.

### Known limitations

- A running agent session does not pick up newly installed hooks. Agents read
  their hook configuration at session start, so sessions already open when
  Sidecar installs them keep reading as not reporting until restarted.
- Codex requires running `/hooks` inside it and trusting the entries before any
  of them fire.
- A hook config containing comments is never rewritten automatically, since
  writing it back would drop them. Setup says so and offers a manual install.

## [0.1.1] — 2026-08-27

### Added

- Calendar-day aggregation in usage reports, and a refreshed usage panel with a
  preview harness for working on it outside Electron.
- A canonical brand mark and the pipeline that generates its assets.

### Fixed

- Claude plan limits are parsed from the live limits array, fixing empty usage
  windows.
- The live usage probe no longer times out early or serves a stale cache.
- Session recency and Cursor ingest were both too loose about what counted as
  current.

### Performance

- Refreshes coalesce instead of stacking, and ingest moved to a worker thread.

## [0.1.0] — 2026-08-20

First working version: ingest of Claude Code, Codex, and Cursor transcripts into
a local SQLite store, a live agent index, setup and hook discovery, and local
spend reporting alongside live plan usage.

[0.2.0]: https://github.com/Avik-creator/sidecar/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Avik-creator/sidecar/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Avik-creator/sidecar/releases/tag/v0.1.0
