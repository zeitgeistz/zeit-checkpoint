import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ZeitCheckpoint, ZeitPreview } from '../types'
import { EDIT_TOOLS, SHELL_TOOLS, captureEdit, captureShell, offerRollback } from './capture'
import { EMPTY_COVERAGE, loadConfig, refreshLast } from './state'
import { openTimeline, renderTimeline } from './timeline'
import { describe, diffText, exportText, forkText, options, previewText, skippedLine, splitArgs, testReport, zeit } from './zeit'
import type { TestRun } from './zeit'

const last = atom({ plugin: 'zeit-checkpoint', key: 'last' } as const, null)
const error = atom({ plugin: 'zeit-checkpoint', key: 'error' } as const, null)
const coverage = atom({ plugin: 'zeit-checkpoint', key: 'coverage' } as const, EMPTY_COVERAGE)
const turn = atom({ plugin: 'zeit-checkpoint', key: 'turn' } as const, null)
const config = atom({ plugin: 'zeit-checkpoint', key: 'config' } as const, null)

const quote = (s: string) => (/\s/.test(s) ? `"${s}"` : s)

// Shared by /zeit-rollback and /zeit-undo: a preview first, the restore only with its token.
async function rollback($: EngineInterface, ref: string, paths: string[], flags: Record<string, string | true>, confirmWith: string) {
  const extra = [...paths.flatMap(p => ['--path', p]), ...(flags['delete-new'] ? ['--delete-new'] : [])]
  if (typeof flags.confirm !== 'string') {
    const r = await zeit($, ['preview', ref, ...extra])
    if (!r.ok) return { text: `zeit: ${r.error}` }
    return { text: previewText(r.preview as ZeitPreview, confirmWith) }
  }
  const r = await zeit($, ['restore', ref, ...extra, '--confirm', flags.confirm, '--session', await $.session.id()])
  await refreshLast($)
  if (!r.ok) {
    const fresh = r.preview ? `\n\n${previewText(r.preview as ZeitPreview, confirmWith)}` : ''
    return { text: `zeit: ${r.error}${fresh}` }
  }
  if (!r.applied.length) return { text: `zeit: ${r.note}` }
  return { text: `Restored ${r.applied.length} file(s) from ${ref}. Undo point ${r.undo.short} saved: /zeit-undo reverts this.` }
}

