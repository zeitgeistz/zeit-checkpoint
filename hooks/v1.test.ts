import { expect, test } from 'claude-code/testing'

import { BAND_PROPS, checkpoint, engineBasics, fakeHelper, run } from './fake'

const start = { cwd: '/work', surface: 'terminal' as const, isInteractive: true }

test('session start registers the v1 commands and the band shows the last checkpoint', async ($, on) => {
  const registered = engineBasics(on)
  fakeHelper(on, { list: { ok: true, root: '/work', total: 1, checkpoints: [checkpoint()] } })
  await $.session.start(start)
  expect(registered).toEqual(expect.arrayContaining(['zeit-checkpoint', 'zeit-checkpoints', 'zeit-diff', 'zeit-rollback', 'zeit-undo']))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'zeit-checkpoint', surface, component: 'AbovePrompt', props: BAND_PROPS })
    expect((await ui.find({ key: 'last' }))?.text).toMatch(/last checkpoint a3f9c1 "before refactor" · manual · .* · 12 files/)
    await ui.unmount()
  }
})

test('the band stays out of the way with no checkpoints and shows helper failures', async ($, on) => {
  engineBasics(on)
  let fail = false
  fakeHelper(on, { list: () => (fail ? { ok: false, error: 'disk full' } : { ok: true, root: '/work', total: 0, checkpoints: [] }) })
  await $.session.start(start)
  const ui = await $.ui.mount({ plugin: 'zeit-checkpoint', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ key: 'last' })).toBeUndefined()
  fail = true
  await run($, 'zeit-checkpoints', '')
  await run($, 'zeit-undo', '--confirm x')
  expect((await ui.find({ key: 'error' }))?.text).toMatch(/disk full/)
  await ui.unmount()
})

test('/zeit-checkpoint passes the label and session and reports the new checkpoint', async ($, on) => {
  engineBasics(on)
  const calls = fakeHelper(on, {
    list: { ok: true, root: '/work', total: 1, checkpoints: [checkpoint()] },
    snapshot: { ok: true, checkpoint: checkpoint({ skippedCount: 2, skipped: { secret: 2 } }) },
  })
  await $.session.start(start)
  const r = await run($, 'zeit-checkpoint', 'before refactor')
  expect(calls).toContainEqual(['snapshot', '--kind', 'manual', '--session', 'S1', '--label', 'before refactor'])
  expect(r.text).toMatch(/^Checkpoint a3f9c1 .*Skipped: 2 secret\.$/)
})

test('/zeit-rollback previews first, then restores only with the preview token', async ($, on) => {
  engineBasics(on)
  const preview = { id: 'x', short: 'a3f9c1', label: 'before refactor', paths: ['over.txt', 'gone.txt'], unchanged: 3, counts: { overwrite: 1, recreate: 1 }, token: 'tok123', actions: [{ path: 'gone.txt', action: 'recreate' }, { path: 'over.txt', action: 'overwrite' }] }
  const calls = fakeHelper(on, {
    list: { ok: true, root: '/work', total: 1, checkpoints: [checkpoint()] },
    preview: { ok: true, preview },
    restore: { ok: true, applied: [{ path: 'gone.txt', action: 'recreate' }, { path: 'over.txt', action: 'overwrite' }], undo: checkpoint({ short: 'u00001', kind: 'undo' }) },
  })
  await $.session.start(start)
  const shown = await run($, 'zeit-rollback', 'a3f9c1 over.txt gone.txt')
  expect(shown.text).toMatch(/recreate\s+gone\.txt/)
  expect(shown.text).toMatch(/Confirm: \/zeit-rollback a3f9c1 over\.txt gone\.txt --confirm tok123/)
  expect(calls.some(c => c[0] === 'restore')).toBe(false)

  const done = await run($, 'zeit-rollback', 'a3f9c1 over.txt gone.txt --confirm tok123')
  expect(calls).toContainEqual(['restore', 'a3f9c1', '--path', 'over.txt', '--path', 'gone.txt', '--confirm', 'tok123', '--session', 'S1'])
  expect(done.text).toMatch(/Restored 2 file\(s\) from a3f9c1\. Undo point u00001/)
})

test('a stale token shows the fresh preview instead of restoring', async ($, on) => {
  engineBasics(on)
  const preview = { id: 'x', short: 'a3f9c1', label: '', paths: null, unchanged: 0, counts: { overwrite: 1 }, token: 'newtok', actions: [{ path: 'a.txt', action: 'overwrite' }] }
  fakeHelper(on, {
    list: { ok: true, root: '/work', total: 1, checkpoints: [checkpoint()] },
    restore: { ok: false, error: 'the files changed since the preview; preview again', preview },
  })
  await $.session.start(start)
  const r = await run($, 'zeit-rollback', 'a3f9c1 --confirm oldtok')
  expect(r.text).toMatch(/changed since the preview/)
  expect(r.text).toMatch(/--confirm newtok/)
})
