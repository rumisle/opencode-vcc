# opencode-vcc

[pi-vcc](https://github.com/sting8k/pi-vcc) for OpenCode v2: compaction without a model call, and lossless recall of everything compaction removed.

- **Compaction without an LLM.** When OpenCode compacts a session (automatically or with `/compact`), this plugin writes the checkpoint summary itself, using pi-vcc's extraction, and OpenCode skips its summary request. It takes a few milliseconds, costs nothing, and gives the same output for the same history.
- **`vcc_recall` tool.** The model can search the session's full history, including turns that were compacted away. The `(#N)` references in a summary are recall entry indices.
- **`/recall <query> [page:N]`.** The same search from the prompt. The results go into the session as a message for the agent.

## What a summary looks like

```
[Session Goal]
- Fix the login bug: users can't log in after a password reset.
- [Scope change]
- now also handle the remember-me cookie

[Files And Changes]
- Modified: src/auth/session.ts, src/auth/cookie.ts

[Commits]
- a1b2c3d: fix(auth): refresh token after password reset

[Outstanding Context]
- lint check still failing on line 42

---

[user]
Fix the login bug: users can't log in after a password reset

[assistant]
Root cause: the session token is not refreshed after a reset.
* edit "src/auth/session.ts" (#1)
* bash "bun test tests/auth.test.ts" (#3)
...

---

Use `vcc_recall` to search for prior work, decisions, and context from before this summary. Do not redo work already completed.
```

The sections are pi-vcc's: goal and scope changes, files, commits, unresolved errors and questions, user preferences, and a ranked brief transcript with each tool call collapsed to one line. OpenCode adds its own kept tail (the most recent turns, 15k tokens by default) next to the summary, as serialized text.

## How it works

- **OpenCode picks the cut.** The plugin uses OpenCode's `compaction` session hook. OpenCode decides which recent turns to keep (configure with `compaction.keep.tokens`), and the hook supplies the summary of everything before them.
- **Summaries chain.** Each summary records in its metadata the last message it covered. The next compaction summarizes everything after that, including the previous kept tail, which OpenCode otherwise only keeps as text. It then merges with the previous summary: goal, files, commits, and preferences accumulate, and outstanding context is replaced. After a compaction the plugin didn't write (OpenCode's own summary), it summarizes the whole session from the start.
- **Full history from the database.** Plugins can only read the context after the last compaction, so the plugin reads the session's messages directly from OpenCode's SQLite database, read-only. The database is `$OPENCODE_DB`, else `opencode*.db` in `$XDG_DATA_HOME/opencode` (the one that contains the session), or the `database` option.
- **pi-vcc's core, unchanged.** `src/vendor/pi-vcc` is pi-vcc's summarizer and search, copied verbatim by `scripts/sync-pi-vcc.ts` (pi-vcc itself would pull in all of pi as peer dependencies). `src/adapter.ts` converts OpenCode messages to pi's shapes: `shell` becomes `bash`, `oldString`/`newString` become `oldText`/`newText`, and a `patch` call becomes one write, edit, or delete per file, so file tracking and `#N:path` drill-down work with patches too.

Differences from pi-vcc: no `/pi-vcc keep:N` command or smart keep (OpenCode owns the tail), no `scope` for recall (OpenCode sessions don't branch; a fork is its own session), and no auto-continue (OpenCode resumes by itself).

## Install

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugins": [
    "github:rumisle/opencode-vcc#<commit>"
  ]
}
```

Options (use the object form, `{ "package": "...", "options": { ... } }`):

| Option | Default | |
|---|---|---|
| `compaction` | `true` | `false` keeps only recall and leaves summaries to OpenCode's model. |
| `database` | auto | Path to OpenCode's database. |

Set `OPENCODE_VCC_DEBUG=1` in the server's environment to log each compaction.

## Development

```bash
bun test                        # unit tests
bun scripts/audit.ts [db]       # compact every session of a database, read-only, and report sizes
test/e2e.sh [opencode binary]   # real `opencode serve` + fake Anthropic API: /compact, auto compaction, recall
bun scripts/sync-pi-vcc.ts 0.8.0  # update the vendored pi-vcc core
```

## Credits

The summarizer and recall search are [pi-vcc](https://github.com/sting8k/pi-vcc) by sting8k (MIT), which is inspired by [VCC](https://github.com/lllyasviel/VCC).
