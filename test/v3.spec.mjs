// v3 acceptance: the diff and restore data the timeline pane draws.
import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './fixture.mjs'

test('diffs are unified hunks with correct line numbers, per file, in path order', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`)
  const f = fixture({ files: { 'b.txt': lines.join('\n') + '\n', 'a.txt': 'x\n' } })
  try {
    const c = f.ok('snapshot').checkpoint
    const changed = [...lines]
    changed[4] = 'five'
    changed.splice(30, 1)
    f.write('b.txt', changed.join('\n') + '\n')
    f.write('a.txt', 'y\n')
    const { diffs } = f.ok('diff', c.short)
    assert.deepEqual(diffs.map(d => d.path), ['a.txt', 'b.txt'])
    const b = diffs[1].diff.split('\n')
    assert.deepEqual(b.filter(l => l.startsWith('@@')), ['@@ -2,7 +2,7 @@', '@@ -28,7 +28,6 @@'])
    assert.ok(b.includes('-line 5') && b.includes('+five') && b.includes('-line 31'))
    // Every hunk's counts match its body, so the pane's diff renderer can parse it.
    for (const d of diffs) {
      const body = d.diff.split('\n').slice(2)
      for (let i = 0; i < body.length;) {
        const m = /^@@ -\d+,(\d+) \+\d+,(\d+) @@$/.exec(body[i])
        assert.ok(m, `hunk header: ${body[i]}`)
        let old = 0, now = 0, j = i + 1
        for (; j < body.length && !body[j].startsWith('@@'); j++) { if (body[j][0] !== '+') old++; if (body[j][0] !== '-') now++ }
        assert.deepEqual([old, now], [Number(m[1]), Number(m[2])])
        i = j
      }
    }
  } finally { f.cleanup() }
})

test('diff states cover deleted, added and binary files', () => {
  const f = fixture({ files: { 'gone.txt': 'g\n', 'img.bin': Buffer.from([0, 1, 2, 3]).toString('latin1') } })
  try {
    const turn = f.ok('capture', '--turn', 'T', '--path', f.file('later.txt'), '--path', f.file('img.bin'), '--path', f.file('gone.txt')).checkpoint
    f.rm('gone.txt')
    f.write('later.txt', 'new\n')
    f.write('img.bin', Buffer.from([0, 9, 9]).toString('latin1'))
    const { diffs } = f.ok('diff', turn.short)
    const by = Object.fromEntries(diffs.map(d => [d.path, d]))
    assert.equal(by['gone.txt'].state, 'deleted since')
    assert.match(by['gone.txt'].diff, /^-g$/m)
    assert.equal(by['later.txt'].state, 'added since')
    assert.match(by['later.txt'].diff, /^@@ -0,0 \+1,1 @@$/m)
    assert.equal(by['img.bin'].note, 'binary file differs')
  } finally { f.cleanup() }
})

test('a line-ending-only change is reported, and restore brings back the exact bytes', () => {
  const f = fixture({ files: { 'crlf.txt': 'a\r\nb\r\n' } })
  try {
    const c = f.ok('snapshot').checkpoint
    f.write('crlf.txt', 'a\nb\n')
    const { diffs } = f.ok('diff', c.short)
    assert.match(diffs[0].note, /line endings/)
    const { preview } = f.ok('preview', c.short, '--path', 'crlf.txt')
    f.ok('restore', c.short, '--path', 'crlf.txt', '--confirm', preview.token)
    assert.equal(f.read('crlf.txt'), 'a\r\nb\r\n')
  } finally { f.cleanup() }
})
