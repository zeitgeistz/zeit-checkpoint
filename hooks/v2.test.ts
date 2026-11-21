import { expect, test } from 'claude-code/testing'

import { BAND_PROPS, checkpoint, engineBasics, fakeHelper, fakeTools, run } from './fake'

const start = { cwd: '/work', surface: 'terminal' as const, isInteractive: true }
const auto = checkpoint({ id: '20261121-150000-c0ffee', short: 'c0ffee', kind: 'auto', scope: 'paths', label: 'before edits', fileCount: 1 })

const captured = (added: string[], covered: string[] = [], skipped: { path: string; reason: string }[] = [], isNew = true) =>
  ({ ok: true, checkpoint: auto, isNew, added, covered, skipped })

test('each file is captured before its first edit in the turn, under that turn', async ($, on) => {
  engineBasics(on)
  const ran = fakeTools(on)
  let n = 0
  const calls = fakeHelper(on, { capture: args => (n++ === 0 ? captured(['a.ts']) : captured(['b.ts'], [], [], false)) })
  await $.session.start(start)
  await $.turn.start({ text: 'refactor', turnId: 'T1' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/a.ts', old_string: 'a', new_string: 'b' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/work/x.ts' } as never)
  await $.tool.call({ tool: 'Write', file_path: '/work/b.ts', content: 'new' } as never)
  const captures = calls.filter(c => c[0] === 'capture')
  expect(captures).toEqual([
    ['capture', '--turn', 'T1', '--session', 'S1', '--label', 'before edits', '--path', '/work/a.ts'],
    ['capture', '--turn', 'T1', '--session', 'S1', '--label', 'before edits', '--path', '/work/b.ts'],
  ])
  expect(ran).toEqual(['Edit', 'Read', 'Write'])
  const ui = await $.ui.mount({ plugin: 'zeit-checkpoint', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect((await ui.find({ key: 'coverage' }))?.text).toMatch(/this turn: 2 file\(s\) protected in c0ffee/)
  expect((await ui.find({ key: 'last' }))?.text).toMatch(/c0ffee "before edits" · auto/)
  await ui.unmount()
})

test('a refused or failed edit releases its capture; one that ran keeps it', async ($, on) => {
  engineBasics(on)
  fakeTools(on, e => (e.file_path === '/work/denied.ts' ? { deny: 'The user said no' } : e.file_path === '/work/broken.ts' ? { result: 'x', text: 'old_string not found', isError: true } : { result: 'ok', text: 'ok' }))
  const calls = fakeHelper(on, {
    capture: args => captured([String(args[args.length - 1]).replace('/work/', '')]),
    release: args => ({ ok: true, released: [String(args[args.length - 1]).replace('/work/', '')], checkpoint: auto }),
  })
  await $.session.start(start)
  await $.turn.start({ text: '', turnId: 'T1' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/denied.ts', old_string: 'a', new_string: 'b' } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/work/broken.ts', old_string: 'a', new_string: 'b' } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/work/fine.ts', old_string: 'a', new_string: 'b' } as never)
  expect(calls.filter(c => c[0] === 'release').map(c => c[c.length - 1])).toEqual(['/work/denied.ts', '/work/broken.ts'])
  const ui = await $.ui.mount({ plugin: 'zeit-checkpoint', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect((await ui.find({ key: 'coverage' }))?.text).toMatch(/1 file\(s\) protected/)
  await ui.unmount()
})

test('a failing capture never blocks the edit, and the band says what was missed', async ($, on) => {
  engineBasics(on)
  const ran = fakeTools(on)
  fakeHelper(on, { capture: { ok: false, error: 'the checkpoint store is busy; try again' } })
  await $.session.start(start)
  await $.turn.start({ text: '', turnId: 'T1' })
  const r = await $.tool.call({ tool: 'Write', file_path: '/work/a.ts', content: 'x' } as never)
  expect(ran).toEqual(['Write'])
  expect((r as { text?: string }).text).toBe('done')
  const ui = await $.ui.mount({ plugin: 'zeit-checkpoint', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect((await ui.find({ key: 'failed-/work/a.ts' }))?.text).toMatch(/capture failed for \/work\/a\.ts: the checkpoint store is busy/)
  await ui.unmount()
})

test('skipped paths are shown as not protected', async ($, on) => {
  engineBasics(on)
  fakeTools(on)
  fakeHelper(on, { capture: { ...captured([], [], [{ path: '.env', reason: 'secret' }]), checkpoint: auto } })
  await $.session.start(start)
  await $.turn.start({ text: '', turnId: 'T1' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/.env', old_string: 'a', new_string: 'b' } as never)
  const ui = await $.ui.mount({ plugin: 'zeit-checkpoint', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect((await ui.find({ key: 'skipped' }))?.text).toMatch(/not protected: \.env \(secret\)/)
  await ui.unmount()
})

test('risky shell commands get a bounded snapshot first; others and refused ones do not keep one', async ($, on) => {
  engineBasics(on)
  fakeTools(on, e => (String(e.command).startsWith('git reset') ? { deny: 'no' } : { result: 'ok', text: 'ok' }))
  const shell = checkpoint({ id: '20261121-151000-5he11a', short: '5he11a', kind: 'shell', fileCount: 230, skippedCount: 4 })
  const calls = fakeHelper(on, { snapshot: { ok: true, checkpoint: shell }, drop: { ok: true, dropped: shell.id } })
  await $.session.start(start)
  await $.turn.start({ text: '', turnId: 'T1' })
  await $.tool.call({ tool: 'Bash', command: 'ls -la' } as never)
  expect(calls.some(c => c[0] === 'snapshot')).toBe(false)
  await $.tool.call({ tool: 'PowerShell', command: 'rm -r out\nrm x' } as never)
  expect(calls.filter(c => c[0] === 'snapshot')).toEqual([['snapshot', '--kind', 'shell', '--bounded', '--session', 'S1', '--label', 'before: rm -r out']])
  const ui = await $.ui.mount({ plugin: 'zeit-checkpoint', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect((await ui.find({ key: 'shell' }))?.text).toMatch(/shell snapshot 5he11a before "rm -r out": 230 files, 4 skipped \(over the shell limits\)/)
  await $.tool.call({ tool: 'Bash', command: 'git reset --hard' } as never)
  expect(calls.filter(c => c[0] === 'drop')).toEqual([['drop', shell.id]])
  expect(await ui.find({ key: 'shell' })).toBeUndefined()
  await ui.unmount()
})

test('a new turn clears the coverage; a turn that made checkpoints applies retention', async ($, on) => {
  engineBasics(on)
  fakeTools(on)
  const calls = fakeHelper(on, { capture: captured(['a.ts']) })
  await $.session.start(start)
  const prunesAtStart = calls.filter(c => c[0] === 'prune').length
  await $.turn.start({ text: '', turnId: 'T1' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/a.ts', old_string: 'a', new_string: 'b' } as never)
  await $.turn.complete({ turnId: 'T1', answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' })
  expect(calls.filter(c => c[0] === 'prune').length).toBe(prunesAtStart + 1)
  await $.turn.start({ text: '', turnId: 'T2' })
  const ui = await $.ui.mount({ plugin: 'zeit-checkpoint', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ key: 'coverage' })).toBeUndefined()
  await $.turn.complete({ turnId: 'T2', answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' })
  expect(calls.filter(c => c[0] === 'prune').length).toBe(prunesAtStart + 1)
  await ui.unmount()
})

test('/zeit-pin, /zeit-unpin and /zeit-prune', async ($, on) => {
  engineBasics(on)
  const calls = fakeHelper(on, {
    pin: { ok: true, checkpoint: checkpoint({ pinned: true }) },
    unpin: { ok: true, checkpoint: checkpoint() },
  })
  await $.session.start(start)
  expect((await run($, 'zeit-pin', 'a3f9c1')).text).toMatch(/^Pinned a3f9c1 .*\[pinned\]\. Retention never removes it\.$/)
  expect((await run($, 'zeit-unpin', 'a3f9c1')).text).toMatch(/^Unpinned a3f9c1/)
  expect((await run($, 'zeit-pin', '')).text).toBe('Usage: /zeit-pin <id>')
  expect((await run($, 'zeit-prune')).text).toMatch(/removed 0 checkpoint\(s\)/)
  expect(calls).toContainEqual(['pin', 'a3f9c1'])
})
