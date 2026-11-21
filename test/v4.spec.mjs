// v4 acceptance: project-defined tests; a checkpoint is verified only when the tested
// file state is exactly the checkpoint's, before and after the run.
import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './fixture.mjs'

const node = js => `node -e "${js}"`
const TESTS = {
  unit: node("process.exit(require('fs').readFileSync('a.txt','utf8')==='good'?0:1)"),
  mutate: node("require('fs').writeFileSync('a.txt','mutated')"),
  slow: node('setTimeout(()=>{},5000)'),
}

function project(files = { 'a.txt': 'good' }) {
  const f = fixture({ files })
  f.write('.zeit.json', JSON.stringify({ tests: TESTS }))
  return f
}

test('a passing run on the snapshotted state verifies that checkpoint', () => {
  const f = project()
  try {
    const r = f.ok('test', '--name', 'unit', '--session', 'S1')
    assert.equal(r.passed, true)
    assert.equal(r.verified, true)
    assert.equal(r.reason, null)
    assert.equal(r.checkpoint.kind, 'test')
    assert.equal(r.checkpoint.verified.name, 'unit')
    const listed = f.ok('list').checkpoints[0]
    assert.equal(listed.verified.command, TESTS.unit)
    assert.equal(f.ok('show', listed.short).tests[0].exitCode, 0)
  } finally { f.cleanup() }
})

test('a failing run is not verified and offers a rollback preview to the last verified checkpoint', () => {
  const f = project()
  try {
    const good = f.ok('test', '--name', 'unit').checkpoint
    f.write('a.txt', 'broken')
    f.write('b.txt', 'new file')
    const r = f.ok('test', '--name', 'unit')
    assert.equal(r.passed, false)
    assert.equal(r.verified, false)
    assert.equal(r.exitCode, 1)
    assert.equal(r.rollback.checkpoint.id, good.id)
    assert.deepEqual(r.rollback.preview.actions.map(x => [x.path, x.action]), [['a.txt', 'overwrite']], 'new files are kept by the offered rollback')
    f.ok('restore', good.short, '--confirm', r.rollback.preview.token)
    assert.equal(f.read('a.txt'), 'good')
  } finally { f.cleanup() }
})

test('a run that changes files is not verified even when it passes', () => {
  const f = project()
  try {
    const r = f.ok('test', '--name', 'mutate')
    assert.equal(r.passed, true)
    assert.equal(r.verified, false)
    assert.match(r.reason, /test run changed files \(a\.txt\)/)
    assert.equal(r.checkpoint.verified, null)
  } finally { f.cleanup() }
})

test('verifying an older checkpoint requires the workspace to match it exactly', () => {
  const f = project()
  try {
    const old = f.ok('snapshot', '--label', 'older').checkpoint
    f.write('extra.txt', 'x')
    const mismatch = f.ok('test', '--name', 'unit', '--snapshot', old.short)
    assert.equal(mismatch.passed, true)
    assert.equal(mismatch.verified, false)
    assert.match(mismatch.reason, /workspace differs from the checkpoint \(extra\.txt\)/)
    f.rm('extra.txt')
    const match = f.ok('test', '--name', 'unit', '--snapshot', old.short)
    assert.equal(match.verified, true)
    assert.equal(match.checkpoint.id, old.id)
  } finally { f.cleanup() }
})

test('incomplete snapshots and unknown or missing test commands are refused', () => {
  const f = project()
  try {
    const turn = f.ok('capture', '--turn', 'T', '--path', f.file('a.txt')).checkpoint
    const partial = f.ok('test', '--name', 'unit', '--snapshot', turn.short)
    assert.equal(partial.verified, false)
    assert.match(partial.reason, /not a complete workspace snapshot/)
    assert.match(f.zeit('test', '--name', 'nope').error, /no test command "nope"/)
    f.write('.zeit.json', '{}')
    assert.match(f.zeit('test').error, /no test commands/)
  } finally { f.cleanup() }
})

test('a test run past its timeout fails and is not verified', () => {
  const f = project()
  try {
    const r = f.ok('test', '--name', 'slow', '--timeout', '1')
    assert.equal(r.passed, false)
    assert.equal(r.verified, false)
  } finally { f.cleanup() }
})

test('retention keeps the last verified checkpoint', () => {
  const f = project()
  try {
    const good = f.ok('test', '--name', 'unit').checkpoint
    f.ok('snapshot')
    const r = f.ok('prune', '--maxCount', '0')
    assert.equal(r.removed.length, 1)
    assert.equal(f.ok('list').checkpoints[0].id, good.id)
  } finally { f.cleanup() }
})
