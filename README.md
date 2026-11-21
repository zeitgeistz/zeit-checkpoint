# zeit-checkpoint

Local checkpoints for Claude Code. Every file the agent is about to edit is saved first, risky shell commands get a snapshot before they run, and any checkpoint can be diffed, previewed and rolled back — one file or the whole workspace — with an undo point saved before anything is written.

Everything stays on your machine. Nothing is uploaded, and your Git index, branches and commits are never touched.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install zeit-checkpoint --marketplace zeitgeistz/zeit-checkpoint
```

Answer `y` to add the marketplace, then pick a scope (user scope is first; Enter picks it). The mod is active in that session right away.

From a shell:

```
claude plugin install zeit-checkpoint --marketplace zeitgeistz/zeit-checkpoint
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `zeitgeistz/zeit-checkpoint`, then **Add plugin**.

**Requires** Node.js on `PATH` (the storage helper is a dependency-free Node script) and Git for `/zeit-fork`. Works on Windows, macOS and Linux.

## What it does

- **Automatic protection.** Before the first `Edit`, `Write`, `MultiEdit` or `NotebookEdit` of each file in a turn, the file's current content is saved to that turn's checkpoint. Files that did not exist yet are recorded too, so a rollback removes them. If the edit is refused, the save is dropped.
- **Shell snapshots.** Before a Bash or PowerShell command that may rewrite or delete files (`rm`, `del`, `mv`, `Remove-Item`, `git reset/checkout/clean/stash/rebase/…`, `sed -i`, `find -delete`, redirects with `>` and more), a bounded snapshot of the workspace is taken.
- **Visible coverage.** A line above the prompt shows the last checkpoint, how many files this turn protected, and what was *not* protected and why (secret, outside the project, too large, over a limit).
- **Previewed, undoable rollback.** A restore always shows its plan first and needs the token from that preview. If files change between preview and confirm, it stops and previews again. Every restore saves an undo point first.
- **Timeline pane.** `/zeit-timeline` opens a pane listing checkpoints from every session of the project: diffs per file, restore one file or all, pin, verify, fork and export.
- **Verified checkpoints.** `/zeit-verify` runs a test command from `.zeit.json`. A checkpoint is marked verified only when the tests pass *and* the files on disk exactly matched it before and after the run. When tests fail — through `/zeit-verify` or when the agent runs one of your test commands in the shell — you get a rollback preview to the last verified checkpoint.
- **Fork and export.** `/zeit-fork` opens a full checkpoint in its own Git worktree on a new branch, leaving your workspace alone. `/zeit-export` writes a checkpoint to a zip file.
- **Retention.** Old checkpoints are pruned by age, count and disk use. Pinned checkpoints and the newest verified one are always kept.

## Commands

| Command | What it does |
| --- | --- |
| `/zeit-checkpoint [label]` | Snapshot the whole workspace now |
| `/zeit-checkpoints [count]` | List this project's checkpoints, newest first, across sessions |
| `/zeit-diff <id> [path...]` | Show what changed since a checkpoint |
| `/zeit-rollback <id> [path...] [--delete-new]` | Preview a restore; confirm with the `--confirm <token>` it prints |
| `/zeit-undo` | Preview undoing the last rollback; confirm the same way |
| `/zeit-timeline` | Open the timeline pane |
| `/zeit-verify [name] [--checkpoint id]` | Run a test command and verify the checkpoint it tested |
| `/zeit-fork <id> [dest] [--branch name]` | Recreate a full checkpoint in a new Git worktree and branch |
| `/zeit-export <id> [out.zip] [--force]` | Write a checkpoint to a zip (default: the storage folder's `exports/`) |
| `/zeit-pin <id>` / `/zeit-unpin <id>` | Keep a checkpoint through retention, or release it |
| `/zeit-prune` | Apply retention now |

An `<id>` is the six-character short id shown everywhere (`a3f9c1`), a full id, `latest` (newest checkpoint) or `undo` (newest undo point).

By default a rollback keeps files created after the checkpoint. `--delete-new` (or **Restore exactly** in the pane) removes them too; it is offered only for complete workspace snapshots, and the preview lists every file it would delete.

## Configuration

Optional `.zeit.json` in the project root:

```json
{
  "tests": { "unit": "npm test", "lint": "npm run lint" },
  "testTimeoutSec": 540,
  "ignore": ["fixtures/large/**", "*.sqlite"],
  "shellPatterns": ["\\bmake\\s+clean\\b"],
  "limits": { "maxFiles": 20000, "maxFileMB": 20, "maxTotalMB": 500 },
  "shellLimits": { "maxFiles": 5000, "maxFileMB": 5, "maxTotalMB": 200 },
  "retention": { "maxAgeDays": 14, "maxCount": 300, "maxMB": 2048 }
}
```

The values shown are the defaults, except `tests`, `ignore` and `shellPatterns`, which are empty by default. `shellPatterns` are regular expressions added to the built-in ones. `limits` apply to manual and test snapshots, `shellLimits` to the snapshot taken before a shell command.

## What is saved, and where

- **Project.** The Git top-level folder when inside a repository, otherwise the session's working directory. In a Git repository the file list is `git ls-files --cached --others --exclude-standard`, so `.gitignore` is respected. Outside Git, common dependency and build folders (`node_modules`, `.venv`, `dist`, `build`, `target`, caches, …) are skipped.
- **Never saved.** Secret-looking files: `.env*` (except `.env.example`/`.sample`/`.template`), `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `id_rsa` and friends, `.npmrc`, `.pypirc`, `.netrc`. Also `.git` internals and anything matching `ignore`. Skipped files are listed, never silently dropped.
- **Storage.** `%LOCALAPPDATA%\zeit-checkpoints` on Windows, `$XDG_DATA_HOME/zeit-checkpoints` (or `~/.local/share/zeit-checkpoints`) elsewhere; set `ZEIT_HOME` to move it. Content is gzip-compressed and content-addressed, so an unchanged file is stored once however many checkpoints hold it. Each checkpoint is a small JSON manifest.
- **Writes.** Restores write each file to a temporary file and rename it into place, after saving the undo point. If a restore is interrupted, the undo point brings back the state before it.

## Development

```
node --test "test/*.spec.mjs"     # storage helper acceptance tests (disposable temp fixtures)
claude plugin test .              # mod tests: commands, band, timeline pane
claude plugin validate .          # manifest and hooks module
```

To run the mod from a clone: `claude --plugin-dir <path to this folder>`.

Layout: `bin/zeit.mjs` is the storage helper (snapshots, diff, preview/restore, retention, tests, fork, export), printing one JSON line per command. `hooks/` holds the Claude Code mod: `register.tsx` (commands, band), `capture.ts` (edit and shell capture), `timeline.tsx` (pane). `types/index.d.ts` declares the mod's session state.

## License

MIT
