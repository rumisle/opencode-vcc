// Fake Anthropic Messages API for end-to-end tests with a real `opencode serve` (see test/e2e.sh).
//
// Scripted by the latest user message:
//   "WORK n"   → calls `write` (file-n.txt) and `shell` (a fake commit), then answers "done n"
//   "RECALL q" → calls vcc_recall {query: q}, then answers with the start of the tool result
//   "BIG"      → reports a nearly full context window, so the next turn auto-compacts
// Every request is logged to $OUT/requests.jsonl. A compaction summary request (which the plugin
// should make unnecessary) is answered with an "LLM-SUMMARY" so a fallback would be visible.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"

const OUT = process.env.OUT ?? "/tmp/vcc-e2e"
mkdirSync(OUT, { recursive: true })

const sse = (content: any[], stop: string, inputTokens: number) =>
  new Response(
    [
      { type: "message_start", message: { id: `msg_${Date.now()}`, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, usage: { input_tokens: inputTokens, output_tokens: 0 } } },
      ...content.flatMap((block, index): any[] =>
        block.type === "text"
          ? [
              { type: "content_block_start", index, content_block: { type: "text", text: "" } },
              { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } },
              { type: "content_block_stop", index },
            ]
          : [
              { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } },
              { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } },
              { type: "content_block_stop", index },
            ],
      ),
      { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ]
      .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  )

const textOf = (content: any): string =>
  typeof content === "string"
    ? content
    : (content ?? []).map((c: any) => (c.type === "text" ? c.text : c.type === "tool_result" ? textOf(c.content) : "")).join("\n")

let n = 0
const server = Bun.serve({
  port: Number(process.env.FAKE_PORT ?? 4821),
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url)
    if (!url.pathname.endsWith("/v1/messages")) return new Response("not found", { status: 404 })
    const body = await req.json()
    const messages: any[] = body.messages ?? []
    const all = JSON.stringify(messages)
    const compaction = all.includes("structured summary")
    // The latest real user prompt, and the tool results that came after it.
    const lastUserIndex = messages.findLastIndex(
      (m) => m.role === "user" && !(Array.isArray(m.content) && m.content.some((c: any) => c.type === "tool_result")),
    )
    const prompt = textOf(messages[lastUserIndex]?.content)
    const results = messages.slice(lastUserIndex + 1).flatMap((m) =>
      Array.isArray(m.content) ? m.content.filter((c: any) => c.type === "tool_result") : [],
    )
    const tools: string[] = (body.tools ?? []).map((t: any) => t.name)
    // Only a real prompt, not the checkpoint quoting it in its serialized tail.
    const big = prompt.includes("BIG") && !prompt.includes("conversation-checkpoint")
    const inputTokens = big ? 990_000 : 3_000 + messages.length * 100
    writeFileSync(`${OUT}/request-${++n}.json`, JSON.stringify(body, null, 2))
    appendFileSync(
      `${OUT}/requests.jsonl`,
      JSON.stringify({ n, compaction, prompt: prompt.slice(0, 80), messages: messages.length, results: results.length, checkpoint: all.includes("conversation-checkpoint"), tools: tools.filter((t) => t === "vcc_recall") }) + "\n",
    )

    // Resuming from a checkpoint after a mid-turn compaction: just acknowledge.
    if (prompt.includes("conversation-checkpoint") && results.length === 0) return sse([{ type: "text", text: "continued" }], "end_turn", inputTokens)
    if (compaction) return sse([{ type: "text", text: "## Objective\n- LLM-SUMMARY (plugin did not handle compaction)" }], "end_turn", inputTokens)
    const work = /WORK (\d+)/.exec(prompt)
    if (work && results.length === 0)
      return sse(
        [
          { type: "tool_use", id: `toolu_w${n}`, name: "write", input: { path: `file-${work[1]}.txt`, content: `content of file ${work[1]}\n` } },
          { type: "tool_use", id: `toolu_s${n}`, name: "shell", input: { command: `echo "[main ${"abcdef0".slice(0, 6)}${work[1]}] step ${work[1]}" # git commit -m "step ${work[1]}: add file-${work[1]}"` } },
        ],
        "tool_use",
        inputTokens,
      )
    if (work) return sse([{ type: "text", text: `done ${work[1]}` }], "end_turn", inputTokens)
    const recall = /RECALL ([\w -]+)/.exec(prompt)
    if (recall && results.length === 0)
      return sse([{ type: "tool_use", id: `toolu_r${n}`, name: "vcc_recall", input: { query: recall[1].trim() } }], "tool_use", inputTokens)
    if (recall) return sse([{ type: "text", text: `RECALLED: ${textOf(results[0].content).slice(0, 300)}` }], "end_turn", inputTokens)
    return sse([{ type: "text", text: "ok" }], "end_turn", inputTokens)
  },
})
console.log(`fake anthropic on ${server.url}`)
