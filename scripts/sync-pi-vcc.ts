// Vendors pi-vcc's pure core (compactor + recall search) into src/vendor/pi-vcc.
//
//   bun scripts/sync-pi-vcc.ts [version]
//
// pi-vcc is not a dependency because its peer dependencies (pi itself) would be auto-installed with
// the plugin. The vendored files are copied verbatim except for the pi-ai type import, which is
// pointed at a local shim (src/vendor/pi-ai.ts), and drill-down's two private helpers, which are
// exported so recall can drill into OpenCode history instead of a pi session file. Never edit
// src/vendor/pi-vcc by hand: adapt
// OpenCode data to pi-vcc's shapes in src/adapter.ts instead, then re-run this script to update.
import { $ } from "bun"
import { mkdtempSync, readdirSync, rmSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const version = process.argv[2] ?? "0.8.0"
const root = path.resolve(import.meta.dir, "..")
const dest = path.join(root, "src/vendor/pi-vcc")
const work = mkdtempSync(path.join(tmpdir(), "pi-vcc-sync-"))

await $`npm pack @sting8k/pi-vcc@${version} --silent`.cwd(work).quiet()
const tarball = readdirSync(work).find((f) => f.endsWith(".tgz"))!
await $`tar -xzf ${tarball}`.cwd(work).quiet()
const src = path.join(work, "package/src")

rmSync(dest, { recursive: true, force: true })
const copy = (rel: string) => {
  const from = path.join(src, rel)
  if (statSync(from).isDirectory()) {
    for (const name of readdirSync(from)) copy(path.join(rel, name))
    return
  }
  if (!rel.endsWith(".ts")) return
  const to = path.join(dest, rel)
  mkdirSync(path.dirname(to), { recursive: true })
  const depth = rel.split("/").length - 1
  const shim = (depth === 0 ? "../" : "../".repeat(depth + 1)) + "pi-ai"
  let text = readFileSync(from, "utf8").replaceAll('from "@earendil-works/pi-ai"', `from "${shim}"`)
  if (rel === "core/drill-down.ts") {
    for (const fn of ["findContentBearingCalls", "formatToolCallContent"]) {
      if (!text.includes(`\nfunction ${fn}(`)) throw new Error(`drill-down.ts no longer has ${fn}`)
      text = text.replace(`\nfunction ${fn}(`, `\nexport function ${fn}(`)
    }
  }
  if (/@earendil-works|@mariozechner|from "typebox"/.test(text)) throw new Error(`${rel} still imports pi at runtime`)
  // Type-checked upstream against pi's own tsconfig and lib versions; our call sites are still checked.
  writeFileSync(to, `// @ts-nocheck\n// Vendored from @sting8k/pi-vcc@${version} (MIT) by scripts/sync-pi-vcc.ts. Do not edit.\n${text}`)
}
for (const rel of ["core", "extract", "types.ts", "sections.ts"]) copy(rel)
writeFileSync(path.join(dest, "VERSION"), `${version}\n`)
rmSync(work, { recursive: true, force: true })
console.log(`vendored @sting8k/pi-vcc@${version} into ${path.relative(root, dest)}`)
