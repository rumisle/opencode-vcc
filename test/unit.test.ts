import { Database } from "bun:sqlite"
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { onCompaction } from "../index.ts"
import { parsePatch, piMessages, toEntries, type Row } from "../src/adapter.ts"
import { compact, METADATA_KEY } from "../src/compact.ts"
import { candidateDatabases, sqliteHistory } from "../src/history.ts"
import { parseCommand, recall } from "../src/recall.ts"

// ── fixtures: OpenCode session_message rows ──
let seq = 0
const base = (type: string, extra: Record<string, any>): Row => ({
  id: `msg_${String(++seq).padStart(4, "0")}`,
  type,
  seq,
  time: { created: 1_700_000_000_000 + seq },
  ...extra,
})
const user = (text: string, extra: Record<string, any> = {}) => base("user", { text, ...extra })
const tool = (name: string, input: any, output: string | undefined, status = "completed") => ({
  type: "tool",
  id: `call_${seq}_${name}`,
  name,
  state:
    status === "error"
      ? { status, input, error: { type: "tool.failed", message: output } }
      : output === undefined
        ? { status: "running", input, metadata: {} }
        : { status, input, content: [{ type: "text", text: output }] },
  time: { created: 0 },
})
const assistant = (...content: any[]) =>
  base("assistant", {
    agent: "build",
    model: { providerID: "anthropic", id: "claude-opus-5-5" },
    content: content.map((c) => (typeof c === "string" ? { type: "text", text: c } : c)),
  })
const compaction = (summary: string, metadata?: Record<string, any>) =>
  base("compaction", { status: "completed", reason: "auto", summary, recent: "…", ...(metadata ? { metadata } : {}) })

const PATCH = [
  "*** Begin Patch",
  "*** Add File: src/new.ts",
  "+export const a = 1",
  "+export const b = 2",
  "*** Update File: src/old.ts",
  "*** Move to: src/renamed.ts",
  "@@ function greet()",
  " const x = 1",
  "-console.log('hi')",
  "+console.log('hello')",
  "*** Delete File: src/gone.ts",
  "*** End Patch",
].join("\n")

describe("adapter", () => {
  test("maps OpenCode tools and arguments to pi's", () => {
    const [call, ...results] = piMessages(
      assistant(
        { type: "reasoning", text: "thinking" },
        "Editing now",
        tool("edit", { path: "src/a.ts", oldString: "x", newString: "y" }, "ok"),
        tool("shell", { command: "bun test", description: "run tests" }, "3 pass"),
        tool("write", { filePath: "src/b.ts", content: "b" }, "written"),
        tool("read", { path: "src/c.ts" }, undefined),
        tool("shell", { command: "false" }, "exit 1", "error"),
      ),
    ) as any[]
    expect(call.role).toBe("assistant")
    expect(call.content.map((c: any) => c.type)).toEqual([
      "thinking",
      "text",
      "toolCall",
      "toolCall",
      "toolCall",
      "toolCall",
      "toolCall",
    ])
    const calls = call.content.filter((c: any) => c.type === "toolCall")
    expect(calls[0]).toMatchObject({ name: "edit", arguments: { path: "src/a.ts", oldText: "x", newText: "y" } })
    expect(calls[1]).toMatchObject({ name: "bash", arguments: { command: "bun test" } })
    expect(calls[2]).toMatchObject({ name: "write", arguments: { path: "src/b.ts", content: "b" } })
    // Running tools have no result yet; the error keeps its message.
    expect(results.map((r) => [r.toolName, r.isError, r.content[0].text])).toEqual([
      ["edit", false, "ok"],
      ["bash", false, "3 pass"],
      ["write", false, "written"],
      ["bash", true, "Error: exit 1"],
    ])
  })

  test("splits a patch into per-file calls", () => {
    expect(parsePatch(PATCH).map((f) => [f.action, f.path, f.moveTo])).toEqual([
      ["add", "src/new.ts", undefined],
      ["update", "src/old.ts", "src/renamed.ts"],
      ["delete", "src/gone.ts", undefined],
    ])
    const [call, result] = piMessages(assistant(tool("patch", { patchText: PATCH }, "applied"))) as any[]
    expect(call.content).toMatchObject([
      { name: "write", arguments: { path: "src/new.ts", content: "export const a = 1\nexport const b = 2" } },
      {
        name: "edit",
        arguments: {
          path: "src/old.ts",
          moveTo: "src/renamed.ts",
          oldText: "const x = 1\nconsole.log('hi')",
          newText: "const x = 1\nconsole.log('hello')",
        },
      },
      { name: "delete", arguments: { path: "src/gone.ts" } },
    ])
    expect(result).toMatchObject({ role: "toolResult", toolName: "patch" })
  })

  test("user attachments, shell messages, and messages without conversation", () => {
    expect(
      piMessages(user("look", { files: [{ mime: "image/png", name: "a.png" }, { mime: "text/plain", name: "b.txt" }] })),
    ).toMatchObject([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", mimeType: "image/png" },
          { type: "text", text: "[Attached text/plain: b.txt]" },
        ],
      },
    ])
    expect(piMessages(base("shell", { command: "ls", exit: 0, output: { output: "a\nb" } }))).toMatchObject([
      { role: "bashExecution", command: "ls", output: "a\nb", exitCode: 0 },
    ])
    for (const type of ["synthetic", "system", "skill", "idle", "compaction", "model-switched"])
      expect(piMessages(base(type, { text: "x" }))).toEqual([])
    // An errored assistant turn with no content contributes nothing.
    expect(piMessages(assistant())).toEqual([])
  })

  test("indices are session-global and stable as the session grows", () => {
    const rows = [user("a"), assistant("b", tool("shell", { command: "ls" }, "x")), user("c")]
    const first = toEntries(rows)
    expect(first.map((e) => [e.index, e.message.role])).toEqual([
      [0, "user"],
      [1, "assistant"],
      [2, "toolResult"],
      [3, "user"],
    ])
    const later = toEntries([...rows, assistant("d"), compaction("s"), user("e")])
    expect(later.slice(0, 4)).toEqual(first)
    expect(later.map((e) => e.index)).toEqual([0, 1, 2, 3, 4, 5])
  })
})

