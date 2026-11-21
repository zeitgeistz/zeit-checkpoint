import { atom, read, update } from 'claude-code'
import type { EngineInterface, ToolCallInput, ToolCallResult } from 'claude-code'

import type { ZeitCheckpoint, ZeitCoverage, ZeitSkip } from '../types'
import { EMPTY_COVERAGE, loadConfig, refreshLast } from './state'
import { zeit } from './zeit'

const last = atom({ plugin: 'zeit-checkpoint', key: 'last' } as const, null)
const coverage = atom({ plugin: 'zeit-checkpoint', key: 'coverage' } as const, EMPTY_COVERAGE)
const config = atom({ plugin: 'zeit-checkpoint', key: 'config' } as const, null)
const turn = atom({ plugin: 'zeit-checkpoint', key: 'turn' } as const, null)

export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
export const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

type Next = (e: ToolCallInput) => Promise<ToolCallResult>

const field = (e: ToolCallInput, name: string) => {
  const v = (e as unknown as Record<string, unknown>)[name]
  return typeof v === 'string' && v !== '' ? v : undefined
}

// A refused call (the person said no, a hook denied it) or one the tool reported as failed.
export const didNotRun = (ran: ToolCallResult) => ran.deny !== undefined || (ran as { isError?: boolean }).isError === true

async function currentTurn($: EngineInterface): Promise<string> {
  const t = await read($, turn)
  if (t) return t
  const fallback = `s-${await $.session.id()}`
  await update($, turn, () => fallback)
  return fallback
}

// Coverage belongs to one turn: a write for another turn starts it over.
const forTurn = (c: ZeitCoverage, t: string): ZeitCoverage => (c.turn === t ? c : { ...EMPTY_COVERAGE, turn: t })

const addUnique = (list: string[], more: string[]) => [...list, ...more.filter(p => !list.includes(p))]
const addSkips = (list: ZeitSkip[], more: ZeitSkip[]) => [...list, ...more.filter(s => !list.some(x => x.path === s.path))]

// Saves each file just before its first edit in the turn; drops the save when the edit did not run.
export async function captureEdit($: EngineInterface, e: ToolCallInput, next: Next): Promise<ToolCallResult> {
  const target = field(e, 'file_path') ?? field(e, 'notebook_path')
  if (target === undefined) return next(e)
  const t = await currentTurn($)
  const r = await zeit($, ['capture', '--turn', t, '--session', await $.session.id(), '--label', 'before edits', '--path', target], 60_000)
  if (r.ok) {
    const c = r.checkpoint as ZeitCheckpoint
    await update($, coverage, cur => {
      const base = forTurn(cur, t)
      return { ...base, checkpoint: c.short, protected: addUnique(base.protected, [...r.added, ...r.covered]), skipped: addSkips(base.skipped, r.skipped) }
    })
    if (r.isNew) await update($, last, () => c)
  } else {
    await update($, coverage, cur => {
      const base = forTurn(cur, t)
      return { ...base, failed: [...base.failed, { path: target, error: r.error ?? 'capture failed' }] }
    })
  }

  const ran = await next(e)
  if (r.ok && r.added.length && didNotRun(ran)) {
    const back = await zeit($, ['release', '--turn', t, '--path', target])
    if (back.ok && back.released.length) {
      await update($, coverage, cur => ({ ...cur, protected: cur.protected.filter(p => !back.released.includes(p)) }))
      if (back.dropped) await refreshLast($)
    }
  }
  return ran
}

function patternsOf(list: string[]) {
  const out: RegExp[] = []
  for (const p of list) {
    try { out.push(new RegExp(p)) } catch { /* a bad project pattern is ignored */ }
  }
  return out
}

// When one of the project's test commands fails, offers the last verified checkpoint back.
export async function offerRollback($: EngineInterface, command: string) {
  const r = await zeit($, ['list', '--limit', '200'], 15_000)
  const good = r.ok ? (r.checkpoints as ZeitCheckpoint[]).find(c => c.verified !== null) : undefined
  const t = await currentTurn($)
  await update($, coverage, cur => ({ ...forTurn(cur, t), testFailed: { command, verified: good?.short ?? null } }))
  $.ui.toast(good
    ? `Tests failed. Last verified checkpoint ${good.short}: /zeit-rollback ${good.short} previews the rollback.`
    : 'Tests failed. No verified checkpoint yet: /zeit-verify verifies one when the tests pass.')
}

const isTestCommand = (command: string, tests: Record<string, string>) => Object.values(tests).some(t => t.trim() === command.trim())

// Takes a bounded workspace snapshot before shell commands that may rewrite or delete files,
// and watches the project's own test commands for failures.
export async function captureShell($: EngineInterface, e: ToolCallInput, next: Next): Promise<ToolCallResult> {
  const command = field(e, 'command')
  if (command === undefined) return next(e)
  const cfg = (await read($, config)) ?? (await loadConfig($))
  const isTest = isTestCommand(command, cfg?.tests ?? {})
  if (!patternsOf(cfg?.shellPatterns ?? []).some(re => re.test(command))) {
    const ran = await next(e)
    if (isTest && ran.deny === undefined && didNotRun(ran)) await offerRollback($, command)
    return ran
  }

  const t = await currentTurn($)
  const firstLine = command.split('\n')[0]?.slice(0, 80) ?? ''
  const r = await zeit($, ['snapshot', '--kind', 'shell', '--bounded', '--session', await $.session.id(), '--label', `before: ${firstLine}`], 120_000)
  const c = r.ok ? (r.checkpoint as ZeitCheckpoint) : null
  await update($, coverage, cur => ({
    ...forTurn(cur, t),
    shell: c ? { short: c.short, files: c.fileCount, skipped: c.skippedCount, command: firstLine } : null,
    shellFailed: c ? null : r.error ?? 'shell snapshot failed',
  }))
  if (c) await update($, last, () => c)

  const ran = await next(e)
  if (c && ran.deny !== undefined) {
    await zeit($, ['drop', c.id])
    await update($, coverage, cur => ({ ...cur, shell: null }))
    await refreshLast($)
  }
  if (isTest && ran.deny === undefined && didNotRun(ran)) await offerRollback($, command)
  return ran
}