async function setPin($: EngineInterface, ref: string, pinned: boolean) {
  if (!ref) return { text: `Usage: /zeit-${pinned ? 'pin' : 'unpin'} <id>` }
  const r = await zeit($, [pinned ? 'pin' : 'unpin', ref])
  await refreshLast($)
  if (!r.ok) return { text: `zeit: ${r.error}` }
  return { text: `${pinned ? 'Pinned' : 'Unpinned'} ${describe(r.checkpoint as ZeitCheckpoint)}.${pinned ? ' Retention never removes it.' : ''}` }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // A name the person already uses (their own skill or command) is refused; the rest still register.
    const clashes: string[] = []
    const skip = (err: unknown) => { clashes.push(String((err as Error)?.message ?? err)) }
    await $.command.register({ name: 'zeit-checkpoint', description: 'Snapshot the workspace now', argumentHint: '[label]' }).catch(skip)
    await $.command.register({ name: 'zeit-checkpoints', description: 'List checkpoints of this project (all sessions)', argumentHint: '[count]' }).catch(skip)
    await $.command.register({ name: 'zeit-diff', description: 'Show what changed since a checkpoint', argumentHint: '<id> [path...]' }).catch(skip)
    await $.command.register({ name: 'zeit-rollback', description: 'Preview, then restore files from a checkpoint', argumentHint: '<id> [path...] [--delete-new] [--confirm token]' }).catch(skip)
    await $.command.register({ name: 'zeit-undo', description: 'Preview, then undo the last rollback', argumentHint: '[--confirm token]' }).catch(skip)
    await $.command.register({ name: 'zeit-pin', description: 'Keep a checkpoint through retention', argumentHint: '<id>' }).catch(skip)
    await $.command.register({ name: 'zeit-unpin', description: 'Let retention remove a checkpoint again', argumentHint: '<id>' }).catch(skip)
    await $.command.register({ name: 'zeit-prune', description: 'Apply retention now (age, count, disk use)' }).catch(skip)
    await $.command.register({ name: 'zeit-timeline', description: 'Open the checkpoint timeline pane: diff, restore, pin' }).catch(skip)
    await $.command.register({ name: 'zeit-verify', description: 'Run a .zeit.json test command and verify the checkpoint it tested', argumentHint: '[name] [--checkpoint id]' }).catch(skip)
    await $.command.register({ name: 'zeit-fork', description: 'Open a full checkpoint in its own Git worktree and branch', argumentHint: '<id> [dest] [--branch name]' }).catch(skip)
    await $.command.register({ name: 'zeit-export', description: 'Write a checkpoint to a local zip file', argumentHint: '<id> [out.zip] [--force]' }).catch(skip)
    await loadConfig($)
    await zeit($, ['prune'], 60_000)
    await refreshLast($)
    if (clashes.length) await update($, error, () => `some commands were not added: ${clashes.join('; ')}`)
    return next(e)
  })

  // Coverage is per main-loop turn; subagent edits join the turn that spawned them.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, turn, () => e.turnId)
      await update($, coverage, () => ({ ...EMPTY_COVERAGE, turn: e.turnId }))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const cov = await read($, coverage)
    if (e.agentId === undefined && (cov.checkpoint !== null || cov.shell !== null)) {
      const r = await zeit($, ['prune'], 60_000)
      if (r.ok && r.removed.length) await refreshLast($)
    }
    return done
  })

  // A failing capture must never block the edit: fail open, the band shows what was missed.
  on('tool.call', ($, e, next) => {
    const tool = String(e.tool)
    if (EDIT_TOOLS.has(tool)) return captureEdit($, e, next)
    if (SHELL_TOOLS.has(tool)) return captureShell($, e, next)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'zeit-checkpoint' }, async ($, e) => {
    const label = e.args.trim()
    const r = await zeit($, ['snapshot', '--kind', 'manual', '--session', await $.session.id(), ...(label ? ['--label', label] : [])])
    await refreshLast($)
    if (!r.ok) return { text: `zeit: ${r.error}` }
    const c = r.checkpoint as ZeitCheckpoint
    return { text: `Checkpoint ${describe(c)}. ${skippedLine(c.skipped)}`.trim() }
  })

  on('command.run', { command: 'zeit-checkpoints' }, async ($, e) => {
    const count = Number(e.args.trim()) || 20
    const r = await zeit($, ['list', '--limit', String(count)])
    if (!r.ok) return { text: `zeit: ${r.error}` }
    const items = r.checkpoints as ZeitCheckpoint[]
    if (!items.length) return { text: `No checkpoints for ${r.root} yet. /zeit-checkpoint makes one.` }
    const rows = items.map(c => `  ${describe(c)}${c.undoOf ? ` (undo point of ${c.undoOf.slice(-6)})` : ''}`)
    return { text: [`Checkpoints for ${r.root} (${items.length} of ${r.total}, newest first):`, ...rows].join('\n') }
  })

  on('command.run', { command: 'zeit-diff' }, async ($, e) => {
    const [ref, ...paths] = splitArgs(e.args)
    if (!ref) return { text: 'Usage: /zeit-diff <id> [path...]' }
    const r = await zeit($, ['diff', ref, ...paths.flatMap(p => ['--path', p])])
    if (!r.ok) return { text: `zeit: ${r.error}` }
    if (!r.diffs.length) return { text: `No changes since ${r.short} (${r.unchanged} files unchanged).` }
    return { text: `Changes since ${r.short} (checkpoint → now):\n\n${diffText(r.diffs)}` }
  })

  on('command.run', { command: 'zeit-rollback' }, async ($, e) => {
    const { rest, flags } = options(splitArgs(e.args), ['confirm'])
    const [ref, ...paths] = rest
    if (!ref) return { text: 'Usage: /zeit-rollback <id> [path...] [--delete-new]' }
    const confirmWith = ['/zeit-rollback', ref, ...paths.map(quote), ...(flags['delete-new'] ? ['--delete-new'] : [])].join(' ')
    return rollback($, ref, paths, flags, confirmWith)
  })

  on('command.run', { command: 'zeit-undo' }, async ($, e) => {
    const { flags } = options(splitArgs(e.args), ['confirm'])
    return rollback($, 'undo', [], flags, '/zeit-undo')
  })

  on('command.run', { command: 'zeit-pin' }, async ($, e) => setPin($, e.args.trim(), true))
  on('command.run', { command: 'zeit-unpin' }, async ($, e) => setPin($, e.args.trim(), false))

  on('command.run', { command: 'zeit-prune' }, async $ => {
    const r = await zeit($, ['prune'], 120_000)
    await refreshLast($)
    if (!r.ok) return { text: `zeit: ${r.error}` }
    const { maxAgeDays, maxCount, maxMB } = r.retention
    return { text: `Retention (${maxAgeDays} days, ${maxCount} checkpoints, ${maxMB} MB): removed ${r.removed.length} checkpoint(s), freed ${Math.round(r.freedBytes / 1024)} KB. Pinned and the last verified checkpoint are kept.` }
  })

  on('command.run', { command: 'zeit-timeline' }, async $ => {
    await openTimeline($)
    return { text: 'Checkpoint timeline opened.' }
  })

  on('command.run', { command: 'zeit-verify' }, async ($, e) => {
    const { rest, flags } = options(splitArgs(e.args), ['checkpoint'])
    const cfg = (await read($, config)) ?? (await loadConfig($))
    // $.process.run allows ten minutes at most; the helper's own timeout fires first.
    const timeoutMs = Math.min(600_000, ((cfg?.testTimeoutSec ?? 540) + 30) * 1000)
    const r = await zeit($, ['test', ...(rest[0] ? ['--name', rest[0]] : []), ...(typeof flags.checkpoint === 'string' ? ['--snapshot', flags.checkpoint] : []), '--session', await $.session.id()], timeoutMs)
    await refreshLast($)
    if (!r.ok) return { text: `zeit: ${r.error}` }
    const run = r as unknown as TestRun
    if (!run.passed) await offerRollback($, run.command)
    return { text: testReport(run) }
  })

  on('command.run', { command: 'zeit-fork' }, async ($, e) => {
    const { rest, flags } = options(splitArgs(e.args), ['branch'])
    const [ref, dest] = rest
    if (!ref) return { text: 'Usage: /zeit-fork <id> [dest] [--branch name]' }
    const r = await zeit($, ['fork', ref, ...(dest ? ['--dest', dest] : []), ...(typeof flags.branch === 'string' ? ['--branch', flags.branch] : [])], 300_000)
    return { text: r.ok ? forkText(ref, r) : `zeit: ${r.error}` }
  })

  on('command.run', { command: 'zeit-export' }, async ($, e) => {
    const { rest, flags } = options(splitArgs(e.args), [])
    const [ref, out] = rest
    if (!ref) return { text: 'Usage: /zeit-export <id> [out.zip] [--force]' }
    const r = await zeit($, ['export', ref, ...(out ? ['--out', out] : []), ...(flags.force ? ['--force'] : [])], 300_000)
    return { text: r.ok ? exportText(ref, r) : `zeit: ${r.error}` }
  })

  on('ui.render', { component: 'Pane', requestId: 'zeit-timeline' }, ($, e) => renderTimeline($, e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const c = await read($, last)
    const failure = await read($, error)
    const cov = await read($, coverage)
    const hasCoverage = cov.protected.length > 0 || cov.skipped.length > 0 || cov.failed.length > 0 || cov.shell !== null || cov.shellFailed !== null || cov.testFailed !== null
    if (e.props.hasSurvey || (c === null && failure === null && !hasCoverage)) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const notProtected = cov.skipped.slice(0, 3).map(s => `${s.path} (${s.reason})`).join(', ') + (cov.skipped.length > 3 ? ` +${cov.skipped.length - 3}` : '')
    return (
      <Box flexDirection="column">
        {c !== null && <Box key="last"><Text dimColor>zeit · last checkpoint {describe(c)}</Text></Box>}
        {cov.protected.length > 0 && (
          <Box key="coverage"><Text dimColor>zeit · this turn: {cov.protected.length} file(s) protected in {cov.checkpoint}</Text></Box>
        )}
        {cov.skipped.length > 0 && <Box key="skipped"><Text color="warning">zeit · not protected: {notProtected}</Text></Box>}
        {cov.shell !== null && (
          <Box key="shell">
            <Text dimColor={cov.shell.skipped === 0} color={cov.shell.skipped > 0 ? 'warning' : undefined}>
              zeit · shell snapshot {cov.shell.short} before "{cov.shell.command}": {cov.shell.files} files
              {cov.shell.skipped > 0 ? `, ${cov.shell.skipped} skipped (over the shell limits)` : ''}
            </Text>
          </Box>
        )}
        {cov.failed.map(f => (
          <Box key={`failed-${f.path}`}><Text color="error">zeit · capture failed for {f.path}: {f.error}</Text></Box>
        ))}
        {cov.shellFailed !== null && <Box key="shell-failed"><Text color="error">zeit · shell snapshot failed: {cov.shellFailed}</Text></Box>}
        {cov.testFailed !== null && (
          <Box key="test-failed">
            <Text color="error">
              zeit · tests failed ({cov.testFailed.command.slice(0, 40)})
              {cov.testFailed.verified ? ` · /zeit-rollback ${cov.testFailed.verified} previews a rollback to the last verified checkpoint` : ' · no verified checkpoint yet'}
            </Text>
          </Box>
        )}
        {failure !== null && <Box key="error"><Text color="error">zeit · {failure}</Text></Box>}
      </Box>
    )
  })
}
