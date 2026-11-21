// v1 acceptance: manual snapshots, cross-session listing, diffs, previewed restore with undo.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fixture, tree } from './fixture.mjs'

test('snapshot leaves the workspace and the Git index untouched', () => {
  const f = fixture({ git: true, files: { 'a.txt': 'a1\n', 'b.txt': 'b1\n', 'c.txt': 'c1\n' } })
  try {
    f.write('a.txt', 'a2 staged\n'); f.git('add', 'a.txt')
    f.write('b.txt', 'b2 unstaged\n')
    f.write('new.txt', 'untracked\n')
    const before = { status: f.git('status', '--porcelain'), staged: f.git('diff', '--cached'), files: tree(f.root) }
    const { checkpoint } = f.ok('snapshot', '--label', 'mixed state')
    assert.equal(checkpoint.fileCount, 4)
    assert.equal(checkpoint.scope, 'full')
    assert.equal(f.git('status', '--porcelain'), before.status)
    assert.equal(f.git('diff', '--cached'), before.staged)
    assert.deepEqual(tree(f.root), before.files, 'nothing written into the project')
    assert.ok(fs.readdirSync(f.home).length > 0, 'data stored under ZEIT_HOME')
  } finally { f.cleanup() }
})

test('non-Git snapshot skips dependency dirs and secrets, and stores identical content once', () => {
  const f = fixture({ files: { 'src/x.js': 'same', 'src/y.js': 'same', 'node_modules/p/i.js': 'dep', '.env': 'KEY=1', '.env.example': 'KEY=', 'k.pem': 'x' } })
  try {
    const { checkpoint } = f.ok('snapshot')
    const { files } = f.ok('show', checkpoint.short)
    assert.deepEqual(files.map(x => x.path), ['.env.example', 'src/x.js', 'src/y.js'])
    assert.equal(checkpoint.skipped.secret, 2)
    const objects = tree(f.home).filter(p => p.includes('/objects/'))
    assert.equal(objects.length, 2, 'two distinct contents')
  } finally { f.cleanup() }
})

test('shell-driven refactor: restore two files in a new session; unrelated edits and index survive', () => {
  const f = fixture({ git: true, files: { 'keep.txt': 'k1\n', 'over.txt': 'line1\nline2\nline3\n', 'gone.txt': 'g1\n' } })
  try {
    f.write('keep.txt', 'k2 staged\n'); f.git('add', 'keep.txt')
    const { checkpoint } = f.ok('snapshot', '--session', 'S1', '--label', 'before refactor')

    // "shell refactor": overwrite one file, delete another, plus an unrelated later edit.
    f.write('over.txt', 'line1\nCHANGED\nline3\n')
    f.rm('gone.txt')
    f.write('unrelated.txt', 'mine\n')
    const staged = f.git('diff', '--cached')

    // New session: a fresh process lists the checkpoint by its stored data alone.
    const list = f.ok('list')
    assert.equal(list.checkpoints[0].id, checkpoint.id)
    assert.equal(list.checkpoints[0].session, 'S1')

    const diff = f.ok('diff', checkpoint.short, '--path', 'over.txt')
    assert.match(diff.diffs[0].diff, /^-line2$/m)
    assert.match(diff.diffs[0].diff, /^\+CHANGED$/m)

    const { preview } = f.ok('preview', checkpoint.short, '--path', 'over.txt', '--path', 'gone.txt')
    assert.deepEqual(preview.actions.map(x => [x.path, x.action]), [['gone.txt', 'recreate'], ['over.txt', 'overwrite']])

    const done = f.ok('restore', checkpoint.short, '--path', 'over.txt', '--path', 'gone.txt', '--confirm', preview.token, '--session', 'S2')
    assert.equal(done.applied.length, 2)
    assert.equal(f.read('over.txt'), 'line1\nline2\nline3\n')
    assert.equal(f.read('gone.txt'), 'g1\n')
    assert.equal(f.read('unrelated.txt'), 'mine\n')
    assert.equal(f.read('keep.txt'), 'k2 staged\n')
    assert.equal(f.git('diff', '--cached'), staged, 'Git index untouched')
    assert.equal(done.undo.kind, 'undo')
  } finally { f.cleanup() }
})

