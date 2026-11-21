import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderInput } from 'claude-code'

import type { ZeitAction, ZeitCheckpoint, ZeitDiff, ZeitPreview, ZeitTimeline } from '../types'
import { EMPTY_TIMELINE, refreshLast } from './state'
import { badge, exportText, forkText, printable, when, zeit } from './zeit'
import type { TestRun } from './zeit'

export const PANE = 'zeit-timeline'

const timeline = atom({ plugin: 'zeit-checkpoint', key: 'timeline' } as const, EMPTY_TIMELINE)
const config = atom({ plugin: 'zeit-checkpoint', key: 'config' } as const, null)

const VERB: Record<ZeitAction['action'], string> = { overwrite: 'changed', recreate: 'deleted', remove: 'added', blocked: 'blocked' }

async function set($: EngineInterface, patch: Partial<ZeitTimeline>) {
  await update($, timeline, cur => ({ ...cur, ...patch }))
}

// Runs one helper call with the pane marked busy; a failure lands in the pane's message line.
async function busy($: EngineInterface, args: string[], timeoutMs?: number) {
  await set($, { isBusy: true, message: null })
  const r = await zeit($, args, timeoutMs)
  await set($, { isBusy: false, ...(r.ok ? {} : { message: `zeit: ${r.error}` }) })
  return r
}

export async function loadItems($: EngineInterface) {
  const r = await busy($, ['list', '--limit', '40'])
  if (r.ok) await set($, { items: r.checkpoints as ZeitCheckpoint[] })
}

export async function openTimeline($: EngineInterface) {
  await $.ui.open({ id: PANE, title: 'Checkpoints' })
  await loadItems($)
}

async function select($: EngineInterface, id: string) {
  await set($, { selected: id, files: [], changed: [], diff: null, preview: null, deleteNew: false })
  const shown = await busy($, ['show', id])
  if (!shown.ok) return
  const planned = await busy($, ['preview', id])
  await set($, { files: shown.files, changed: planned.ok ? (planned.preview as ZeitPreview).actions : [] })
}

async function showDiff($: EngineInterface, id: string, path?: string) {
  const r = await busy($, ['diff', id, ...(path ? ['--path', path] : [])])
  if (r.ok) await set($, { diff: r.diffs as ZeitDiff[], preview: null, message: r.diffs.length ? null : 'No changes since this checkpoint.' })
}

async function previewRestore($: EngineInterface, id: string, paths: string[], deleteNew: boolean) {
  const r = await busy($, ['preview', id, ...paths.flatMap(p => ['--path', p]), ...(deleteNew ? ['--delete-new'] : [])])
  if (r.ok) await set($, { preview: r.preview as ZeitPreview, diff: null, deleteNew })
}

async function confirmRestore($: EngineInterface) {
  const { preview, deleteNew } = await read($, timeline)
  if (preview === null) return
  const paths = preview.paths ?? []
  const r = await busy($, ['restore', preview.id, ...paths.flatMap(p => ['--path', p]), ...(deleteNew ? ['--delete-new'] : []), '--confirm', preview.token, '--session', await $.session.id()])
  if (!r.ok) {
    // A stale preview comes back fresh: show it so the person confirms what is true now.
    if (r.preview) await set($, { preview: r.preview as ZeitPreview, message: `zeit: ${r.error}` })
    return
  }
  const message = r.applied.length ? `Restored ${r.applied.length} file(s) from ${preview.short}. Undo point ${r.undo.short} saved.` : `zeit: ${r.note}`
  await set($, { preview: null, diff: null, message })
  await loadItems($)
  await refreshLast($)
  await select($, preview.id)
  await set($, { message })
}

async function togglePin($: EngineInterface, c: ZeitCheckpoint) {
  const r = await busy($, [c.pinned ? 'unpin' : 'pin', c.id])
  if (r.ok) await loadItems($)
}

