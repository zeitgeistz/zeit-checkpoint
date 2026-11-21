import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { BAND_PROPS, CONFIG, PANE_PROPS, checkpoint, engineBasics, fakeHelper, fakeTools, run } from './fake'

const start = { cwd: '/work', surface: 'terminal' as const, isInteractive: true }
const TESTS = { unit: 'npm test' }
const good = checkpoint({ id: '20261121-140000-900d00', short: '900d00', kind: 'test', label: 'test: unit', verified: { name: 'unit', command: 'npm test', at: 1, stateHash: 'h' } })
const tested = checkpoint({ id: '20261121-160000-7e57ed', short: '7e57ed', kind: 'test', label: 'test: unit' })
const rollback = { checkpoint: good, preview: { id: good.id, short: good.short, label: good.label, paths: null, actions: [{ path: 'a.txt', action: 'overwrite' }], unchanged: 4, counts: { overwrite: 1 }, token: 'rb-token' } }

const passed = { ok: true, name: 'unit', command: 'npm test', passed: true, verified: true, reason: null, exitCode: 0, durationMs: 1234, output: 'ok', checkpoint: { ...tested, verified: good.verified }, rollback: null }
const failed = { ok: true, name: 'unit', command: 'npm test', passed: false, verified: false, reason: null, exitCode: 1, durationMs: 900, output: 'FAIL a.test.js\n  expected good', checkpoint: tested, rollback }

function toasts(on: On) {
  const seen: string[] = []
  on('ui.toast', ($, e) => { seen.push(JSON.stringify(e)); return { value: undefined } as never })
  return seen
}

test('/zeit-verify reports a verified checkpoint when the tests pass on its exact state', async ($, on) => {
  engineBasics(on)
  const calls = fakeHelper(on, { config: { ...CONFIG, tests: TESTS, testTimeoutSec: 60 }, test: passed })
  await $.session.start(start)
  const r = await run($, 'zeit-verify', 'unit')
  expect(calls).toContainEqual(['test', '--name', 'unit', '--session', 'S1'])
  expect(r.text).toBe('Tests passed: unit (npm test) in 1.2s. Checkpoint 7e57ed is verified: this exact file state passed.')
})

test('/zeit-verify on failure shows the output and the rollback preview to the last verified checkpoint', async ($, on) => {
  engineBasics(on)
  const seen = toasts(on)
  fakeHelper(on, { config: { ...CONFIG, tests: TESTS }, test: failed, list: { ok: true, root: '/work', total: 2, checkpoints: [tested, good] } })
  await $.session.start(start)
  const r = await run($, 'zeit-verify', '--checkpoint 7e57ed')
  expect(r.text).toMatch(/^Tests failed: unit \(npm test\) exited 1 after 0\.9s\./)
  expect(r.text).toMatch(/expected good/)
  expect(r.text).toMatch(/Last verified checkpoint: 900d00 "test: unit"/)
  expect(r.text).toMatch(/Confirm: \/zeit-rollback 900d00 --confirm rb-token/)
  expect(seen.join()).toMatch(/Tests failed\. Last verified checkpoint 900d00/)
  const ui = await $.ui.mount({ plugin: 'zeit-checkpoint', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect((await ui.find({ key: 'test-failed' }))?.text).toMatch(/tests failed \(npm test\) · \/zeit-rollback 900d00 previews a rollback/)
  await ui.unmount()
})

test('a configured test command failing in the shell offers the rollback; other commands do not', async ($, on) => {
  engineBasics(on)
  const seen = toasts(on)
  fakeTools(on, e => (String(e.command).trim() === 'npm test' || e.command === 'make' ? { result: 'x', text: 'exit 1', isError: true } : { result: 'ok', text: 'ok' }))
  fakeHelper(on, { config: { ...CONFIG, tests: TESTS }, list: { ok: true, root: '/work', total: 1, checkpoints: [good] } })
  await $.session.start(start)
  await $.turn.start({ text: '', turnId: 'T1' })
  await $.tool.call({ tool: 'Bash', command: 'make' } as never)
  await $.tool.call({ tool: 'Bash', command: 'npm run build' } as never)
  expect(seen).toEqual([])
  await $.tool.call({ tool: 'Bash', command: '  npm test ' } as never)
  expect(seen.join()).toMatch(/\/zeit-rollback 900d00 previews the rollback/)
})

test('with no verified checkpoint the failure says so', async ($, on) => {
  engineBasics(on)
  const seen = toasts(on)
  fakeTools(on, () => ({ result: 'x', text: 'exit 1', isError: true }))
  fakeHelper(on, { config: { ...CONFIG, tests: TESTS } })
  await $.session.start(start)
  await $.tool.call({ tool: 'PowerShell', command: 'npm test' } as never)
  expect(seen.join()).toMatch(/No verified checkpoint yet/)
})

test('the pane verifies a checkpoint; a failure opens the rollback preview ready to confirm', async ($, on) => {
  engineBasics(on)
  toasts(on)
  let outcome: Record<string, unknown> = passed
  const calls = fakeHelper(on, {
    config: { ...CONFIG, tests: TESTS, testTimeoutSec: 60 },
    list: { ok: true, root: '/work', total: 2, checkpoints: [tested, good] },
    show: { ok: true, checkpoint: tested, files: [], skippedSample: [], tests: [] },
    preview: { ok: true, preview: { ...rollback.preview, id: tested.id, short: tested.short, actions: [] } },
    test: () => outcome,
    restore: { ok: true, applied: [{ path: 'a.txt', action: 'overwrite' }], undo: checkpoint({ short: 'u00002', kind: 'undo' }) },
  })
  await $.session.start(start)
  await run($, 'zeit-timeline')
  const ui = await $.ui.mount({ plugin: 'zeit-checkpoint', surface: 'terminal', component: 'Pane', requestId: 'zeit-timeline', props: PANE_PROPS })
  await ui.press({ key: `cp-${tested.id}` })
  await ui.press({ key: 'verify' })
  expect(calls).toContainEqual(['test', '--snapshot', tested.id, '--session', 'S1'])
  expect((await ui.find({ key: 'message' }))?.text).toMatch(/Verified 7e57ed: unit passed/)

  outcome = failed
  await ui.press({ key: 'verify' })
  expect((await ui.find({ key: 'message' }))?.text).toMatch(/tests failed \(exit 1\)\. Rollback to the last verified checkpoint 900d00/)
  expect((await ui.find({ key: 'preview' }))?.text).toMatch(/Restore from 900d00/)
  await ui.press({ key: 'confirm' })
  expect(calls).toContainEqual(['restore', good.id, '--confirm', 'rb-token', '--session', 'S1'])
  await ui.unmount()
})

test('no Verify button without test commands or on a partial checkpoint', async ($, on) => {
  engineBasics(on)
  const partial = checkpoint({ id: '20261121-170000-9a9a9a', short: '9a9a9a', kind: 'auto', scope: 'paths', complete: false })
  fakeHelper(on, {
    list: { ok: true, root: '/work', total: 1, checkpoints: [partial, tested] },
    show: { ok: true, checkpoint: partial, files: [], skippedSample: [], tests: [] },
    preview: { ok: true, preview: { ...rollback.preview, actions: [] } },
  })
  await $.session.start(start)
  await run($, 'zeit-timeline')
  const ui = await $.ui.mount({ plugin: 'zeit-checkpoint', surface: 'terminal', component: 'Pane', requestId: 'zeit-timeline', props: PANE_PROPS })
  await ui.press({ key: `cp-${tested.id}` })
  expect(await ui.find({ key: 'verify' })).toBeUndefined()
  await ui.unmount()
})