test('restore refuses without a preview token and when files changed after the preview', () => {
  const f = fixture({ files: { 'a.txt': 'one' } })
  try {
    const { checkpoint } = f.ok('snapshot')
    f.write('a.txt', 'two')
    const noToken = f.zeit('restore', checkpoint.short)
    assert.equal(noToken.ok, false)
    assert.ok(noToken.preview, 'refusal carries the preview')
    const { preview } = f.ok('preview', checkpoint.short)
    f.write('a.txt', 'three (editor save after preview)')
    const stale = f.zeit('restore', checkpoint.short, '--confirm', preview.token)
    assert.equal(stale.ok, false)
    assert.match(stale.error, /changed since the preview/)
    assert.equal(f.read('a.txt'), 'three (editor save after preview)')
  } finally { f.cleanup() }
})

test('a rollback is undone by restoring its undo point, removing files it recreated', () => {
  const f = fixture({ files: { 'a.txt': 'orig', 'b.txt': 'b' } })
  try {
    const { checkpoint } = f.ok('snapshot')
    f.write('a.txt', 'edited'); f.rm('b.txt')
    const { preview } = f.ok('preview', checkpoint.short)
    const { undo } = f.ok('restore', checkpoint.short, '--confirm', preview.token)
    assert.equal(f.read('b.txt'), 'b')
    const back = f.ok('preview', 'undo')
    assert.equal(back.preview.id, undo.id)
    assert.deepEqual(back.preview.actions.map(x => [x.path, x.action]), [['a.txt', 'overwrite'], ['b.txt', 'remove']])
    f.ok('restore', 'undo', '--confirm', back.preview.token)
    assert.equal(f.read('a.txt'), 'edited')
    assert.equal(f.exists('b.txt'), false)
  } finally { f.cleanup() }
})

test('new files are kept by default and removed only with --delete-new', () => {
  const f = fixture({ files: { 'a.txt': 'a' } })
  try {
    const { checkpoint } = f.ok('snapshot')
    f.write('extra.txt', 'new')
    const keep = f.ok('preview', checkpoint.short)
    assert.equal(keep.preview.actions.length, 0)
    const del = f.ok('preview', checkpoint.short, '--delete-new')
    assert.deepEqual(del.preview.actions.map(x => [x.path, x.action, !!x.isNew]), [['extra.txt', 'remove', true]])
    f.ok('restore', checkpoint.short, '--delete-new', '--confirm', del.preview.token)
    assert.equal(f.exists('extra.txt'), false)
  } finally { f.cleanup() }
})

test('an interrupted restore is recovered from its undo point', () => {
  const f = fixture({ files: { 'a.txt': 'a-orig', 'b.txt': 'b-orig' } })
  try {
    const { checkpoint } = f.ok('snapshot')
    f.write('a.txt', 'a-new'); f.write('b.txt', 'b-new')
    // Block the second write so the restore stops midway.
    const blocker = process.platform === 'win32' ? f.file('b.txt') : f.root
    if (process.platform === 'win32') fs.chmodSync(blocker, 0o444)
    else { fs.renameSync(f.file('b.txt'), f.file('b.tmp')); fs.mkdirSync(f.file('b.txt')) }
    const { preview } = f.ok('preview', checkpoint.short, '--path', 'a.txt', '--path', 'b.txt')
    if (process.platform !== 'win32') {
      assert.equal(preview.actions.find(x => x.path === 'b.txt').action, 'blocked')
      return
    }
    const broken = f.zeit('restore', checkpoint.short, '--path', 'a.txt', '--path', 'b.txt', '--confirm', preview.token)
    assert.equal(broken.ok, false)
    assert.deepEqual(broken.applied, [{ path: 'a.txt', action: 'overwrite' }])
    assert.equal(f.read('a.txt'), 'a-orig', 'first file already restored')
    fs.chmodSync(blocker, 0o666)
    const back = f.ok('preview', broken.undo.short)
    f.ok('restore', broken.undo.short, '--confirm', back.preview.token)
    assert.equal(f.read('a.txt'), 'a-new')
    assert.equal(f.read('b.txt'), 'b-new')
  } finally { f.cleanup() }
})

test('ids resolve by short suffix, "latest", and reject ambiguity', () => {
  const f = fixture({ files: { 'a.txt': 'a' } })
  try {
    const one = f.ok('snapshot').checkpoint
    const two = f.ok('snapshot').checkpoint
    assert.equal(f.ok('show', 'latest').checkpoint.id, two.id)
    assert.equal(f.ok('show', one.short).checkpoint.id, one.id)
    assert.equal(f.zeit('show', 'nope').ok, false)
  } finally { f.cleanup() }
})