async function newCheckpoint($: EngineInterface) {
  const r = await busy($, ['snapshot', '--kind', 'manual', '--session', await $.session.id(), '--label', 'from the timeline'])
  if (!r.ok) return
  await loadItems($)
  await refreshLast($)
  await select($, (r.checkpoint as ZeitCheckpoint).id)
}

// Runs the project's tests against this checkpoint; a failure opens the rollback preview
// to the last verified checkpoint, ready to confirm.
async function verify($: EngineInterface, id: string, timeoutSec: number) {
  const r = await busy($, ['test', '--snapshot', id, '--session', await $.session.id()], Math.min(600_000, (timeoutSec + 30) * 1000))
  if (!r.ok) return
  const run = r as unknown as TestRun
  await loadItems($)
  if (run.verified) return set($, { message: `Verified ${run.checkpoint.short}: ${run.name} passed on its exact file state.` })
  if (run.passed) return set($, { message: `zeit: tests passed, but ${run.checkpoint.short} is not verified: ${run.reason}` })
  if (run.rollback === null) return set($, { message: `zeit: tests failed (exit ${run.exitCode}). No verified checkpoint to roll back to yet.` })
  await set($, {
    message: `zeit: tests failed (exit ${run.exitCode}). Rollback to the last verified checkpoint ${run.rollback.checkpoint.short}:`,
    selected: run.rollback.checkpoint.id, preview: run.rollback.preview, diff: null, deleteNew: false,
  })
}

async function forkOut($: EngineInterface, c: ZeitCheckpoint) {
  const r = await busy($, ['fork', c.id], 300_000)
  if (r.ok) await set($, { message: forkText(c.short, r) })
}

async function exportOut($: EngineInterface, c: ZeitCheckpoint) {
  const r = await busy($, ['export', c.id, '--force'], 300_000)
  if (r.ok) await set($, { message: exportText(c.short, r) })
}

async function undoLast($: EngineInterface) {
  const r = await busy($, ['preview', 'undo'])
  if (r.ok) await set($, { preview: r.preview as ZeitPreview, diff: null, deleteNew: false })
}

