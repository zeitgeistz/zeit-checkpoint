import type { On } from 'claude-code'

import type { ZeitCheckpoint } from '../types'

// A stand-in for bin/zeit.mjs beneath the plugin in `claude plugin test`, where no
// process runs: each helper command is answered by `answers[command]`, and every call is recorded.
export type FakeAnswer = Record<string, unknown> | ((args: string[]) => Record<string, unknown>)

export const CONFIG = { ok: true, root: '/work', isGit: true, tests: {}, shellPatterns: ['(^|[\\s;&|(])(rm|del)\\s', '\\bgit\\s+reset\\b'] }
export const PRUNED = { ok: true, removed: [], freedBytes: 0, objectsRemoved: 0, keptBytes: 0, retention: { maxAgeDays: 14, maxCount: 300, maxMB: 2048 } }
const EMPTY_LIST = { ok: true, root: '/work', isGit: true, total: 0, checkpoints: [] }

export function fakeHelper(on: On, given: Record<string, FakeAnswer>) {
  const answers: Record<string, FakeAnswer> = { config: CONFIG, prune: PRUNED, list: EMPTY_LIST, ...given }
  const calls: string[][] = []
  on('process.run', ($, e) => {
    const args = (e as { argv: string[] }).argv.slice(2)
    calls.push(args)
    const answer = answers[args[0] ?? '']
    const body = answer === undefined ? { ok: false, error: `fake: no answer for ${args[0]}` } : typeof answer === 'function' ? answer(args) : answer
    return { value: { exitCode: body.ok === false ? 1 : 0, stdout: JSON.stringify(body), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  return calls
}

// The engine calls a test answers so the plugin's session can start.
// `refuse` names commands the engine turns down, as it does a name the person already uses.
export function engineBasics(on: On, registered: string[] = [], refuse: string[] = []) {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => {
    const name = (e as { name: string }).name
    if (refuse.includes(name)) throw new Error(`"/${name}" refused: it is the user's /${name}`)
    registered.push(name)
    return { value: undefined } as never
  })
  on('session.cwd', () => ({ value: '/work' }) as never)
  on('session.id', () => ({ value: 'S1' }) as never)
  // What the engine draws when the plugin passes: nothing, in a test.
  on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return h(Box, {}) as never })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  return registered
}

// The tool beneath the plugin: answers each call with `answer(e)`, recording what ran.
export function fakeTools(on: On, answer: (e: { tool: string; [k: string]: unknown }) => unknown = () => ({ result: 'done', text: 'done' })) {
  const ran: string[] = []
  on('tool.call', ($, e) => {
    ran.push(String(e.tool))
    return answer(e as never) as never
  })
  return ran
}

export function checkpoint(over: Partial<ZeitCheckpoint> = {}): ZeitCheckpoint {
  return {
    id: '20261121-143200-a3f9c1', short: 'a3f9c1', label: 'before refactor', kind: 'manual', scope: 'full',
    createdAt: new Date(2026, 10, 21, 14, 32).getTime(), session: 'S1', turn: null, fileCount: 12, bytes: 3400,
    skippedCount: 0, skipped: {}, complete: true, pinned: false, verified: null, undoOf: null, head: null, branch: null,
    ...over,
  }
}

// Runs a slash command as the person typing it at the prompt would.
export function run($: { command: { run: (e: never) => Promise<{ text?: string }> } }, command: string, args = '') {
  return $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as never)
}

export const PANE_PROPS = { title: 'Checkpoints', isFocused: true, bodyColumns: 100, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }

export const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} }
