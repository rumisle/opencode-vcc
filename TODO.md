# TODO

## Better summaries without an LLM

A comparison against real pi sessions (Sep 2026) found vcc's summary weak on "where are we": its sections are pattern-matched and the brief is dominated by tool one-liners. Model-written status summaries carried the results, running work, and todos that vcc missed. Recall covered the facts: no "you forgot" complaints after vcc compactions.

- [ ] **Goal extraction:** drop filler ("continue", "qd", "recall the goal", complaints). Weight the first real request, and later messages only when they clearly change scope.
- [ ] **Less tool noise in the brief:** collapse repeated polling (`sleep …; date` ×N) into one line. Give more of the budget to the assistant's result/report messages, which carry the findings.
- [ ] **A "current state" section:** the latest assistant report, plus what is still running (background shells, tmux sessions, subagents), found by rules.
- [ ] **Benchmark:** use pi's ~560 model-written compaction summaries in `~/.pi/agent/sessions` as references, and measure how many of their facts vcc's summary recovers from the same history.
- [ ] Prefer upstreaming to pi-vcc (the core here is vendored from it), then re-sync with `scripts/sync-pi-vcc.ts`.
- [ ] Report upstream: the recall note is stacked on every merge (worked around in `src/compact.ts`), `git commit -am` isn't recognized as a commit, and the goal-extraction noise.

## One command: summarize, then compact

- [ ] A command (e.g. `/checkpoint`, not "handoff") that first has the agent write its understanding of the session (state, results, what's running, todos) as a normal turn, then runs compaction. The answer lands in the kept tail, verbatim, next to vcc's summary.
  - The summary turn reads from the prompt cache (about 10% of the input price), unlike a separate summarization request.
  - OpenCode keeps assistant text in full in the serialized tail, so this works if `compaction.keep.tokens` covers that turn.
  - Also for pi (a pi-vcc command or a small extension).

## Upstream

- [ ] OpenCode: expose `session.messages` to plugins, then replace the direct SQLite read in `src/history.ts`.
