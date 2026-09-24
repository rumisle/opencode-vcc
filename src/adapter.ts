// OpenCode session messages → the pi message shapes pi-vcc's core reads.
//
// Every emitted pi message gets a session-global index. Compaction summaries cite these as `(#N)`
// and vcc_recall resolves them, so both sides must derive them from the same rows in the same order:
// always the session's full `session_message` history in `seq` order (see history.ts).
//
// OpenCode tools are renamed to the pi names pi-vcc's extractors key on (`shell` → `bash`), and
// their arguments to pi's keys (`oldString`/`newString` → `oldText`/`newText`). A `patch` call is
// split into one write/edit/delete call per file so file tracking and `#N:path` drill-down see it.
import type {
  AssistantMessage,
  BashExecutionMessage,
  ImageContent,
  TextContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "./vendor/pi-ai"

/** A decoded `session_message` row: the JSON `data` column plus its id, type, and seq columns. */
export interface Row {
  id: string
  type: string
  seq: number
  [key: string]: any
}

export type PiMessage = UserMessage | AssistantMessage | ToolResultMessage | BashExecutionMessage

export interface Entry {
  /** Session-global `#N`. */
  index: number
  /** The OpenCode message this came from. */
  rowID: string
  seq: number
  message: PiMessage
}

const time = (row: Row): number => {
  const created = row.time?.created
  return typeof created === "number" ? created : 0
}

/** Readable stand-in for a non-text content item (OpenCode `file` content, attachments). */
const attachment = (item: any): string =>
  `[Attached ${item?.mime ?? "file"}${item?.name ? `: ${item.name}` : ""}]`

const contentText = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .map((item: any) => (item?.type === "text" ? String(item.text ?? "") : attachment(item)))
        .join("\n")
    : ""

const parseInput = (input: unknown): Record<string, any> => {
  if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, any>
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed
    } catch {}
  }
  return {}
}

const TOOL_NAMES: Record<string, string> = { shell: "bash" }

/** OpenCode argument names → pi's. Unknown keys pass through unchanged. */
export const piArgs = (input: Record<string, any>): Record<string, any> => {
  const args: Record<string, any> = { ...input }
  if (typeof args.filePath === "string" && args.path === undefined) {
    args.path = args.filePath
    delete args.filePath
  }
  if (typeof args.oldString === "string") {
    args.oldText = args.oldString
    delete args.oldString
  }
  if (typeof args.newString === "string") {
    args.newText = args.newString
    delete args.newString
  }
  return args
}

export interface PatchFile {
  action: "add" | "update" | "delete"
  path: string
  moveTo?: string
  lines: string[]
}

/** Parse OpenCode's `*** Begin Patch` envelope into per-file sections. */
export const parsePatch = (text: string): PatchFile[] => {
  const files: PatchFile[] = []
  let current: PatchFile | undefined
  for (const line of text.split("\n")) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line)
    if (header) {
      current = { action: header[1].toLowerCase() as PatchFile["action"], path: header[2].trim(), lines: [] }
      files.push(current)
      continue
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(line)
    if (move && current) {
      current.moveTo = move[1].trim()
      continue
    }
    if (line.startsWith("*** ")) continue
    current?.lines.push(line)
  }
  return files
}

const patchCalls = (id: string, patchText: string): ToolCall[] =>
  parsePatch(patchText).map((file, i) => {
    const callID = i === 0 ? id : `${id}#${i}`
    if (file.action === "add")
      return {
        type: "toolCall",
        id: callID,
        name: "write",
        arguments: { path: file.path, content: file.lines.map((l) => (l.startsWith("+") ? l.slice(1) : l)).join("\n") },
      }
    if (file.action === "delete") return { type: "toolCall", id: callID, name: "delete", arguments: { path: file.path } }
    const side = (keep: string) =>
      file.lines
        .filter((l) => l.startsWith(keep) || l.startsWith(" "))
        .map((l) => l.slice(1))
        .join("\n")
    return {
      type: "toolCall",
      id: callID,
      name: "edit",
      arguments: {
        path: file.path,
        ...(file.moveTo ? { moveTo: file.moveTo } : {}),
        oldText: side("-"),
        newText: side("+"),
      },
    }
  })

const toolCalls = (part: any): ToolCall[] => {
  const input = parseInput(part.state?.input)
  const name = String(part.name ?? "tool")
  if ((name === "patch" || name === "apply_patch") && typeof input.patchText === "string") {
    const calls = patchCalls(String(part.id), input.patchText)
    if (calls.length > 0) return calls
  }
  return [{ type: "toolCall", id: String(part.id), name: TOOL_NAMES[name] ?? name, arguments: piArgs(input) }]
}

const toolResult = (part: any, timestamp: number): ToolResultMessage | undefined => {
  const state = part.state
  if (state?.status !== "completed" && state?.status !== "error") return undefined
  const output = contentText(state.content)
  const text =
    state.status === "error"
      ? [state.error?.message ? `Error: ${state.error.message}` : "Error", output].filter(Boolean).join("\n")
      : output
  const name = String(part.name ?? "tool")
  return {
    role: "toolResult",
    toolCallId: String(part.id),
    toolName: TOOL_NAMES[name] ?? name,
    content: [{ type: "text", text }],
    isError: state.status === "error",
    timestamp,
  }
}

/** The pi messages one OpenCode message contributes, in order. Most contribute none. */
export const piMessages = (row: Row): PiMessage[] => {
  const timestamp = time(row)
  switch (row.type) {
    case "user": {
      const content: (TextContent | ImageContent)[] = [{ type: "text", text: String(row.text ?? "") }]
      for (const file of row.files ?? []) {
        if (typeof file?.mime === "string" && file.mime.startsWith("image/"))
          content.push({ type: "image", data: "", mimeType: file.mime })
        else content.push({ type: "text", text: attachment(file) })
      }
      return [{ role: "user", content, timestamp }]
    }
    case "shell":
      return [
        {
          role: "bashExecution",
          command: String(row.command ?? ""),
          output: String(row.output?.output ?? ""),
          exitCode: typeof row.exit === "number" ? row.exit : undefined,
          timestamp,
        },
      ]
    case "assistant": {
      const content: AssistantMessage["content"] = []
      const results: ToolResultMessage[] = []
      for (const part of row.content ?? []) {
        if (part?.type === "text" && part.text) content.push({ type: "text", text: part.text })
        else if (part?.type === "reasoning" && part.text) content.push({ type: "thinking", thinking: part.text })
        else if (part?.type === "tool") {
          content.push(...toolCalls(part))
          const result = toolResult(part, timestamp)
          if (result) results.push(result)
        }
      }
      if (content.length === 0 && results.length === 0) return []
      return [{ role: "assistant", content, timestamp }, ...results]
    }
    // synthetic/system/skill/idle/compaction/switch messages carry no conversation, like pi's
    // custom messages, which pi-vcc also leaves out.
    default:
      return []
  }
}

/** Adapt a session's full history (in seq order) into indexed pi messages. */
export const toEntries = (rows: readonly Row[]): Entry[] => {
  const entries: Entry[] = []
  for (const row of rows)
    for (const message of piMessages(row))
      entries.push({ index: entries.length, rowID: row.id, seq: row.seq, message })
  return entries
}
