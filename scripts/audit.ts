// Simulates a compaction in every session of an OpenCode database (read-only) and reports sizes.
//   bun scripts/audit.ts [path/to/opencode.db]
import { Database } from "bun:sqlite"
import { candidateDatabases, sqliteHistory } from "../src/history.ts"
import { toEntries } from "../src/adapter.ts"
import { compact } from "../src/compact.ts"
import { recall } from "../src/recall.ts"

const file = process.argv[2] ?? candidateDatabases()[0]
const ids = (new Database(file, { readonly: true }).query("select distinct session_id id from session_message").all() as any[]).map((r) => r.id)
const history = sqliteHistory(file)
let failures = 0
const stats: { chars: number; ms: number; entries: number; transcript: number }[] = []
for (const id of ids) {
  const rows = history.load(id)!
  const lastUser = rows.findLastIndex((r) => r.type === "user")
  if (lastUser <= 0) continue
  try {
    const entries = toEntries(rows)
    const t = performance.now()
    const result = compact({ rows, messageIDs: new Set(rows.slice(0, lastUser).map((r) => r.id)) }, entries)
    const ms = performance.now() - t
    if (!result) continue
    recall(entries, { query: "error test" }); recall(entries, { mode: "touched" })
    const transcript = entries.filter((e) => e.seq < rows[lastUser].seq).reduce((n, e) => n + JSON.stringify(e.message).length, 0)
    stats.push({ chars: result.summary.length, ms, entries: entries.length, transcript })
  } catch (error) {
    failures++
    console.error(id, error)
  }
}
const pct = (xs: number[], p: number) => xs.toSorted((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]
console.log(`${file}: ${stats.length} sessions compacted, ${failures} failures`)
console.log(`summary chars p50 ${pct(stats.map((s) => s.chars), 0.5)} p90 ${pct(stats.map((s) => s.chars), 0.9)} max ${Math.max(...stats.map((s) => s.chars))}`)
console.log(`transcript chars p50 ${pct(stats.map((s) => s.transcript), 0.5)} max ${Math.max(...stats.map((s) => s.transcript))}`)
console.log(`compaction ms p50 ${pct(stats.map((s) => s.ms), 0.5).toFixed(1)} max ${Math.max(...stats.map((s) => s.ms)).toFixed(1)}`)
