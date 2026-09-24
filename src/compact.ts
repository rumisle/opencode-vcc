// Builds a compaction summary without a model call, pi-vcc style.
//
// OpenCode decides the cut: the `compaction` hook's `messages` are the transcript before the tail
// it keeps, and it stores that tail itself as serialized text next to our summary. Here we only
// write the summary.
//
// Each of our summaries records in its metadata the last message (`through`, a seq) it covered.
// The next compaction summarizes everything after that, which includes the previous kept tail
// (only kept as text, so otherwise lost), and merges with the previous summary using pi-vcc's
// merge rules. After a compaction we didn't write (OpenCode's LLM summary, or a native one),
// we summarize the whole session from the start, since we can't tell what that one covered.
import type { Entry, Row } from "./adapter.ts"
import { toEntries } from "./adapter.ts"
import { compileRanked } from "./vendor/pi-vcc/core/summarize"
import { DEFAULT_CHARS_PER_TOKEN } from "./vendor/pi-vcc/core/token-estimate"
import { RECALL_NOTE } from "./vendor/pi-vcc/core/format"

// pi-vcc wraps summaries at 120 columns, which splits its recall note over two lines, and then
// strips the note from the previous summary by exact match, so every merge stacks another copy.
// Strip it (and its separator) whitespace-insensitively before handing the summary back.
const NOTE_PATTERN = new RegExp(
  `(?:\\s*\\n---\\n\\s*)?${RECALL_NOTE.split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+")}\\s*`,
  "g",
)
export const stripRecallNote = (summary: string) => summary.replace(NOTE_PATTERN, "").trimEnd()

export const METADATA_KEY = "opencode-vcc"
export const VERSION = 1

export interface Covered {
  version: number
  /** seq of the last session message this summary covers. */
  through: number
  /** pi messages summarized in this compaction (new ones only). */
  summarized: number
  sections: string[]
}

// pi-vcc's size-relative brief budget (see its before-compact hook): 1100 tokens, growing by
// 15 tokens per block up to 2000 on long transcripts.
const BRIEF_BUDGET_TOKENS = 1100
const BRIEF_CEILING_TOKENS = 2000
const BRIEF_TOKENS_PER_BLOCK = 15

export interface CompactInput {
  /** The session's full history in seq order. */
  rows: readonly Row[]
  /** Message IDs OpenCode passed to the compaction hook (the transcript before the kept tail). */
  messageIDs: ReadonlySet<string>
}

export interface CompactResult {
  summary: string
  covered: Covered
  /** Whether a previous summary of ours was merged in. */
  merged: boolean
}

const SECTIONS = ["Session Goal", "Files And Changes", "Commits", "Outstanding Context", "User Preferences"]

const coveredOf = (row: Row | undefined): Covered | undefined => {
  const value = row?.metadata?.[METADATA_KEY]
  return value && typeof value.through === "number" ? value : undefined
}

export const compact = (input: CompactInput, entries: Entry[] = toEntries(input.rows)): CompactResult | undefined => {
  const inHook = input.rows.filter((row) => input.messageIDs.has(row.id))
  if (inHook.length === 0) return undefined
  // Summarize up to the newest real message OpenCode handed over. The previous checkpoint is in
  // the hook's messages too; it bounds the search for that checkpoint below.
  const boundary = Math.max(...inHook.map((row) => row.seq))
  const cut = Math.max(-1, ...inHook.filter((row) => row.type !== "compaction").map((row) => row.seq))

  const previous = input.rows.findLast(
    (row) => row.type === "compaction" && row.status === "completed" && row.seq <= boundary,
  )
  const prior = coveredOf(previous)
  const from = prior ? prior.through : -1
  const through = Math.max(cut, from)

  const selected = entries.filter((entry) => entry.seq > from && entry.seq <= through)
  const previousSummary = prior ? stripRecallNote(String(previous?.summary ?? "")) || undefined : undefined
  const summary = compileRanked({
    messages: selected.map((entry) => entry.message) as any,
    sourceIndices: selected.map((entry) => entry.index),
    previousSummary,
    ranking: {
      maxBriefChars: BRIEF_BUDGET_TOKENS * DEFAULT_CHARS_PER_TOKEN,
      maxBriefCharsCeiling: BRIEF_CEILING_TOKENS * DEFAULT_CHARS_PER_TOKEN,
      briefCharsPerBlock: BRIEF_TOKENS_PER_BLOCK * DEFAULT_CHARS_PER_TOKEN,
    },
  })
  return {
    summary: summary || previousSummary || "(No earlier conversation to summarize.)",
    covered: {
      version: VERSION,
      through,
      summarized: selected.length,
      sections: [...summary.matchAll(/^\[(.+?)\]$/gm)].map((m) => m[1]).filter((name) => SECTIONS.includes(name)),
    },
    merged: previousSummary !== undefined,
  }
}
