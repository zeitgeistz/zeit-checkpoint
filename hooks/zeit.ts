import type { EngineInterface } from 'claude-code'

import type { ZeitCheckpoint, ZeitDiff, ZeitPreview } from '../types'

// Every helper answer is one JSON object; `ok: false` carries `error` and sometimes more.
export type HelperAnswer = { ok: boolean; error?: string; [key: string]: any }

// Runs bin/zeit.mjs in the session's directory. Never throws: failures come back as `ok: false`.
export async function zeit($: EngineInterface, args: string[], timeoutMs = 120_000): Promise<HelperAnswer> {
  try {
    const cwd = await $.session.cwd()
    const ran = await $.process.run(['node', `${$.plugin.root}/bin/zeit.mjs`, ...args], { cwd, timeoutMs })
    const line = ran.stdout.trim().split('\n').pop() ?? ''
    try {
      return JSON.parse(line) as HelperAnswer
    } catch {
      const why = (ran.stderr || ran.stdout || `exit code ${ran.exitCode}`).trim()
      return { ok: false, error: `zeit helper failed: ${why.slice(0, 300)}` }
    }
  } catch (err) {
    return { ok: false, error: `zeit helper could not run (is Node on PATH?): ${String((err as Error)?.message ?? err).slice(0, 300)}` }
  }
}

// Splits command arguments on whitespace, keeping "quoted parts" together.
export function splitArgs(text: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (let m = re.exec(text); m !== null; m = re.exec(text)) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}

// Pulls `--flag` and `--flag value` options out of command arguments.
export function options(args: string[], valued: string[]) {
  const rest: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ''
    if (!a.startsWith('--')) { rest.push(a); continue }
    const key = a.slice(2)
    if (valued.includes(key) && i + 1 < args.length) flags[key] = args[++i] ?? ''
    else flags[key] = true
  }
  return { rest, flags }
}

const pad = (n: number) => String(n).padStart(2, '0')

export function when(ms: number): string {
  const d = new Date(ms)
  const today = new Date()
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return d.toDateString() === today.toDateString() ? time : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`
}

export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function badge(c: ZeitCheckpoint): string {
  return `${c.pinned ? ' [pinned]' : ''}${c.verified ? ' [verified]' : ''}`
}

export function describe(c: ZeitCheckpoint): string {
  const label = c.label ? ` "${c.label}"` : ''
  const skipped = c.skippedCount ? `, ${c.skippedCount} skipped` : ''
  return `${c.short}${label} · ${c.kind} · ${when(c.createdAt)} · ${c.fileCount} files${skipped}${badge(c)}`
}

export function skippedLine(skipped: Record<string, number>): string {
  const parts = Object.entries(skipped).map(([why, n]) => `${n} ${why}`)
  return parts.length ? `Skipped: ${parts.join(', ')}.` : ''
}

const VERB: Record<string, string> = { overwrite: 'overwrite', recreate: 'recreate', remove: 'DELETE', blocked: 'blocked' }

export function previewText(p: ZeitPreview, confirmWith: string): string {
  const head = `Rollback preview for ${p.short}${p.label ? ` "${p.label}"` : ''}`
  if (!p.actions.length) return `${head}: the files already match (${p.unchanged} unchanged). Nothing to do.`
  const rows = p.actions.map(a => `  ${(VERB[a.action] ?? a.action).padEnd(9)} ${a.path}${a.isNew ? ' (new since the checkpoint)' : ''}${a.reason ? ` (${a.reason})` : ''}`)
  const deletes = p.counts.remove ? ` ${p.counts.remove} file(s) will be DELETED.` : ''
  return [
    `${head} (${p.actions.length} file(s)):`,
    ...rows,
    `Unchanged: ${p.unchanged}.${deletes} An undo point is saved before anything is written.`,
    `Confirm: ${confirmWith} --confirm ${p.token}`,
  ].join('\n')
}

export type TestRun = {
  name: string
  command: string
  passed: boolean
  verified: boolean
  reason: string | null
  exitCode: number
  durationMs: number
  output: string
  checkpoint: ZeitCheckpoint
  rollback: { checkpoint: ZeitCheckpoint; preview: ZeitPreview } | null
}

export function testReport(r: TestRun): string {
  const took = `${(r.durationMs / 1000).toFixed(1)}s`
  const head = `${r.name} (${r.command})`
  if (r.passed && r.verified) return `Tests passed: ${head} in ${took}. Checkpoint ${r.checkpoint.short} is verified: this exact file state passed.`
  if (r.passed) return `Tests passed: ${head} in ${took}, but checkpoint ${r.checkpoint.short} is not verified: ${r.reason}.`
  const tail = r.output.trim().split('\n').slice(-15).join('\n')
  const offer = r.rollback
    ? `Last verified checkpoint: ${describe(r.rollback.checkpoint)}.\n${previewText(r.rollback.preview, `/zeit-rollback ${r.rollback.checkpoint.short}`)}`
    : 'No verified checkpoint to roll back to yet.'
  return [`Tests failed: ${head} exited ${r.exitCode} after ${took}.`, tail ? `Output (last lines):\n${tail}` : '', offer].filter(Boolean).join('\n\n')
}

export const forkText = (short: string, r: HelperAnswer) =>
  `Forked ${r.short ?? short} into ${r.dest} on branch ${r.branch} (from ${String(r.base).slice(0, 12)}): ${r.written} file(s) written${r.removed.length ? `, ${r.removed.length} tracked file(s) absent from the checkpoint removed` : ''}. Your workspace is unchanged.`

export const exportText = (short: string, r: HelperAnswer) => `Exported ${r.short ?? short}: ${r.files} file(s), ${size(r.bytes)} → ${r.out}`

export function diffText(diffs: ZeitDiff[]): string {
  return diffs.map(d => d.diff ? d.diff : `${d.path}: ${d.note ?? d.state ?? 'differs'}`).join('\n\n')
}

// The Code element draws tab and newline as its only control characters.
export const printable = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '?')