// A session: goal, edits, a commit, a failing test; then more work after the first compaction.
const buildSession = () => {
  const rows: Row[] = [
    user("Fix the login bug: users can't log in after a password reset. Always run tests before committing."),
    assistant(
      "Root cause: the session token is not refreshed.",
      tool("edit", { path: "/repo/src/auth/session.ts", oldString: "old", newString: "refresh()" }, "ok"),
    ),
    user("run the tests and commit"),
    assistant(
      tool("shell", { command: "bun test tests/auth.test.ts" }, "12 pass"),
      tool("shell", { command: 'git add -A && git commit -m "fix(auth): refresh token after password reset"' }, "[main a1b2c3d] fix(auth): refresh token after password reset"),
    ),
    user("now also handle the remember-me cookie"),
    assistant(tool("write", { path: "/repo/src/auth/cookie.ts", content: "export const remember = true" }, "written")),
  ]
  return rows
}

describe("compact", () => {
  test("first compaction summarizes everything before the kept tail", () => {
    const rows = buildSession()
    const cut = rows.slice(0, 4) // OpenCode keeps the last exchange as its tail
    const result = compact({ rows, messageIDs: new Set(cut.map((r) => r.id)) })!
    expect(result.merged).toBe(false)
    expect(result.covered.through).toBe(cut.at(-1)!.seq)
    expect(result.covered.sections).toEqual(expect.arrayContaining(["Session Goal", "Files And Changes", "Commits"]))
    expect(result.summary).toContain("Fix the login bug")
    expect(result.summary).toContain("a1b2c3d")
    expect(result.summary).toContain("session.ts")
    expect(result.summary).not.toContain("remember-me") // in the kept tail
    expect(result.summary).toContain("vcc_recall")
    // (#N) refs are session-global entry indices.
    const entries = toEntries(rows)
    const edit = entries.find((e) => JSON.stringify(e.message).includes("refresh()"))!
    expect(result.summary).toContain(`(#${edit.index})`)
  })

  test("the next compaction covers the old tail and merges the previous summary", () => {
    const rows = buildSession()
    const first = compact({ rows, messageIDs: new Set(rows.slice(0, 4).map((r) => r.id)) })!
    const checkpoint = compaction(first.summary, { [METADATA_KEY]: first.covered })
    const after = [user("add a test for the cookie"), assistant(tool("shell", { command: "bun test" }, "13 pass"))]
    const tail = [user("and update the README"), assistant("done")]
    const all = [...rows, checkpoint, ...after, ...tail]
    // The hook sees the previous checkpoint plus the messages after it, up to the new tail.
    const second = compact({ rows: all, messageIDs: new Set([checkpoint, ...after].map((r) => r.id)) })!
    expect(second.merged).toBe(true)
    expect(second.covered.through).toBe(after.at(-1)!.seq)
    // New messages: the previous tail and `after`, 2 rows → 3 pi messages each.
    expect(second.covered.summarized).toBe(6)
    expect(second.summary).toContain("remember-me") // the previous tail is no longer lost
    expect(second.summary).toContain("add a test for the cookie")
    expect(second.summary).toContain("Fix the login bug") // sticky goal from the previous summary
    expect(second.summary).toContain("cookie.ts")
    expect(second.summary).toContain("session.ts")
    expect(second.summary).not.toContain("update the README")
    expect(second.summary.split("vcc_recall").length - 1).toBe(1) // the recall note isn't stacked
  })

  test("after a compaction we didn't write, summarize from the session start", () => {
    const rows = buildSession()
    const foreign = compaction("## Objective\n- something")
    const after = [user("continue please"), assistant("ok")]
    const all = [...rows, foreign, ...after]
    const result = compact({ rows: all, messageIDs: new Set([foreign, after[0]].map((r) => r.id)) })!
    expect(result.merged).toBe(false)
    expect(result.summary).toContain("Fix the login bug")
    expect(result.summary).not.toContain("## Objective")
    expect(result.covered.summarized).toBe(toEntries(all).filter((e) => e.seq <= after[0].seq).length)
  })

  test("returns undefined when none of the hook's messages are in the history", () => {
    expect(compact({ rows: buildSession(), messageIDs: new Set(["msg_unknown"]) })).toBeUndefined()
  })
})

