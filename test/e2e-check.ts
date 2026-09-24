// Checks the outcome of test/e2e.sh: bun test/e2e-check.ts <dir> <sessionID>
import { Database } from "bun:sqlite"
import { readFileSync } from "node:fs"
import { METADATA_KEY } from "../src/compact.ts"

const [dir, sessionID] = process.argv.slice(2)
const db = new Database(`${dir}/data/opencode/opencode.db`, { readonly: true })
const rows = (db.query("select id, type, seq, data from session_message where session_id = ? order by seq").all(sessionID) as any[]).map(
  (r) => ({ ...JSON.parse(r.data), id: r.id, type: r.type, seq: r.seq }),
)
const requests = readFileSync(`${dir}/requests.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l))

let failed = 0
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail !== undefined ? `: ${JSON.stringify(detail)}` : ""}`)
  if (!ok) failed++
}

const compactions = rows.filter((r) => r.type === "compaction")
check("two compactions completed", compactions.length === 2 && compactions.every((c) => c.status === "completed"), compactions.map((c) => [c.reason, c.status, c.error]))
const [first, second] = compactions
check("first is manual, second automatic", first?.reason === "manual" && second?.reason === "auto", [first?.reason, second?.reason])
for (const [name, c] of [["first", first], ["second", second]] as const) {
  check(`${name} summary is ours`, c?.summary?.startsWith("[Session Goal]") && c.summary.includes("vcc_recall"), c?.summary?.slice(0, 200))
  check(`${name} carries coverage metadata`, typeof c?.metadata?.[METADATA_KEY]?.through === "number", c?.metadata)
  check(`${name} keeps OpenCode's serialized tail`, typeof c?.recent === "string" && c.recent.length > 0, c?.recent)
}
check("no summary request reached the model", requests.every((r) => !r.compaction), requests.filter((r) => r.compaction))
check("second compaction continues from the first", second?.metadata?.[METADATA_KEY]?.through > first?.metadata?.[METADATA_KEY]?.through)
check("second summary keeps the first goal", second?.summary?.includes("Always use tabs"), second?.summary)
// file-3 was the first compaction's kept tail, file-4 came after it; the mid-turn auto
// compaction keeps the WORK 5 turn itself as its tail.
check("second summary covers the first compaction's tail and later work", ["file-3", "file-4"].every((f) => second?.summary?.includes(f)), second?.summary)
check("the turn in progress stays in the kept tail", second?.recent?.includes("file-5") && !second?.summary?.includes("file-5"), second?.recent)
check("commits extracted", /abcdef1: step 1/.test(second?.summary ?? ""), second?.summary)
check("the recall note appears once", second?.summary?.split("vcc_recall").length === 2)

const afterCheckpoint = requests.filter((r) => r.checkpoint && !r.compaction)
check("later requests carry the checkpoint", afterCheckpoint.length > 0)
check("vcc_recall offered to the model", requests.at(-1)?.tools?.includes("vcc_recall"))
const recalled = rows.find((r) => r.type === "assistant" && r.content?.some((p: any) => p.type === "text" && p.text.startsWith("RECALLED:")))
const recallText = recalled?.content.find((p: any) => p.type === "text").text ?? ""
check("vcc_recall found pre-compaction history", recallText.includes("Always use tabs"), recallText)
const synthetic = rows.find((r) => r.type === "synthetic" && r.text?.startsWith("Results of /recall file-1"))
check("/recall added its results", synthetic?.text?.includes("file-1.txt"), synthetic?.text?.slice(0, 300))

console.log(`\n--- second summary ---\n${second?.summary}\n--- recent (${second?.recent?.length} chars) ---\n${second?.recent?.slice(0, 400)}`)
process.exit(failed ? 1 : 0)
