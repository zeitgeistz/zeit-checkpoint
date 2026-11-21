import { expect, test } from 'claude-code/testing'

import { BAND_PROPS, CONFIG, PANE_PROPS, checkpoint, engineBasics, fakeHelper, run } from './fake'

const start = { cwd: '/work', surface: 'terminal' as const, isInteractive: true }
const full = checkpoint()
const forked = { ok: true, dest: '/work-zeit-a3f9c1', branch: 'zeit/a3f9c1', base: '0123456789abcdef0123', written: 12, removed: ['old.txt'] }
const exported = { ok: true, out: '/home/zeit/exports/work-a3f9c1.zip', files: 12, bytes: 2048 }

test('/zeit-fork makes a worktree from a checkpoint and says the workspace is unchanged', async ($, on) => {
  engineBasics(on)
  const calls = fakeHelper(on, { fork: forked })
  await $.session.start(start)
  expect((await run($, 'zeit-fork', '')).text).toBe('Usage: /zeit-fork <id> [dest] [--branch name]')
  const r = await run($, 'zeit-fork', 'a3f9c1 ../try --branch spike')
  expect(calls).toContainEqual(['fork', 'a3f9c1', '--dest', '../try', '--branch', 'spike'])
  expect(r.text).toBe('Forked a3f9c1 into /work-zeit-a3f9c1 on branch zeit/a3f9c1 (from 0123456789ab): 12 file(s) written, 1 tracked file(s) absent from the checkpoint removed. Your workspace is unchanged.')
})

test('a command name the person already uses is skipped; the rest still register and the band says so', async ($, on) => {
  const added = engineBasics(on, [], ['zeit-rollback'])
  const calls = fakeHelper(on, {})
  await $.session.start(start)
  expect(added).toContain('zeit-export')
  expect(added).not.toContain('zeit-rollback')
  expect(calls).toContainEqual(['prune'])
  const ui = await $.ui.mount({ plugin: 'zeit-checkpoint', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect((await ui.find({ key: 'error' }))?.text).toMatch(/zeit · some commands were not added: /)
  await ui.unmount()
})

test('/zeit-fork passes the helper refusal through', async ($, on) => {
  engineBasics(on)
  fakeHelper(on, { fork: { ok: false, error: 'forking needs a Git repository' } })
  await $.session.start(start)
  expect((await run($, 'zeit-fork', 'a3f9c1')).text).toBe('zeit: forking needs a Git repository')
})

test('/zeit-export writes a zip and reports where', async ($, on) => {
  engineBasics(on)
  const calls = fakeHelper(on, { export: exported })
  await $.session.start(start)
  const r = await run($, 'zeit-export', 'a3f9c1 out.zip --force')
  expect(calls).toContainEqual(['export', 'a3f9c1', '--out', 'out.zip', '--force'])
  expect(r.text).toBe('Exported a3f9c1: 12 file(s), 2.0 KB → /home/zeit/exports/work-a3f9c1.zip')
})

test('the pane forks and exports the selected checkpoint; no fork outside Git', async ($, on) => {
  engineBasics(on)
  let isGit = true
  const calls = fakeHelper(on, {
    config: () => ({ ...CONFIG, isGit }),
    list: { ok: true, root: '/work', total: 1, checkpoints: [full] },
    show: { ok: true, checkpoint: full, files: [], skippedSample: [], tests: [] },
    preview: { ok: true, preview: { id: full.id, short: full.short, label: '', paths: null, actions: [], unchanged: 3, counts: {}, token: 't' } },
    fork: forked,
    export: exported,
  })
  await $.session.start(start)
  await run($, 'zeit-timeline')
  const ui = await $.ui.mount({ plugin: 'zeit-checkpoint', surface: 'terminal', component: 'Pane', requestId: 'zeit-timeline', props: PANE_PROPS })
  await ui.press({ key: `cp-${full.id}` })
  await ui.press({ key: 'fork' })
  expect(calls).toContainEqual(['fork', full.id])
  expect((await ui.find({ key: 'message' }))?.text).toMatch(/Forked a3f9c1 into \/work-zeit-a3f9c1/)
  await ui.press({ key: 'export' })
  expect(calls).toContainEqual(['export', full.id, '--force'])
  expect((await ui.find({ key: 'message' }))?.text).toMatch(/Exported a3f9c1: 12 file\(s\)/)
  await ui.unmount()

  isGit = false
  await $.session.start(start)
  const plain = await $.ui.mount({ plugin: 'zeit-checkpoint', surface: 'terminal', component: 'Pane', requestId: 'zeit-timeline', props: PANE_PROPS })
  expect(await plain.find({ key: 'fork' })).toBeUndefined()
  expect(await plain.find({ key: 'export' })).toBeDefined()
  await plain.unmount()
})
