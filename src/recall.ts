// vcc_recall over OpenCode history: pi-vcc's recall tool, minus `scope` (OpenCode sessions don't
// branch; a fork is its own session).
import type { Entry } from "./adapter.ts"
import { findContentBearingCalls, formatToolCallContent, parseDrillDown } from "./vendor/pi-vcc/core/drill-down"
import { formatRecallOutput, formatTouchedOutput } from "./vendor/pi-vcc/core/format-recall"
import { renderMessage } from "./vendor/pi-vcc/core/render-entries"
import { getTouchedFiles, searchEntriesDetailed } from "./vendor/pi-vcc/core/search-entries"

const DEFAULT_RECENT = 25
const PAGE_SIZE = 5

export const TOOL_NAME = "vcc_recall"

export const DESCRIPTION =
  "Recall earlier parts of the current session — decisions made, files touched, commands run, " +
  "including anything dropped by compaction. Reach for this before telling the user you no longer " +
  "have the context. Plain keywords work best; a regex pattern is also accepted. Results are paged " +
  "(page); pass expand with entry indices to read full untruncated content. Use mode:'touched' to " +
  "list files worked on in this session with their entry indices, and #N:path to drill into a file's " +
  "content from an entry (#N:path:full for all lines). The (#N) references in a compaction summary " +
  "are these entry indices. Only the current session is searchable — earlier sessions are not."

export const INPUT_SCHEMA = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "What to recall, in plain keywords (e.g. 'redis cache decision'). Multi-word queries are ranked by relevance. A regex pattern also works.",
    },
    expand: {
      type: "array",
      items: { type: "number" },
      description: "Entry indices to return full untruncated content for",
    },
    page: { type: "number", description: "Page number (1-based) for paginated search results. Default: 1." },
    mode: {
      type: "string",
      enum: ["hybrid", "touched"],
      description:
        "What to show. hybrid (default) = normal search; touched = aggregated files-by-path with entry indices.",
    },
  },
  additionalProperties: false,
} as const

export interface RecallInput {
  query?: string
  expand?: number[]
  page?: number
  mode?: string
}

const rendered = (entries: Entry[], full: boolean) =>
  entries.map((entry) => renderMessage(entry.message as any, entry.index, full))

const drillDown = (entries: Entry[], query: string): string | undefined => {
  const parsed = parseDrillDown(query)
  if (!parsed) return undefined
  const entry = entries[parsed.index]
  if (!entry) return `Entry #${parsed.index} not found in session history.`
  const calls = findContentBearingCalls((entry.message as any).content ?? [])
  const at = (call: (typeof calls)[number]) => `  [#${parsed.index}:${call.path}] ${call.name}(${call.path})`
  const options = { full: parsed.full, offset: parsed.offset, limit: parsed.limit }
  if (parsed.pathPattern === "file") {
    if (calls.length === 0) return `No file content found in entry #${parsed.index}.`
    if (calls.length === 1) return formatToolCallContent(calls[0], parsed.index, options)
    return `Entry #${parsed.index} has ${calls.length} file operations:\n${calls.map(at).join("\n")}\n\nUse #${parsed.index}:path to drill into a specific file.`
  }
  const matched = calls.filter((call) => call.path.includes(parsed.pathPattern))
  if (matched.length === 0) return `No file content found in entry #${parsed.index} for "${parsed.pathPattern}".`
  if (matched.length > 1)
    return `Entry #${parsed.index} has ${matched.length} file operations matching "${parsed.pathPattern}":\n${matched.map(at).join("\n")}\n\nUse #${parsed.index}:<more-specific-path> to drill into a specific file.`
  return formatToolCallContent(matched[0], parsed.index, options)
}

/** `pageHint(n)` phrases how to ask for page n (tool argument or command syntax). */
export const recall = (
  entries: Entry[],
  input: RecallInput,
  pageHint: (page: number) => string = (page) => `page:${page}`,
): string => {
  const query = input.query?.trim()
  if (query) {
    const drilled = drillDown(entries, query)
    if (drilled !== undefined) return drilled
  }

  if (input.mode?.toLowerCase() === "touched") {
    const messages = entries.map((entry) => entry.message as any)
    return formatTouchedOutput(getTouchedFiles(messages, rendered(entries, false)), input.page)
  }

  const expand = [...new Set(input.expand ?? [])]
  if (expand.length > 0) {
    const invalid = expand.filter((i) => !Number.isInteger(i) || !entries[i])
    if (invalid.length > 0) return `Cannot expand indices outside session history: ${invalid.join(", ")}`
    return formatRecallOutput(expand.map((i) => renderMessage(entries[i].message as any, i, true)))
  }

  const all = rendered(entries, false)
  if (!query) return formatRecallOutput(all.slice(-DEFAULT_RECENT))

  const { hits, totalBeforeCap, truncated } = searchEntriesDetailed(
    all,
    entries.map((entry) => entry.message as any),
    query,
  )
  const page = Math.max(1, Math.floor(input.page ?? 1))
  const totalPages = Math.ceil(hits.length / PAGE_SIZE)
  const truncationNote = truncated
    ? ` — showing ${hits.length} of ${totalBeforeCap} matches, refine your query for more precise results`
    : ""
  if (hits.length > 0 && page > totalPages)
    return (
      `Page ${page} is outside the available range 1-${totalPages} (${hits.length} matches${truncationNote}). ` +
      (truncated
        ? `Use a page between 1 and ${totalPages}.`
        : `Use a page between 1 and ${totalPages}, or refine your query.`)
    )
  const start = (page - 1) * PAGE_SIZE
  const header =
    totalPages > 1
      ? `Page ${page}/${totalPages} (${hits.length} total matches${truncationNote})`
      : `${hits.length} matches${truncationNote}`
  const footer = page < totalPages ? `\n--- Use ${pageHint(page + 1)} for more results ---` : ""
  return formatRecallOutput(hits.slice(start, start + PAGE_SIZE), query, header) + footer
}

/** Parse `/recall` arguments: free text plus an optional `page:N`. */
export const parseCommand = (text: string): RecallInput => {
  const page = /\bpage:(\d+)\b/i.exec(text)
  const query = text.replace(/\bpage:\d+\b/i, "").replace(/\s+/g, " ").trim()
  return { query: query || undefined, page: page ? Number(page[1]) : undefined }
}
