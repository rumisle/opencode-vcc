// Reads a session's full message history straight from OpenCode's SQLite database.
//
// Plugins can only read the post-compaction context (`ctx.session.context`); the server's full
// history endpoint (`session.messages`) is not exposed to them. Until it is, read the
// `session_message` table directly, read-only. The server keeps the database in WAL mode, so a
// read-only connection sees every committed message without blocking the server's writes.
import { Database } from "bun:sqlite"
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import type { Row } from "./adapter.ts"

export interface HistorySource {
  /** Every message of the session in `seq` order, or undefined if the session can't be found. */
  load(sessionID: string): Row[] | undefined
}

/** Candidate database files: an explicit path, $OPENCODE_DB, else every opencode*.db in the data dir. */
export const candidateDatabases = (explicit?: string): string[] => {
  if (explicit) return [explicit]
  if (process.env.OPENCODE_DB && process.env.OPENCODE_DB !== ":memory:") return [process.env.OPENCODE_DB]
  const data = path.join(process.env.XDG_DATA_HOME || path.join(homedir(), ".local/share"), "opencode")
  if (!existsSync(data)) return []
  const names = readdirSync(data).filter((name) => /^opencode.*\.db$/.test(name))
  // The default channel's file first.
  names.sort((a, b) => Number(b === "opencode.db") - Number(a === "opencode.db") || a.localeCompare(b))
  return names.map((name) => path.join(data, name))
}

export const decodeRow = (row: { id: string; type: string; seq: number; data: string }): Row | undefined => {
  try {
    return { ...JSON.parse(row.data), id: row.id, type: row.type, seq: row.seq }
  } catch {
    return undefined
  }
}

export const sqliteHistory = (explicit?: string): HistorySource => {
  const open = new Map<string, Database>()
  const bySession = new Map<string, string>()

  const db = (file: string): Database | undefined => {
    let handle = open.get(file)
    if (handle) return handle
    if (!existsSync(file)) return undefined
    try {
      handle = new Database(file, { readonly: true })
      open.set(file, handle)
      return handle
    } catch {
      return undefined
    }
  }

  const rows = (file: string, sessionID: string) => {
    const handle = db(file)
    if (!handle) return undefined
    try {
      return handle
        .query<{ id: string; type: string; seq: number; data: string }, [string]>(
          "select id, type, seq, data from session_message where session_id = ? order by seq",
        )
        .all(sessionID)
    } catch {
      return undefined
    }
  }

  return {
    load(sessionID) {
      const known = bySession.get(sessionID)
      for (const file of known ? [known] : candidateDatabases(explicit)) {
        const found = rows(file, sessionID)
        if (!found || found.length === 0) continue
        bySession.set(sessionID, file)
        return found.map(decodeRow).filter((row): row is Row => row !== undefined)
      }
      return undefined
    },
  }
}
