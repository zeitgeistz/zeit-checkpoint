import { expect, test } from 'claude-code/testing'

import { PANE_PROPS, checkpoint, engineBasics, fakeHelper, run } from './fake'

const start = { cwd: '/work', surface: 'terminal' as const, isInteractive: true }
const one = checkpoint()
const two = checkpoint({ id: '20261121-150000-b0b0b0', short: 'b0b0b0', label: 'auto', kind: 'auto', scope: 'paths', createdAt: one.createdAt + 60_000 })
const DIFF = '--- a/over.txt (checkpoint)\n+++ b/over.txt (now)\n@@ -1,3 +1,3 @@\n line1\n-line2\n+CHANGED\n line3'

function helper(on: Parameters<typeof fakeHelper>[0], restore: Record<string, unknown> = {}) {
  let n = 0
  const plan = (args: string[]) => {
    const only = args.flatMap((a, i) => (a === '--path' ? [args[i + 1]] : []))
    const actions = [{ path: 'gone.txt', action: 'recreate' }, { path: 'over.txt', action: 'overwrite' }].filter(a => !only.length || only.includes(a.path))
    return { ok: true, preview: { id: args[1] === 'undo' ? 'undo-id' : one.id, short: args[1] === 'undo' ? 'undo01' : one.short, label: one.label, paths: only.length ? only : null, actions, unchanged: 10, counts: {}, token: `tok${only.length}` } }
  }
  return fakeHelper(on, {
    list: { ok: true, root: '/work', total: 2, checkpoints: [two, one] },
    show: { ok: true, checkpoint: one, files: [{ path: 'over.txt', size: 18, absent: false }, { path: 'gone.txt', size: 3, absent: false }], skippedSample: [], tests: [] },
    preview: plan,
    diff: args => ({ ok: true, id: one.id, short: one.short, unchanged: 10, diffs: args.includes('--path') ? [{ path: 'over.txt', state: 'modified since', diff: DIFF }] : [{ path: 'gone.txt', state: 'deleted since', diff: '--- a/gone.txt (checkpoint)\n+++ b/gone.txt (now)\n@@ -1,1 +0,0 @@\n-g1' }, { path: 'over.txt', state: 'modified since', diff: DIFF }] }),
    restore: () => (n++ === 0 && restore.firstStale ? { ok: false, error: 'the files changed since the preview; preview again', preview: { ...plan(['preview', one.id, '--path', 'over.txt']).preview, token: 'fresh' } } : { ok: true, applied: [{ path: 'over.txt', action: 'overwrite' }], undo: checkpoint({ short: 'u00001', kind: 'undo' }) }),
    pin: { ok: true, checkpoint: { ...one, pinned: true } },
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the timeline lists checkpoints and opens one's changed files`, async ($, on) => {
    engineBasics(on)
    const calls = helper(on)
    await $.session.start(start)
    expect((await run($, 'zeit-timeline')).text).toBe('Checkpoint timeline opened.')
    const ui = await $.ui.mount({ plugin: 'zeit-checkpoint', surface, component: 'Pane', requestId: 'zeit-timeline', props: PANE_PROPS })
    expect((await ui.find({ key: `cp-${two.id}` }))?.text).toMatch(/b0b0b0 .*auto/)
    await ui.press({ key: `cp-${one.id}` })
    expect(calls).toContainEqual(['show', one.id])
    expect(calls).toContainEqual(['preview', one.id])
    expect((await ui.find({ key: 'detail' }))?.text).toMatch(/a3f9c1 "before refactor" · whole workspace · 2 file\(s\) differ from now/)
    expect((await ui.find({ key: 'file-gone.txt' }))?.text).toMatch(/deleted\s+gone\.txt/)

    await ui.press({ key: 'diff-all' })
    expect(await ui.find({ key: 'diff-gone.txt' })).toBeDefined()
    expect(await ui.find({ key: 'diff-over.txt' })).toBeDefined()
    expect(await ui.find({ key: 'restore-file' })).toBeUndefined()
    await ui.unmount()
  })

  test(`${surface}: restoring one file goes diff → preview → confirm, and reports the undo point`, async ($, on) => {
    engineBasics(on)
    const calls = helper(on)
    await $.session.start(start)
    await run($, 'zeit-timeline')
    const ui = await $.ui.mount({ plugin: 'zeit-checkpoint', surface, component: 'Pane', requestId: 'zeit-timeline', props: PANE_PROPS })
    await ui.press({ key: `cp-${one.id}` })
    await ui.press({ key: 'file-over.txt' })
    expect(calls).toContainEqual(['diff', one.id, '--path', 'over.txt'])
    expect((await ui.find({ type: 'Code' }))).toBeDefined()
    await ui.press({ key: 'restore-file' })
    expect(calls).toContainEqual(['preview', one.id, '--path', 'over.txt'])
    expect((await ui.find({ key: 'preview' }))?.text).toMatch(/overwrite\s+over\.txt/)
    expect(calls.some(c => c[0] === 'restore')).toBe(false)
    await ui.press({ key: 'confirm' })
    expect(calls).toContainEqual(['restore', one.id, '--path', 'over.txt', '--confirm', 'tok1', '--session', 'S1'])
    expect((await ui.find({ key: 'message' }))?.text).toMatch(/Restored 1 file\(s\) from a3f9c1\. Undo point u00001 saved\./)
    expect(await ui.find({ key: 'preview' })).toBeUndefined()
    await ui.unmount()
  })
}

test('a stale confirm shows the fresh preview instead of restoring', async ($, on) => {
  engineBasics(on)
  const calls = helper(on, { firstStale: true })
  await $.session.start(start)
  await run($, 'zeit-timeline')
  const ui = await $.ui.mount({ plugin: 'zeit-checkpoint', surface: 'terminal', component: 'Pane', requestId: 'zeit-timeline', props: PANE_PROPS })
  await ui.press({ key: `cp-${one.id}` })
  await ui.press({ key: 'restore-all' })
  await ui.press({ key: 'confirm' })
  expect((await ui.find({ key: 'message' }))?.text).toMatch(/changed since the preview/)
  expect(await ui.find({ key: 'preview' })).toBeDefined()
  await ui.press({ key: 'confirm' })
  expect(calls.filter(c => c[0] === 'restore').map(c => c[c.indexOf('--confirm') + 1])).toEqual(['tok0', 'fresh'])
  await ui.unmount()
})

test('pin, cancel, and undo-last from the pane', async ($, on) => {
  engineBasics(on)
  const calls = helper(on)
  await $.session.start(start)
  await run($, 'zeit-timeline')
  const ui = await $.ui.mount({ plugin: 'zeit-checkpoint', surface: 'terminal', component: 'Pane', requestId: 'zeit-timeline', props: PANE_PROPS })
  await ui.press({ key: `cp-${one.id}` })
  await ui.press({ key: 'pin' })
  expect(calls).toContainEqual(['pin', one.id])
  await ui.press({ key: 'undo' })
  expect(calls).toContainEqual(['preview', 'undo'])
  expect((await ui.find({ key: 'preview' }))?.text).toMatch(/Restore from undo01/)
  await ui.press({ key: 'cancel' })
  expect(await ui.find({ key: 'preview' })).toBeUndefined()
  await ui.unmount()
})
