// v2 acceptance: first-touch capture per turn, release of refused calls, bounded shell
// snapshots, retention and pinning.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fixture } from './fixture.mjs'

test('first-touch capture protects every file a turn edits, each at its pre-turn state', () => {
  const f = fixture({ files: { 'a.ts': 'a0', 'b.ts': 'b0' } })
  try {
    const one = f.ok('capture', '--turn', 'T1', '--session', 'S1', '--path', f.file('a.ts'))
    assert.equal(one.isNew, true)
    assert.deepEqual(one.added, ['a.ts'])
    f.write('a.ts', 'a1')                                        // the edit runs
    const again = f.ok('capture', '--turn', 'T1', '--path', f.file('a.ts'))
    assert.deepEqual(again.covered, ['a.ts'], 'second edit of a.ts keeps the pre-turn copy')
    f.write('a.ts', 'a2')
    const later = f.ok('capture', '--turn', 'T1', '--path', f.file('b.ts'))  // five calls later
    assert.equal(later.isNew, false)
    assert.equal(later.checkpoint.id, one.checkpoint.id)
    f.write('b.ts', 'b1')
    const created = f.ok('capture', '--turn', 'T1', '--path', f.file('new/c.ts'))  // Write of a new file
    assert.deepEqual(created.added, ['new/c.ts'])
    f.write('new/c.ts', 'c1')

    const { preview } = f.ok('preview', one.checkpoint.short)
    assert.deepEqual(preview.actions.map(x => [x.path, x.action]), [['a.ts', 'overwrite'], ['b.ts', 'overwrite'], ['new/c.ts', 'remove']])
    f.ok('restore', one.checkpoint.short, '--confirm', preview.token)
    assert.equal(f.read('a.ts'), 'a0')
    assert.equal(f.read('b.ts'), 'b0')
    assert.equal(f.exists('new/c.ts'), false)

    const next = f.ok('capture', '--turn', 'T2', '--path', f.file('a.ts'))
    assert.equal(next.isNew, true, 'a new turn starts a new checkpoint')
  } finally { f.cleanup() }
})

test('capture records why a path is not protected', () => {
  const f = fixture({ files: { '.env': 'SECRET=1', 'ok.txt': 'x' } })
  try {
    const outside = path.join(f.base, 'elsewhere.txt')
    const r = f.ok('capture', '--turn', 'T1', '--path', f.file('.env'), '--path', outside, '--path', f.file('ok.txt'))
    assert.deepEqual(r.added, ['ok.txt'])
    assert.deepEqual(r.skipped.map(s => s.reason).sort(), ['outside-project', 'secret'])
    assert.equal(r.checkpoint.skippedCount, 2)
  } finally { f.cleanup() }
})

test('release drops a capture whose edit was refused, but keeps one whose file changed', () => {
  const f = fixture({ files: { 'a.ts': 'a0', 'b.ts': 'b0' } })
  try {
    f.ok('capture', '--turn', 'T1', '--path', f.file('a.ts'))
    f.ok('capture', '--turn', 'T1', '--path', f.file('b.ts'))
    f.write('b.ts', 'b1')
    const r = f.ok('release', '--turn', 'T1', '--path', f.file('a.ts'), '--path', f.file('b.ts'))
    assert.deepEqual(r.released, ['a.ts'])
    assert.equal(r.checkpoint.fileCount, 1)
    f.write('b.ts', 'b0')
    const gone = f.ok('release', '--turn', 'T1', '--path', f.file('b.ts'))
    assert.ok(gone.dropped, 'empty turn checkpoint is removed')
    assert.equal(f.ok('list').total, 0)
  } finally { f.cleanup() }
})

test('bounded shell snapshots stop at the shell limits and say what they skipped', () => {
  const files = {}
  for (let i = 0; i < 30; i++) files[`f${String(i).padStart(2, '0')}.txt`] = `file ${i}`
  files['big.bin'] = 'x'.repeat(3 * 1024 * 1024)
  const f = fixture({ files })
  try {
    f.write('.zeit.json', JSON.stringify({ shellLimits: { maxFiles: 10, maxFileMB: 2, maxTotalMB: 1 } }))
    const r = f.ok('snapshot', '--kind', 'shell', '--bounded', '--label', 'before: rm -rf out')
    assert.equal(r.checkpoint.fileCount, 10)
    assert.equal(r.checkpoint.skipped['too-large'], 1)
    assert.equal(r.checkpoint.skipped.budget, 21)
    assert.equal(r.checkpoint.complete, false)
    const full = f.ok('snapshot')
    assert.equal(full.checkpoint.fileCount, 32, 'manual snapshots use the normal limits')
  } finally { f.cleanup() }
})