export async function renderTimeline($: EngineInterface, e: RenderInput) {
  const { Box, Text, Button, Code } = $.ui.resolve(e)
  const t = await read($, timeline)
  const cfg = await read($, config)
  const rows = Math.max(8, (e.viewport?.rows ?? 30) - 6)
  const current = t.items.find(c => c.id === t.selected) ?? null
  const listRows = current ? Math.min(8, t.items.length) : Math.min(rows, t.items.length)

  return (
    <Box flexDirection="column" gap={1}>
      <Box key="toolbar" flexDirection="row" gap={1}>
        <Button key="refresh" label="Refresh" hotkey="r" onPress={() => loadItems($)} />
        <Button key="new" label="New checkpoint" hotkey="n" onPress={() => newCheckpoint($)} />
        <Button key="undo" label="Undo last rollback" hotkey="u" onPress={() => undoLast($)} />
        {t.isBusy && <Text dimColor>working…</Text>}
      </Box>
      {t.message !== null && <Box key="message"><Text color={t.message.startsWith('zeit:') ? 'error' : 'success'}>{t.message}</Text></Box>}

      <Box key="list" flexDirection="column">
        {t.items.length === 0 && <Text dimColor>No checkpoints yet. /zeit-checkpoint or New checkpoint makes one.</Text>}
        {t.items.slice(0, listRows).map(c => (
          <Button key={`cp-${c.id}`} plain onPress={() => select($, c.id)}>
            {c.id === t.selected ? '> ' : '  '}{c.short} <Text dimColor>{when(c.createdAt)} {c.kind.padEnd(6)} {c.fileCount} files{c.skippedCount ? ` (${c.skippedCount} skipped)` : ''}</Text> {c.label}{badge(c)}
          </Button>
        ))}
        {t.items.length > listRows && <Text dimColor>  … {t.items.length - listRows} older (/zeit-checkpoints lists them)</Text>}
      </Box>

      {current !== null && (
        <Box key="detail" flexDirection="column">
          <Text bold>
            {current.short}{current.label ? ` "${current.label}"` : ''} · {current.scope === 'full' ? 'whole workspace' : 'edited files'} · {t.changed.length} file(s) differ from now
          </Text>
          <Box key="actions" flexDirection="row" gap={1}>
            <Button key="diff-all" label="Diff all" hotkey="d" onPress={() => showDiff($, current.id)} />
            <Button key="restore-all" label="Restore all…" hotkey="a" onPress={() => previewRestore($, current.id, [], false)} />
            {current.complete && <Button key="restore-exact" label="Restore exactly (delete new files)…" onPress={() => previewRestore($, current.id, [], true)} />}
            <Button key="pin" label={current.pinned ? 'Unpin' : 'Pin'} hotkey="p" onPress={() => togglePin($, current)} />
            {current.complete && cfg !== null && Object.keys(cfg.tests).length > 0 && (
              <Button key="verify" label="Verify with tests" hotkey="v" onPress={() => verify($, current.id, cfg.testTimeoutSec)} />
            )}
            {current.complete && cfg?.isGit === true && <Button key="fork" label="Fork to worktree" hotkey="f" onPress={() => forkOut($, current)} />}
            <Button key="export" label="Export zip" hotkey="e" onPress={() => exportOut($, current)} />
          </Box>
          {t.changed.slice(0, 12).map(a => (
            <Button key={`file-${a.path}`} plain onPress={() => showDiff($, current.id, a.path)}>
              {'  '}<Text color={a.action === 'blocked' ? 'error' : 'warning'}>{VERB[a.action].padEnd(8)}</Text> {a.path}
            </Button>
          ))}
          {t.changed.length > 12 && <Text dimColor>  … {t.changed.length - 12} more</Text>}
        </Box>
      )}

      {t.diff !== null && current !== null && (
        <Box key="diff" flexDirection="column">
          {t.diff.map(d => (
            <Box key={`diff-${d.path}`} flexDirection="column">
              <Text bold>{d.path} <Text dimColor>{d.state ?? ''}</Text></Text>
              {d.diff ? <Code source={printable(d.diff)} format="diff" path={d.path} /> : <Text dimColor>{d.note ?? 'differs'}</Text>}
            </Box>
          ))}
          {t.diff.length === 1 && t.diff[0] !== undefined && (
            <Button key="restore-file" label={`Restore ${t.diff[0].path}…`} onPress={() => previewRestore($, current.id, [t.diff?.[0]?.path ?? ''], false)} />
          )}
        </Box>
      )}

      {t.preview !== null && (
        <Box key="preview" flexDirection="column" borderStyle="round" paddingX={1}>
          <Text bold>Restore from {t.preview.short}{t.preview.label ? ` "${t.preview.label}"` : ''}</Text>
          {t.preview.actions.length === 0 && <Text dimColor>The files already match. Nothing to do.</Text>}
          {t.preview.actions.slice(0, 15).map(a => (
            <Text color={a.action === 'remove' ? 'error' : undefined}>
              {'  '}{a.action === 'remove' ? 'DELETE' : a.action}{'  '}{a.path}{a.isNew ? ' (new since the checkpoint)' : ''}{a.reason ? ` (${a.reason})` : ''}
            </Text>
          ))}
          {t.preview.actions.length > 15 && <Text dimColor>  … {t.preview.actions.length - 15} more</Text>}
          <Text dimColor>An undo point is saved first. Files changed after this preview make the restore stop and preview again.</Text>
          <Box key="confirm-row" flexDirection="row" gap={1}>
            {t.preview.actions.length > 0 && (
              <Button key="confirm" variant="primary" label={`Restore ${t.preview.actions.length} file(s)`} onPress={() => confirmRestore($)} />
            )}
            <Button key="cancel" label="Cancel" onPress={() => set($, { preview: null })} />
          </Box>
        </Box>
      )}
    </Box>
  )
}
