// v5 acceptance: fork a full snapshot into its own Git worktree; export one to a local zip.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fixture, tree } from './fixture.mjs'

const gitIn = (dir, ...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).stdout
// bsdtar reads zip files; on Windows it is the system tar, which a Git Bash GNU tar can shadow on PATH.
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'bsdtar'

test('fork recreates the snapshot in a new worktree and branch, leaving the workspace alone', () => {
  const f = fixture({ git: true, files: { 'a.txt': 'one\n', 'old.txt': 'tracked, deleted before the snapshot\n', 'src/b.txt': 'b\n' } })
  try {
    f.write('a.txt', 'edited, not committed\n')
    f.rm('old.txt')
    f.write('untracked.txt', 'new\n')
    const c = f.ok('snapshot', '--label', 'experiment').checkpoint
    f.write('a.txt', 'later work\n')
    const before = { tree: tree(f.root), status: f.git('status', '--porcelain'), branch: f.git('branch', '--show-current') }

    const r = f.ok('fork', c.short)
    assert.equal(r.dest, path.join(f.base, `work-zeit-${c.short}`))
    assert.equal(r.branch, `zeit/${c.short}`)
    assert.deepEqual(r.removed, ['old.txt'])
    assert.deepEqual(tree(r.dest), ['a.txt', 'src/b.txt', 'untracked.txt'])
    assert.equal(fs.readFileSync(path.join(r.dest, 'a.txt'), 'utf8'), 'edited, not committed\n')
    assert.equal(gitIn(r.dest, 'branch', '--show-current').trim(), `zeit/${c.short}`)
    assert.match(f.git('worktree', 'list'), new RegExp(`work-zeit-${c.short}`))

    assert.deepEqual({ tree: tree(f.root), status: f.git('status', '--porcelain'), branch: f.git('branch', '--show-current') }, before)
    assert.equal(f.read('a.txt'), 'later work\n')
  } finally { f.cleanup() }
})

test('fork refuses non-git projects, partial snapshots, and a non-empty destination', () => {
  const plain = fixture({ files: { 'a.txt': 'x' } })
  try {
    const c = plain.ok('snapshot').checkpoint
    assert.match(plain.zeit('fork', c.short).error, /needs a Git repository/)
  } finally { plain.cleanup() }

  const f = fixture({ git: true, files: { 'a.txt': 'x' } })
  try {
    const partial = f.ok('capture', '--turn', 'T', '--path', f.file('a.txt')).checkpoint
    assert.match(f.zeit('fork', partial.short).error, /only a complete workspace snapshot/)
    const c = f.ok('snapshot').checkpoint
    const dest = path.join(f.base, 'busy')
    fs.mkdirSync(dest)
    fs.writeFileSync(path.join(dest, 'keep.txt'), 'mine')
    assert.match(f.zeit('fork', c.short, '--dest', dest).error, /already exists and is not empty/)
    assert.equal(fs.readFileSync(path.join(dest, 'keep.txt'), 'utf8'), 'mine')
    const custom = f.ok('fork', c.short, '--dest', path.join(f.base, 'elsewhere'), '--branch', 'try/it')
    assert.equal(custom.branch, 'try/it')
  } finally { f.cleanup() }
})

test('export writes a zip of the snapshot files and its manifest, readable by tar', () => {
  const f = fixture({ files: { 'a.txt': 'alpha\n'.repeat(200), '.env': 'SECRET=1' } })
  try {
    f.write('dir/b.bin', Buffer.from([0, 1, 2, 255]))
    const c = f.ok('snapshot', '--label', 'ship it').checkpoint
    const out = path.join(f.base, 'export.zip')
    const r = f.ok('export', c.short, '--out', out)
    assert.equal(r.files, 2)
    const list = spawnSync(TAR, ['-tf', out], { encoding: 'utf8' })
    assert.equal(list.status, 0, list.stderr)
    assert.deepEqual(list.stdout.split(/\r?\n/).filter(Boolean).sort(), ['files/a.txt', 'files/dir/b.bin', 'zeit-manifest.json'])

    const unpacked = path.join(f.base, 'unpacked')
    fs.mkdirSync(unpacked)
    const x = spawnSync(TAR, ['-xf', out, '-C', unpacked], { encoding: 'utf8' })
    assert.equal(x.status, 0, x.stderr)
    assert.equal(fs.readFileSync(path.join(unpacked, 'files', 'a.txt'), 'utf8'), 'alpha\n'.repeat(200))
    assert.deepEqual([...fs.readFileSync(path.join(unpacked, 'files', 'dir', 'b.bin'))], [0, 1, 2, 255])
    const manifest = JSON.parse(fs.readFileSync(path.join(unpacked, 'zeit-manifest.json'), 'utf8'))
    assert.equal(manifest.label, 'ship it')
    assert.equal(manifest.root, undefined, 'the local path is not exported')
    assert.equal(manifest.project, 'work')

    assert.match(f.zeit('export', c.short, '--out', out).error, /already exists/)
    f.ok('export', c.short, '--out', out, '--force')
  } finally { f.cleanup() }
})

test('export defaults to the storage folder and never writes into the workspace', () => {
  const f = fixture({ files: { 'a.txt': 'x' } })
  try {
    const before = tree(f.root)
    const r = f.ok('export', f.ok('snapshot').checkpoint.short)
    assert.ok(r.out.startsWith(path.join(f.home, 'exports')), r.out)
    assert.ok(fs.existsSync(r.out))
    assert.deepEqual(tree(f.root), before)
  } finally { f.cleanup() }
})