test('a repeated snapshot reuses stored content through the stat cache', () => {
  const f = fixture({ files: { 'a.txt': 'a', 'b.txt': 'b' } })
  try {
    // Age the files so the racy-mtime rule lets the cache be trusted.
    const old = new Date(Date.now() - 60_000)
    for (const n of ['a.txt', 'b.txt']) fs.utimesSync(f.file(n), old, old)
    const one = f.ok('snapshot').checkpoint
    f.write('b.txt', 'b2')
    const two = f.ok('snapshot').checkpoint
    assert.equal(one.fileCount, 2)
    const { preview } = f.ok('preview', one.short)
    assert.deepEqual(preview.actions.map(x => x.path), ['b.txt'], 'cache does not hide the changed file')
    assert.notEqual(one.id, two.id)
  } finally { f.cleanup() }
})

test('retention prunes by age, count and size, never pinned or the last verified checkpoint', () => {
  const f = fixture({ files: { 'a.txt': 'a' } })
  try {
    const ids = []
    for (let i = 0; i < 5; i++) { f.write('a.txt', `v${i} `.repeat(2000)); ids.push(f.ok('snapshot').checkpoint) }
    f.ok('pin', ids[0].short)
    assert.equal(f.ok('show', ids[0].short).checkpoint.pinned, true)

    // Age the two oldest by rewriting their manifests.
    const dir = path.join(f.home, 'projects')
    const project = path.join(dir, fs.readdirSync(dir)[0], 'snapshots')
    for (const c of ids.slice(0, 2)) {
      const file = path.join(project, `${c.id}.json`)
      const m = JSON.parse(fs.readFileSync(file, 'utf8'))
      m.createdAt -= 30 * 86400000
      fs.writeFileSync(file, JSON.stringify(m))
    }
    const byAge = f.ok('prune', '--maxAgeDays', '14')
    assert.deepEqual(byAge.removed.map(c => c.id), [ids[1].id], 'old pinned checkpoint survives')
    assert.ok(byAge.objectsRemoved >= 1)

    const byCount = f.ok('prune', '--maxCount', '1')
    assert.deepEqual(byCount.removed.map(c => c.id).sort(), [ids[2].id, ids[3].id].sort())

    f.ok('unpin', ids[0].short)
    const bySize = f.ok('prune', '--maxMB', '0')
    assert.deepEqual(bySize.removed.map(c => c.id).sort(), [ids[0].id, ids[4].id].sort())
    assert.equal(f.ok('list').total, 0)
  } finally { f.cleanup() }
})

test('a pinned checkpoint cannot be dropped without --force', () => {
  const f = fixture({ files: { 'a.txt': 'a' } })
  try {
    const c = f.ok('snapshot').checkpoint
    f.ok('pin', c.short)
    assert.equal(f.zeit('drop', c.short).ok, false)
    f.ok('drop', c.short, '--force')
    assert.equal(f.ok('list').total, 0)
  } finally { f.cleanup() }
})

test('config exposes the shell patterns that trigger a snapshot', () => {
  const f = fixture({ files: { 'a.txt': 'a' } })
  try {
    f.write('.zeit.json', JSON.stringify({ shellPatterns: ['\\bmake\\s+clean\\b'] }))
    const { shellPatterns } = f.ok('config')
    const hits = cmd => shellPatterns.some(p => new RegExp(p).test(cmd))
    for (const cmd of ['rm -rf dist', 'Remove-Item -Recurse x', 'git reset --hard', 'git checkout -- a.ts', 'echo hi > a.txt', "sed -i 's/a/b/' f", 'make clean', 'mv a b'])
      assert.ok(hits(cmd), `matches: ${cmd}`)
    for (const cmd of ['ls -la', 'git status', 'npm test', 'echo hi 2>/dev/null', 'cat a > /dev/null', 'Get-ChildItem', 'node -e "1"'])
      assert.ok(!hits(cmd), `no match: ${cmd}`)
  } finally { f.cleanup() }
})
