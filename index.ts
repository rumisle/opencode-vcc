// opencode-vcc: pi-vcc for OpenCode. Compaction without a model call, plus lossless recall.
//
// - `compaction` hook: writes the checkpoint summary algorithmically (pi-vcc's sections and ranked
//   brief transcript) and skips OpenCode's summary request. Auto compaction and /compact both use it.
// - `vcc_recall` tool: searches the session's full history, including everything compacted away.
// - `/recall <query> [page:N]`: the same search, fed to the agent as a synthetic message.
import { toEntries } from "./src/adapter.ts"
import { compact, METADATA_KEY } from "./src/compact.ts"
import { sqliteHistory, type HistorySource } from "./src/history.ts"
import { DESCRIPTION, INPUT_SCHEMA, parseCommand, recall, TOOL_NAME, type RecallInput } from "./src/recall.ts"

export interface Options {
  /** Write compaction summaries (default true). false leaves compaction to OpenCode's model summary. */
  compaction?: boolean
  /** Path to OpenCode's database. Default: $OPENCODE_DB, else opencode*.db in $XDG_DATA_HOME/opencode. */
  database?: string
}

const debug = (...args: unknown[]) => {
  if (process.env.OPENCODE_VCC_DEBUG) console.error("[opencode-vcc]", ...args)
}

export const onCompaction = (history: HistorySource) => (event: any) => {
  // Another plugin already supplied a compaction.
  if (event.result) return
  const rows = history.load(event.sessionID)
  if (!rows) {
    debug("session not found in database; leaving compaction to OpenCode", event.sessionID)
    return
  }
  const messageIDs = new Set<string>(
    (event.messages ?? []).map((message: any) => message?.id).filter((id: unknown) => typeof id === "string"),
  )
  const started = performance.now()
  const result = compact({ rows, messageIDs })
  if (!result) {
    debug("no hook messages matched the database; leaving compaction to OpenCode", event.sessionID)
    return
  }
  event.result = { summary: result.summary, metadata: { [METADATA_KEY]: result.covered } }
  debug(
    `compacted ${event.sessionID}: ${result.covered.summarized} new messages through seq ${result.covered.through}` +
      `${result.merged ? " (merged with previous summary)" : ""}, ${result.summary.length} chars, ` +
      `${Math.round(performance.now() - started)}ms`,
  )
}

export default {
  id: "opencode-vcc",
  setup: async (ctx: any) => {
    const options: Options = ctx.options ?? {}
    const history = sqliteHistory(options.database)
    const entries = (sessionID: string) => toEntries(history.load(sessionID) ?? [])

    if (options.compaction !== false) await ctx.session.hook("compaction", onCompaction(history))

    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: TOOL_NAME,
        description: DESCRIPTION,
        input: INPUT_SCHEMA,
        // A direct tool, not a Code Mode one: compaction summaries tell the model to call it by name.
        options: { codemode: false },
        execute: async (input: RecallInput, context: any) => ({
          content: recall(entries(context.sessionID), input ?? {}),
        }),
      })
    })

    await ctx.command.transform((editor: any) => {
      editor.add({
        name: "recall",
        description: "Search this session's full history (vcc_recall) and hand the results to the agent",
        execute: async ({ sessionID, prompt }: any) => {
          const input = parseCommand(String(prompt?.text ?? ""))
          const text = recall(entries(sessionID), input, (page) => `/recall ${input.query ?? ""} page:${page}`)
          await ctx.session.synthetic({
            sessionID,
            text: `Results of /recall${input.query ? ` ${input.query}` : ""}:\n\n${text}`,
            description: `recall: ${input.query ?? "recent history"}`,
          })
        },
      })
    })
  },
}