// ── SQLite-backed history and the hook ──
const dir = mkdtempSync(path.join(tmpdir(), "opencode-vcc-test-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const writeDatabase = (file: string, sessions: Record<string, Row[]>) => {
  const db = new Database(file)
  db.run(
    "create table session_message (id text primary key, session_id text not null, type text not null, seq integer not null, time_created integer not null, time_updated integer not null, data text not null)",
  )
  const insert = db.prepare("insert into session_message values (?, ?, ?, ?, 0, 0, ?)")
  for (const [sessionID, rows] of Object.entries(sessions))
    for (const { id, type, seq, ...data } of rows) insert.run(id, sessionID, type, seq, JSON.stringify(data))
  db.close()
}

describe("history and hook", () => {
  const rows = buildSession()
  const file = path.join(dir, "opencode.db")
  writeDatabase(file, { ses_a: [...rows].reverse() }) // insertion order must not matter

  test("loads a session's rows in seq order", () => {
    const loaded = sqliteHistory(file).load("ses_a")!
    expect(loaded.map((r) => r.id)).toEqual(rows.map((r) => r.id))
    expect(loaded[1].content[1].state.input.path).toBe("/repo/src/auth/session.ts")
    expect(sqliteHistory(file).load("ses_missing")).toBeUndefined()
  })

  test("finds the database containing the session under XDG_DATA_HOME", () => {
    const data = path.join(dir, "xdg")
    const opencode = path.join(data, "opencode")
    require("node:fs").mkdirSync(opencode, { recursive: true })
    writeDatabase(path.join(opencode, "opencode.db"), { ses_other: [user("x")] })
    writeDatabase(path.join(opencode, "opencode-beta.db"), { ses_b: [user("hello from beta")] })
    const saved = { xdg: process.env.XDG_DATA_HOME, db: process.env.OPENCODE_DB }
    process.env.XDG_DATA_HOME = data
    delete process.env.OPENCODE_DB
    try {
      expect(candidateDatabases().map((f) => path.basename(f))).toEqual(["opencode.db", "opencode-beta.db"])
      expect(sqliteHistory().load("ses_b")?.[0].text).toBe("hello from beta")
    } finally {
      if (saved.xdg === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = saved.xdg
      if (saved.db !== undefined) process.env.OPENCODE_DB = saved.db
    }
  })

  test("the hook supplies the summary and metadata", () => {
    const event: any = { sessionID: "ses_a", messages: rows.slice(0, 4).map((r) => ({ id: r.id, role: "user" })) }
    onCompaction(sqliteHistory(file))(event)
    expect(event.result.summary).toContain("Fix the login bug")
    expect(event.result.metadata[METADATA_KEY]).toMatchObject({ version: 1, through: rows[3].seq })
  })

  test("the hook leaves compaction alone when it can't help", () => {
    const hook = onCompaction(sqliteHistory(file))
    const supplied: any = { sessionID: "ses_a", messages: [{ id: rows[0].id }], result: { summary: "other plugin" } }
    hook(supplied)
    expect(supplied.result.summary).toBe("other plugin")
    const unknown: any = { sessionID: "ses_missing", messages: [{ id: "x" }] }
    hook(unknown)
    expect(unknown.result).toBeUndefined()
  })
})

describe("recall", () => {
  const entries = toEntries([...buildSession(), assistant(tool("patch", { patchText: PATCH }, "applied"))])

  test("search, expand, touched, and drill-down", () => {
    expect(recall(entries, { query: "remember-me cookie" })).toContain("remember-me")
    expect(recall(entries, { expand: [0] })).toContain("Always run tests before committing")
    expect(recall(entries, { expand: [999] })).toBe("Cannot expand indices outside session history: 999")
    const touched = recall(entries, { mode: "touched" })
    for (const file of ["session.ts", "cookie.ts", "new.ts", "old.ts"]) expect(touched).toContain(file)
    const patchIndex = entries.findLast((e) => e.message.role === "assistant")!.index
    expect(recall(entries, { query: `#${patchIndex}:new.ts` })).toContain("export const b = 2")
    expect(recall(entries, { query: `#${patchIndex}:file` })).toContain("2 file operations") // a delete carries no content
    expect(recall(entries, {})).toContain(`#${entries.length - 1}`)
  })

  test("paging hint and command parsing", () => {
    const many = toEntries(Array.from({ length: 30 }, (_, i) => user(`deploy step ${i} of the rollout`)))
    const out = recall(many, { query: "deploy rollout" }, (page) => `/recall deploy rollout page:${page}`)
    expect(out).toContain("Page 1/")
    expect(out).toContain("--- Use /recall deploy rollout page:2 for more results ---")
    expect(parseCommand("auth  bug page:3")).toEqual({ query: "auth bug", page: 3 })
    expect(parseCommand("")).toEqual({ query: undefined, page: undefined })
  })
})
