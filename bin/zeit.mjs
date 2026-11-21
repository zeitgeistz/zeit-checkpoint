#!/usr/bin/env node
// zeit-checkpoint helper: local content-addressed snapshots of a workspace.
// Every command prints one JSON line ({ ok: true, ... } or { ok: false, error }).
// Snapshot data lives outside the project, under ZEIT_HOME or the platform data dir.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { spawn, spawnSync } from 'node:child_process'

const IS_WIN = process.platform === 'win32'
const MB = 1024 * 1024

// Directory names skipped when walking a non-Git workspace (Git workspaces use .gitignore).
const DEFAULT_DIRS = new Set([
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target',
  '.next', '.nuxt', '.cache', 'coverage', '.turbo', '.gradle', '.pytest_cache',
  '.mypy_cache', '.tox', '.parcel-cache',
])
const SECRET_FILES = [
  /^\.env(\..+)?$/i, /\.(pem|key|p12|pfx|jks|keystore)$/i, /^id_(rsa|dsa|ecdsa|ed25519)$/,
  /^\.(npmrc|pypirc|netrc)$/i,
]
const SECRET_ALLOWED = /^\.env\.(example|sample|template)$/i

// Shell commands that may rewrite or delete files; projects add their own in .zeit.json.
const DEFAULT_SHELL_PATTERNS = [
  String.raw`(^|[\s;&|(])(rm|rmdir|del|erase|rd|unlink|shred|truncate)\s`,
  String.raw`\b(Remove-Item|Move-Item|Rename-Item|Set-Content|Clear-Content|Out-File|Copy-Item)\b`,
  String.raw`(^|[\s;&|(])(ri|mv|move|ren|cp|copy)\s`,
  String.raw`\bgit\s+(reset|checkout|restore|clean|stash|rebase|merge|pull|switch|apply|am|revert|cherry-pick)\b`,
  String.raw`\bsed\s+(-[a-zA-Z]*i|--in-place)`,
  String.raw`\bfind\b.*\s-delete\b`,
  String.raw`\bxargs\s+rm\b`,
  String.raw`(^|[^>&0-9])>\s*(?!\s*(/dev/null|\$null|nul)\b)[^\s>&|]`,
]

const DEFAULTS = {
  limits: { maxFiles: 20000, maxFileMB: 20, maxTotalMB: 500 },
  shellLimits: { maxFiles: 5000, maxFileMB: 5, maxTotalMB: 200 },
  retention: { maxAgeDays: 14, maxCount: 300, maxMB: 2048 },
  testTimeoutSec: 540,
}

class ZeitError extends Error {
  constructor(message, extra = {}) { super(message); this.extra = extra }
}

// ---------- small utilities ----------

const sha = buf => crypto.createHash('sha256').update(buf).digest('hex')
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const posix = p => p.split(path.sep).join('/')
const caseKey = s => (IS_WIN ? s.toLowerCase() : s)

function real(p) {
  try { return fs.realpathSync.native(p) } catch { return path.resolve(p) }
}

// Resolves a path that may not exist yet to its real spelling (true case on Windows).
function realLoose(p) {
  const abs = path.resolve(p)
  if (fs.existsSync(abs)) return real(abs)
  const parent = path.dirname(abs)
  return parent === abs ? abs : path.join(realLoose(parent), path.basename(abs))
}

function git(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 1 << 30, windowsHide: true })
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.zeit-${process.pid}-${crypto.randomBytes(3).toString('hex')}`)
  fs.writeFileSync(tmp, data)
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(tmp, file); return } catch (err) {
      // Windows refuses a rename while another process briefly holds the target open.
      if (attempt < 8 && IS_WIN && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES')) { sleep(40 * (attempt + 1)); continue }
      fs.rmSync(tmp, { force: true })
      throw err
    }
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (err) {
    if (err.code === 'ENOENT') return fallback
    throw err
  }
}

function newId() {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`
}
const shortOf = id => id.slice(-6)

// ---------- project, config, store ----------

function resolveRoot(given) {
  const start = path.resolve(given ?? process.cwd())
  if (!fs.existsSync(start)) throw new ZeitError(`no such directory: ${start}`)
  const top = git(start, ['rev-parse', '--show-toplevel'])
  const isGit = top.ok && top.stdout.trim() !== ''
  return { root: real(isGit ? top.stdout.trim() : start), isGit }
}

function storageHome() {
  if (process.env.ZEIT_HOME) return path.resolve(process.env.ZEIT_HOME)
  if (IS_WIN) return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'zeit-checkpoints')
  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'zeit-checkpoints')
}

function loadConfig(root) {
  const file = path.join(root, '.zeit.json')
  let cfg
  try { cfg = readJson(file, {}) } catch (err) { throw new ZeitError(`.zeit.json is not valid JSON: ${err.message}`) }
  return {
    ignore: Array.isArray(cfg.ignore) ? cfg.ignore.map(String) : [],
    tests: cfg.tests && typeof cfg.tests === 'object' ? Object.fromEntries(Object.entries(cfg.tests).map(([k, v]) => [k, String(v)])) : {},
    shellPatterns: [...DEFAULT_SHELL_PATTERNS, ...(Array.isArray(cfg.shellPatterns) ? cfg.shellPatterns.map(String) : [])],
    limits: { ...DEFAULTS.limits, ...cfg.limits },
    shellLimits: { ...DEFAULTS.shellLimits, ...cfg.shellLimits },
    retention: { ...DEFAULTS.retention, ...cfg.retention },
    testTimeoutSec: Number(cfg.testTimeoutSec) || DEFAULTS.testTimeoutSec,
  }
}

function globToRegExp(pattern) {
  let s = pattern.replace(/\\/g, '/').replace(/\/+$/, '')
  const anchored = s.includes('/')
  s = s.replace(/^\//, '')
  let re = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '*' && s[i + 1] === '*') {
      if (s[i + 2] === '/') { re += '(?:.*/)?'; i += 2 } else { re += '.*'; i += 1 }
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`${anchored ? '^' : '(^|/)'}${re}(/.*)?$`, IS_WIN ? 'i' : '')
}

class Project {
  constructor(rootArg) {
    const { root, isGit } = resolveRoot(rootArg)
    this.root = root
    this.isGit = isGit
    this.cfg = loadConfig(root)
    this.dir = path.join(storageHome(), 'projects', sha(caseKey(root)).slice(0, 16))
    this.snapDir = path.join(this.dir, 'snapshots')
    this.objDir = path.join(this.dir, 'objects')
    fs.mkdirSync(this.snapDir, { recursive: true })
    fs.mkdirSync(this.objDir, { recursive: true })
    const info = path.join(this.dir, 'project.json')
    if (!fs.existsSync(info)) atomicWrite(info, JSON.stringify({ root }))
    this.ignores = this.cfg.ignore.map(globToRegExp)
    const store = path.relative(root, real(storageHome()))
    this.storeRel = store && !store.startsWith('..') && !path.isAbsolute(store) ? posix(store) : null
  }

  // Why a workspace-relative path is never captured, or null when it may be.
  exclusion(rel, { walking = false } = {}) {
    const parts = rel.split('/')
    const base = parts[parts.length - 1]
    if (parts.includes('.git')) return 'git-internal'
    if (this.storeRel && (rel === this.storeRel || rel.startsWith(this.storeRel + '/'))) return 'zeit-storage'
    if (walking && parts.slice(0, -1).some(p => DEFAULT_DIRS.has(p))) return 'ignored-dir'
    if (!SECRET_ALLOWED.test(base) && SECRET_FILES.some(re => re.test(base))) return 'secret'
    if (this.ignores.some(re => re.test(rel))) return 'ignored'
    return null
  }

  toRel(p) {
    const abs = realLoose(path.resolve(this.root, p))
    const rel = path.relative(this.root, abs)
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null
    return posix(rel)
  }

  abs(rel) { return path.join(this.root, ...rel.split('/')) }

  // ----- objects -----
  objPath(h) { return path.join(this.objDir, h.slice(0, 2), h.slice(2)) }
  putObject(buf) {
    const h = sha(buf)
    const file = this.objPath(h)
    if (!fs.existsSync(file)) atomicWrite(file, zlib.gzipSync(buf))
    return h
  }
  getObject(h) {
    const buf = zlib.gunzipSync(fs.readFileSync(this.objPath(h)))
    if (sha(buf) !== h) throw new ZeitError(`stored object ${h.slice(0, 12)} is corrupt`)
    return buf
  }

  // ----- manifests -----
  manifestPath(id) { return path.join(this.snapDir, `${id}.json`) }
  write(m) { atomicWrite(this.manifestPath(m.id), JSON.stringify(m)) }
  manifests() {
    const out = []
    for (const name of fs.readdirSync(this.snapDir)) {
      if (!name.endsWith('.json')) continue
      try { out.push(JSON.parse(fs.readFileSync(path.join(this.snapDir, name), 'utf8'))) } catch { /* half-written or foreign file */ }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt || (b.id < a.id ? -1 : 1))
  }
  resolve(ref) {
    if (!ref) throw new ZeitError('no checkpoint given')
    const all = this.manifests()
    if (ref === 'latest') {
      const m = all.find(x => x.kind !== 'undo')
      if (!m) throw new ZeitError('no checkpoints yet')
      return m
    }
    if (ref === 'undo') {
      const m = all.find(x => x.kind === 'undo')
      if (!m) throw new ZeitError('no rollback to undo')
      return m
    }
    const hits = all.filter(m => m.id === ref || m.id.endsWith(ref) || m.id.startsWith(ref))
    if (hits.length === 1) return hits[0]
    if (hits.length > 1) throw new ZeitError(`"${ref}" matches ${hits.length} checkpoints; give more characters`)
    throw new ZeitError(`no checkpoint "${ref}"`)
  }

  withLock(fn) {
    const file = path.join(this.dir, 'lock')
    const deadline = Date.now() + 30000
    for (;;) {
      try {
        fs.writeFileSync(file, String(process.pid), { flag: 'wx' })
        break
      } catch (err) {
        if (err.code !== 'EEXIST') throw err
        try { if (Date.now() - fs.statSync(file).mtimeMs > 120000) { fs.rmSync(file, { force: true }); continue } } catch { continue }
        if (Date.now() > deadline) throw new ZeitError('the checkpoint store is busy; try again')
        sleep(25)
      }
    }
    this.lockFile = file
    try { return fn() } finally { this.lockFile = null; fs.rmSync(file, { force: true }) }
  }
  touchLock() { if (this.lockFile) try { const t = new Date(); fs.utimesSync(this.lockFile, t, t) } catch { /* lost lock is re-taken by the next caller */ } }
}

// ---------- reading the workspace ----------

function currentState(p, rel) {
  try {
    const st = fs.lstatSync(p.abs(rel))
    if (!st.isFile()) return { kind: st.isDirectory() ? 'directory' : 'other' }
    return { h: sha(fs.readFileSync(p.abs(rel))), s: st.size }
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { h: null }
    throw err
  }
}

// Lists candidate workspace files (relative, posix): Git's tracked + untracked-unignored, or a walk.
function candidates(p) {
  if (p.isGit) {
    const r = git(p.root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    if (r.ok) return { walking: false, list: [...new Set(r.stdout.split('\0').filter(Boolean))].sort() }
  }
  const list = []
  const skippedLinks = []
  const stack = ['']
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try { entries = fs.readdirSync(dir ? p.abs(dir) : p.root, { withFileTypes: true }) } catch { continue }
    for (const ent of entries) {
      const rel = dir ? `${dir}/${ent.name}` : ent.name
      if (ent.isSymbolicLink()) { skippedLinks.push(rel); continue }
      if (ent.isDirectory()) {
        if (DEFAULT_DIRS.has(ent.name) || p.exclusion(rel) === 'ignored' || p.exclusion(rel) === 'zeit-storage') continue
        stack.push(rel)
      } else if (ent.isFile()) list.push(rel)
    }
  }
  return { walking: true, list: list.sort(), skippedLinks }
}

class Skips {
  constructor() { this.counts = {}; this.sample = [] }
  add(rel, reason) {
    this.counts[reason] = (this.counts[reason] ?? 0) + 1
    if (this.sample.length < 200) this.sample.push({ path: rel, reason })
  }
  get total() { return Object.values(this.counts).reduce((a, b) => a + b, 0) }
  toJSON() { return { counts: this.counts, sample: this.sample } }
}

// Hashes every capturable file of the workspace within limits. Stores contents when `store` is set.
function scanWorkspace(p, limits, { store = true } = {}) {
  const { walking, list, skippedLinks = [] } = candidates(p)
  const cacheFile = path.join(p.dir, 'statcache.json')
  const cache = readJson(cacheFile, {})
  const nextCache = {}
  const now = Date.now()
  const files = {}
  const skipped = new Skips()
  for (const rel of skippedLinks) skipped.add(rel, 'symlink')
  let total = 0
  let count = 0
  for (const rel of list) {
    const why = p.exclusion(rel, { walking })
    if (why) { if (why !== 'git-internal' && why !== 'zeit-storage') skipped.add(rel, why); continue }
    let st
    try { st = fs.lstatSync(p.abs(rel)) } catch { continue } // tracked but deleted: not part of the state
    if (st.isSymbolicLink()) { skipped.add(rel, 'symlink'); continue }
    if (!st.isFile()) continue
    if (st.size > limits.maxFileMB * MB) { skipped.add(rel, 'too-large'); continue }
    if (count >= limits.maxFiles || total + st.size > limits.maxTotalMB * MB) { skipped.add(rel, 'budget'); continue }
    // A cached hash is trusted only for files last modified well before it was taken (racy-git rule).
    const c = cache[rel]
    let h
    if (c && c[0] === st.size && c[1] === st.mtimeMs && st.mtimeMs < c[3] - 2000 && (!store || fs.existsSync(p.objPath(c[2])))) {
      h = c[2]
    } else {
      const buf = fs.readFileSync(p.abs(rel))
      h = store ? p.putObject(buf) : sha(buf)
    }
    nextCache[rel] = [st.size, st.mtimeMs, h, c && c[2] === h ? c[3] : now]
    files[rel] = { h, s: st.size }
    total += st.size
    count += 1
    if (count % 500 === 0) p.touchLock()
  }
  try { atomicWrite(cacheFile, JSON.stringify(nextCache)) } catch { /* cache is an optimisation */ }
  return { files, skipped, total }
}

// Captures the listed paths exactly as they are now, absent ones included.
function capturePaths(p, paths, existing = {}) {
  const files = {}
  const added = []
  const covered = []
  const skipped = []
  for (const given of paths) {
    const rel = p.toRel(given)
    if (rel === null) { skipped.push({ path: given, reason: 'outside-project' }); continue }
    if (existing[rel] || files[rel]) { covered.push(rel); continue }
    const why = p.exclusion(rel)
    if (why) { skipped.push({ path: rel, reason: why }); continue }
    let st
    try { st = fs.lstatSync(p.abs(rel)) } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err
      files[rel] = { h: null, s: 0 }
      added.push(rel)
      continue
    }
    if (st.isSymbolicLink()) { skipped.push({ path: rel, reason: 'symlink' }); continue }
    if (!st.isFile()) { skipped.push({ path: rel, reason: st.isDirectory() ? 'directory' : 'not-a-file' }); continue }
    if (st.size > p.cfg.limits.maxFileMB * MB) { skipped.push({ path: rel, reason: 'too-large' }); continue }
    files[rel] = { h: p.putObject(fs.readFileSync(p.abs(rel))), s: st.size }
    added.push(rel)
  }
  return { files, added, covered, skipped }
}

function summary(m) {
  const skippedCount = m.skipped ? Object.values(m.skipped.counts ?? {}).reduce((a, b) => a + b, 0) : 0
  return {
    id: m.id, short: shortOf(m.id), label: m.label, kind: m.kind, scope: m.scope,
    createdAt: m.createdAt, session: m.session ?? null, turn: m.turn ?? null,
    fileCount: Object.keys(m.files).length,
    bytes: Object.values(m.files).reduce((a, f) => a + (f.s ?? 0), 0),
    skippedCount, skipped: m.skipped?.counts ?? {},
    complete: isComplete(m), pinned: !!m.pinned, verified: m.verified ?? null,
    undoOf: m.undoOf ?? null, head: m.head ?? null, branch: m.branch ?? null,
  }
}

const isComplete = m => m.scope === 'full' && !m.skipped?.counts?.budget && !m.skipped?.counts?.['too-large'] && !m.skipped?.counts?.symlink

function gitHead(p) {
  if (!p.isGit) return {}
  const head = git(p.root, ['rev-parse', '--verify', '-q', 'HEAD'])
  const branch = git(p.root, ['symbolic-ref', '--short', '-q', 'HEAD'])
  return { head: head.ok ? head.stdout.trim() : null, branch: branch.ok ? branch.stdout.trim() : null }
}

function createFull(p, a, kind, limits) {
  const { files, skipped } = scanWorkspace(p, limits)
  const m = {
    v: 1, id: newId(), label: a.label ?? '', kind, scope: 'full', createdAt: Date.now(),
    root: p.root, session: a.session ?? null, files, skipped: skipped.toJSON(), pinned: false,
    ...gitHead(p),
  }
  p.write(m)
  return m
}

// ---------- restore planning ----------

// Restore plan for the whole checkpoint, or only `onlyPaths` when given.
function plan(p, m, onlyPaths = [], deleteNew = false) {
  let entries
  if (onlyPaths.length) {
    entries = onlyPaths.map(given => {
      const rel = p.toRel(given)
      if (rel === null || !m.files[rel]) throw new ZeitError(`${given} is not in checkpoint ${shortOf(m.id)}`)
      return [rel, m.files[rel]]
    })
    entries = [...new Map(entries)]
  } else entries = Object.entries(m.files)
  const actions = []
  let unchanged = 0
  for (const [rel, f] of entries.sort(([a], [b]) => (a < b ? -1 : 1))) {
    const cur = currentState(p, rel)
    if (cur.kind) { actions.push({ path: rel, action: 'blocked', reason: `now a ${cur.kind}`, from: null, to: f.h }); continue }
    if (cur.h === f.h) { unchanged += 1; continue }
    const action = f.h === null ? 'remove' : cur.h === null ? 'recreate' : 'overwrite'
    actions.push({ path: rel, action, from: cur.h, to: f.h })
  }
  if (deleteNew && !onlyPaths.length) {
    if (!isComplete(m)) throw new ZeitError('this checkpoint is not a complete workspace snapshot, so new files cannot be judged; restore without --delete-new')
    const { files } = scanWorkspace(p, { maxFiles: Infinity, maxFileMB: Infinity, maxTotalMB: Infinity }, { store: false })
    for (const rel of Object.keys(files).sort()) {
      if (!m.files[rel]) actions.push({ path: rel, action: 'remove', from: files[rel].h, to: null, isNew: true })
    }
  }
  const token = sha(JSON.stringify([m.id, actions.map(x => [x.path, x.action, x.from])])).slice(0, 12)
  const counts = {}
  for (const x of actions) counts[x.action] = (counts[x.action] ?? 0) + 1
  return { id: m.id, short: shortOf(m.id), label: m.label, paths: onlyPaths.length ? entries.map(([rel]) => rel) : null, actions, unchanged, counts, token }
}

function restore(p, m, a) {
  const pl = plan(p, m, a.path, !!a['delete-new'])
  if (!a.confirm) throw new ZeitError('restore needs the token from a preview (--confirm <token>)', { preview: pl })
  if (a.confirm !== pl.token) throw new ZeitError('the files changed since the preview; preview again', { preview: pl })
  const blocked = pl.actions.filter(x => x.action === 'blocked')
  if (blocked.length) throw new ZeitError(`cannot restore over ${blocked[0].path} (${blocked[0].reason})`, { preview: pl })
  if (!pl.actions.length) return { applied: [], undo: null, note: 'nothing to restore: the files already match' }

  // The undo point captures every path the restore will touch, absent ones included.
  const cap = capturePaths(p, pl.actions.map(x => p.abs(x.path)))
  if (cap.skipped.length) throw new ZeitError(`cannot save an undo point for ${cap.skipped[0].path} (${cap.skipped[0].reason}); nothing was changed`)
  const undo = {
    v: 1, id: newId(), label: `before restoring ${shortOf(m.id)}`, kind: 'undo', scope: 'paths',
    createdAt: Date.now(), root: p.root, session: a.session ?? null, files: cap.files,
    skipped: { counts: {}, sample: [] }, pinned: false, undoOf: m.id,
  }
  p.write(undo)

  const applied = []
  try {
    for (const x of pl.actions) {
      const file = p.abs(x.path)
      if (x.action === 'remove') fs.rmSync(file, { force: true })
      else atomicWrite(file, p.getObject(x.to))
      applied.push({ path: x.path, action: x.action })
    }
  } catch (err) {
    throw new ZeitError(`restore stopped at ${pl.actions[applied.length].path}: ${err.message}. Undo with /zeit-rollback ${shortOf(undo.id)}`, { applied, undo: summary(undo) })
  }
  return { applied, undo: summary(undo) }
}

// ---------- diffs ----------

function splitLines(text) {
  const lines = text.split('\n').map(l => l.replace(/\r$/, ''))
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function diffOps(a, b) {
  let s = 0
  while (s < a.length && s < b.length && a[s] === b[s]) s++
  let ea = a.length
  let eb = b.length
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb-- }
  const ops = a.slice(0, s).map(line => ({ t: ' ', line }))
  const n = ea - s
  const m = eb - s
  if (n * m <= 4e6) {
    // LCS table over the differing middle, walked from the front.
    const w = m + 1
    const L = new Uint32Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        L[i * w + j] = a[s + i] === b[s + j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < n || j < m) {
      if (i < n && j < m && a[s + i] === b[s + j]) { ops.push({ t: ' ', line: a[s + i] }); i++; j++ }
      else if (j < m && (i === n || L[i * w + j + 1] >= L[(i + 1) * w + j])) { ops.push({ t: '+', line: b[s + j] }); j++ }
      else { ops.push({ t: '-', line: a[s + i] }); i++ }
    }
  } else {
    for (let i = s; i < ea; i++) ops.push({ t: '-', line: a[i] })
    for (let j = s; j < eb; j++) ops.push({ t: '+', line: b[j] })
  }
  for (let i = ea; i < a.length; i++) ops.push({ t: ' ', line: a[i] })
  return ops
}

function unified(oldText, newText, name, ctx = 3) {
  const ops = diffOps(splitLines(oldText), splitLines(newText))
  if (!ops.some(o => o.t !== ' ')) return ''
  let ai = 0
  let bi = 0
  for (const o of ops) { o.a = ai; o.b = bi; if (o.t !== '+') ai++; if (o.t !== '-') bi++ }
  const out = [`--- a/${name} (checkpoint)`, `+++ b/${name} (now)`]
  let i = 0
  while (i < ops.length) {
    if (ops[i].t === ' ') { i++; continue }
    const start = Math.max(0, i - ctx)
    let end = i
    for (;;) {
      let j = end + 1
      while (j < ops.length && ops[j].t === ' ') j++
      if (j < ops.length && j - (end + 1) <= 2 * ctx) { end = j; continue }
      break
    }
    const stop = Math.min(ops.length, end + 1 + ctx)
    const hunk = ops.slice(start, stop)
    const oc = hunk.filter(o => o.t !== '+').length
    const nc = hunk.filter(o => o.t !== '-').length
    out.push(`@@ -${oc ? hunk[0].a + 1 : hunk[0].a},${oc} +${nc ? hunk[0].b + 1 : hunk[0].b},${nc} @@`)
    for (const o of hunk) out.push(o.t + o.line)
    i = stop
  }
  return out.join('\n')
}

const isBinary = buf => buf.subarray(0, 8000).includes(0)

function diffFor(p, m, rel, f) {
  const old = f.h ? p.getObject(f.h) : Buffer.alloc(0)
  const cur = currentState(p, rel)
  if (cur.kind) return { path: rel, note: `now a ${cur.kind}` }
  const now = cur.h ? fs.readFileSync(p.abs(rel)) : Buffer.alloc(0)
  const state = f.h === null ? 'added since' : cur.h === null ? 'deleted since' : 'modified since'
  if (isBinary(old) || isBinary(now)) return { path: rel, state, note: 'binary file differs' }
  const text = unified(old.toString('utf8'), now.toString('utf8'), rel)
  return { path: rel, state, diff: text, note: text ? undefined : 'differs only in line endings or the final newline' }
}

// ---------- retention ----------

function prune(p, a) {
  const r = { ...p.cfg.retention }
  for (const k of ['maxAgeDays', 'maxCount', 'maxMB']) if (a[k] !== undefined) r[k] = Number(a[k])
  const all = p.manifests()
  const lastVerified = all.find(m => m.verified)
  const keep = m => m.pinned || m === lastVerified
  const removed = new Set()
  const now = Date.now()
  for (const m of all) if (!keep(m) && now - m.createdAt > r.maxAgeDays * 86400000) removed.add(m)
  const left = () => all.filter(m => !removed.has(m))
  const unpinned = left().filter(m => !keep(m))
  for (const m of unpinned.slice(r.maxCount)) removed.add(m)

  // Size budget: drop the oldest unpinned snapshots until referenced objects fit.
  const sizes = new Map()
  for (const dir of fs.readdirSync(p.objDir)) {
    for (const name of fs.readdirSync(path.join(p.objDir, dir))) {
      if (name.startsWith('.')) continue
      sizes.set(dir + name, fs.statSync(path.join(p.objDir, dir, name)).size)
    }
  }
  const refs = new Map()
  const hashes = m => new Set(Object.values(m.files).map(f => f.h).filter(Boolean))
  for (const m of left()) for (const h of hashes(m)) refs.set(h, (refs.get(h) ?? 0) + 1)
  let total = [...refs.keys()].reduce((t, h) => t + (sizes.get(h) ?? 0), 0)
  for (const m of left().filter(x => !keep(x)).reverse()) {
    if (total <= r.maxMB * MB) break
    removed.add(m)
    for (const h of hashes(m)) {
      const n = refs.get(h) - 1
      if (n === 0) { refs.delete(h); total -= sizes.get(h) ?? 0 } else refs.set(h, n)
    }
  }
  for (const m of removed) fs.rmSync(p.manifestPath(m.id), { force: true })
  let freed = 0
  let objects = 0
  for (const [h, size] of sizes) {
    if (refs.has(h)) continue
    fs.rmSync(p.objPath(h), { force: true })
    freed += size
    objects += 1
  }
  return { removed: [...removed].map(summary), freedBytes: freed, objectsRemoved: objects, keptBytes: total, retention: r }
}

// ---------- verification ----------

function stateHash(files) {
  return sha(JSON.stringify(Object.keys(files).sort().map(k => [k, files[k].h])))
}

function compareToWorkspace(p, m) {
  const { files } = scanWorkspace(p, { maxFiles: Infinity, maxFileMB: Infinity, maxTotalMB: Infinity }, { store: false })
  const differ = []
  for (const rel of new Set([...Object.keys(files), ...Object.keys(m.files)])) {
    if (files[rel]?.h !== m.files[rel]?.h) differ.push(rel)
  }
  return { match: differ.length === 0, differ: differ.sort().slice(0, 20), differCount: differ.length }
}

// Runs a project test command through the shell; a timeout kills the whole process tree,
// since killing only the shell leaves the test process running and holding the workspace.
function runCommand(command, cwd, timeoutMs) {
  return new Promise(resolve => {
    const child = spawn(command, { shell: true, cwd, windowsHide: true, detached: !IS_WIN })
    let output = ''
    const keep = chunk => { output += chunk; if (output.length > 2 * MB) output = output.slice(-MB) }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      if (IS_WIN) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      else try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
    }, timeoutMs)
    child.on('error', err => { clearTimeout(timer); resolve({ exitCode: 1, output: `${output}\n${err.message}`, timedOut }) })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ exitCode: timedOut ? 1 : code ?? 1, output: timedOut ? `${output}\n(timed out after ${Math.round(timeoutMs / 1000)}s)` : output, timedOut })
    })
  })
}

async function runTests(p, a) {
  const names = Object.keys(p.cfg.tests)
  if (!names.length) throw new ZeitError('no test commands: add {"tests": {"unit": "npm test"}} to .zeit.json')
  const name = a.name ?? names[0]
  const command = p.cfg.tests[name]
  if (!command) throw new ZeitError(`no test command "${name}" in .zeit.json (have: ${names.join(', ')})`)

  const m = a.snapshot ? p.resolve(a.snapshot) : p.withLock(() => createFull(p, { ...a, label: a.label ?? `test: ${name}` }, 'test', p.cfg.limits))
  let reason = null
  if (!isComplete(m)) reason = 'the checkpoint is not a complete workspace snapshot'
  const before = reason ? null : compareToWorkspace(p, m)
  if (before && !before.match) reason = `the workspace differs from the checkpoint (${before.differ.slice(0, 3).join(', ')})`

  const started = Date.now()
  const run = await runCommand(command, p.root, (Number(a.timeout) || p.cfg.testTimeoutSec) * 1000)
  const durationMs = Date.now() - started
  const exitCode = run.exitCode
  const passed = exitCode === 0 && !run.timedOut
  const after = reason ? null : compareToWorkspace(p, m)
  if (!reason && !after.match) reason = `the test run changed files (${after.differ.slice(0, 3).join(', ')})`
  const verified = passed && reason === null
  const output = run.output

  const record = { name, command, at: Date.now(), exitCode, durationMs, passed, verified, reason, stateHash: stateHash(m.files) }
  const saved = p.withLock(() => {
    const fresh = readJson(p.manifestPath(m.id), m)
    fresh.tests = [...(fresh.tests ?? []), record].slice(-10)
    if (verified) fresh.verified = { name, command, at: record.at, stateHash: record.stateHash }
    p.write(fresh)
    return fresh
  })

  let rollback = null
  if (!passed) {
    const good = p.manifests().find(x => x.verified && x.id !== m.id)
    if (good) rollback = { checkpoint: summary(good), preview: plan(p, good) }
  }
  return { name, command, passed, verified, reason, exitCode, durationMs, output: output.slice(-4000), checkpoint: summary(saved), rollback }
}

// ---------- fork & export ----------

function fork(p, m, a) {
  if (!p.isGit) throw new ZeitError('forking needs a Git repository')
  if (!isComplete(m)) throw new ZeitError('only a complete workspace snapshot can be forked')
  const dest = path.resolve(a.dest ?? path.join(path.dirname(p.root), `${path.basename(p.root)}-zeit-${shortOf(m.id)}`))
  if (fs.existsSync(dest) && fs.readdirSync(dest).length) throw new ZeitError(`${dest} already exists and is not empty`)
  const branch = a.branch ?? `zeit/${shortOf(m.id)}`
  const base = m.head ?? 'HEAD'
  const add = git(p.root, ['worktree', 'add', '-b', branch, dest, base])
  if (!add.ok) throw new ZeitError(`git worktree add failed: ${add.stderr.trim()}`)
  const destRoot = real(dest)
  const tracked = git(destRoot, ['ls-files', '-z']).stdout.split('\0').filter(Boolean)
  const removed = []
  for (const rel of tracked) {
    if (m.files[rel] || p.exclusion(rel)) continue
    fs.rmSync(path.join(destRoot, ...rel.split('/')), { force: true })
    removed.push(rel)
  }
  let written = 0
  for (const [rel, f] of Object.entries(m.files)) {
    if (!f.h) continue
    atomicWrite(path.join(destRoot, ...rel.split('/')), p.getObject(f.h))
    written += 1
  }
  return { short: shortOf(m.id), dest: destRoot, branch, base, written, removed }
}

let crcTable
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0
  crcTable ??= Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function zip(entries) {
  if (entries.length > 0xffff) throw new ZeitError('too many files for a zip export')
  const d = new Date()
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  const parts = []
  const central = []
  let offset = 0
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const deflated = zlib.deflateRawSync(data)
    const stored = deflated.length >= data.length
    const body = stored ? data : deflated
    const crc = crc32(data)
    if (offset > 0xffffffff - body.length - 1024) throw new ZeitError('export is too large for a zip file')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(stored ? 0 : 8, 8); local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28)
    parts.push(local, nameBuf, body)
    const head = Buffer.alloc(46)
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(0x0800, 8)
    head.writeUInt16LE(stored ? 0 : 8, 10); head.writeUInt16LE(time, 12); head.writeUInt16LE(date, 14)
    head.writeUInt32LE(crc, 16); head.writeUInt32LE(body.length, 20); head.writeUInt32LE(data.length, 24)
    head.writeUInt16LE(nameBuf.length, 28); head.writeUInt32LE(offset, 42)
    central.push(head, nameBuf)
    offset += 30 + nameBuf.length + body.length
  }
  const dir = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, dir, end])
}

function exportZip(p, m, a) {
  const out = path.resolve(a.out ?? path.join(storageHome(), 'exports', `${path.basename(p.root)}-${m.id}.zip`))
  if (fs.existsSync(out) && !a.force) throw new ZeitError(`${out} already exists`)
  const rels = Object.keys(m.files).filter(rel => m.files[rel].h).sort()
  const entries = rels.map(rel => ({ name: `files/${rel}`, data: p.getObject(m.files[rel].h) }))
  const { root, ...meta } = m
  entries.push({ name: 'zeit-manifest.json', data: Buffer.from(JSON.stringify({ ...meta, project: path.basename(root) }, null, 2)) })
  atomicWrite(out, zip(entries))
  return { short: shortOf(m.id), out, files: rels.length, bytes: fs.statSync(out).size }
}

// ---------- commands ----------

const BOOLEAN = new Set(['delete-new', 'force', 'all', 'bounded', 'verbose'])
function parseArgs(argv) {
  const a = { _: [], path: [] }
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (!t.startsWith('--')) { a._.push(t); continue }
    const key = t.slice(2)
    if (BOOLEAN.has(key)) { a[key] = true; continue }
    const value = argv[++i]
    if (value === undefined) throw new ZeitError(`--${key} needs a value`)
    if (key === 'path') a.path.push(value)
    else a[key] = value
  }
  return a
}

const COMMANDS = {
  snapshot(p, a) {
    const bounded = !!a.bounded
    return p.withLock(() => {
      if (a.path.length) {
        const cap = capturePaths(p, a.path)
        const m = { v: 1, id: newId(), label: a.label ?? '', kind: a.kind ?? 'manual', scope: 'paths', createdAt: Date.now(), root: p.root, session: a.session ?? null, files: cap.files, skipped: { counts: {}, sample: cap.skipped }, pinned: false }
        for (const s of cap.skipped) m.skipped.counts[s.reason] = (m.skipped.counts[s.reason] ?? 0) + 1
        p.write(m)
        return { checkpoint: summary(m) }
      }
      const m = createFull(p, a, a.kind ?? 'manual', bounded ? p.cfg.shellLimits : p.cfg.limits)
      return { checkpoint: summary(m), skippedSample: m.skipped.sample.slice(0, 20) }
    })
  },

  // First-touch capture: adds paths to the turn's snapshot unless the turn already holds them.
  capture(p, a) {
    if (!a.turn || !a.path.length) throw new ZeitError('capture needs --turn and --path')
    return p.withLock(() => {
      const index = readJson(path.join(p.dir, 'turns.json'), {})
      let m = index[a.turn] ? readJson(p.manifestPath(index[a.turn]), null) : null
      const isNew = !m
      m ??= { v: 1, id: newId(), label: a.label ?? 'before edits', kind: 'auto', scope: 'paths', createdAt: Date.now(), root: p.root, session: a.session ?? null, turn: a.turn, files: {}, skipped: { counts: {}, sample: [] }, pinned: false }
      const cap = capturePaths(p, a.path, m.files)
      Object.assign(m.files, cap.files)
      for (const s of cap.skipped) {
        if (m.skipped.sample.some(x => x.path === s.path)) continue
        m.skipped.counts[s.reason] = (m.skipped.counts[s.reason] ?? 0) + 1
        m.skipped.sample.push(s)
      }
      if (Object.keys(m.files).length || m.skipped.sample.length) {
        p.write(m)
        index[a.turn] = m.id
        const keys = Object.keys(index)
        for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete index[k]
        atomicWrite(path.join(p.dir, 'turns.json'), JSON.stringify(index))
      }
      return { checkpoint: summary(m), isNew, added: cap.added, covered: cap.covered, skipped: cap.skipped }
    })
  },

  // Undoes a capture whose tool call was refused or failed, when the file is still as captured.
  release(p, a) {
    if (!a.turn || !a.path.length) throw new ZeitError('release needs --turn and --path')
    return p.withLock(() => {
      const index = readJson(path.join(p.dir, 'turns.json'), {})
      const m = index[a.turn] ? readJson(p.manifestPath(index[a.turn]), null) : null
      if (!m) return { released: [] }
      const released = []
      for (const given of a.path) {
        const rel = p.toRel(given)
        if (rel === null || !m.files[rel]) continue
        if (currentState(p, rel).h !== m.files[rel].h) continue
        delete m.files[rel]
        released.push(rel)
      }
      if (!Object.keys(m.files).length && !m.skipped.sample.length) {
        fs.rmSync(p.manifestPath(m.id), { force: true })
        delete index[a.turn]
        atomicWrite(path.join(p.dir, 'turns.json'), JSON.stringify(index))
        return { released, dropped: m.id }
      }
      p.write(m)
      return { released, checkpoint: summary(m) }
    })
  },

  drop(p, a) {
    const m = p.resolve(a._[0])
    if (m.pinned && !a.force) throw new ZeitError(`${shortOf(m.id)} is pinned; unpin it first`)
    p.withLock(() => fs.rmSync(p.manifestPath(m.id), { force: true }))
    return { dropped: m.id }
  },

  list(p, a) {
    const all = p.manifests()
    const limit = a.limit ? Number(a.limit) : 50
    return { root: p.root, isGit: p.isGit, total: all.length, checkpoints: all.slice(0, limit).map(summary) }
  },

  projects() {
    const dir = path.join(storageHome(), 'projects')
    const out = []
    for (const key of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      const info = readJson(path.join(dir, key, 'project.json'), null)
      const snaps = fs.existsSync(path.join(dir, key, 'snapshots')) ? fs.readdirSync(path.join(dir, key, 'snapshots')).filter(n => n.endsWith('.json')).length : 0
      if (info) out.push({ root: info.root, checkpoints: snaps })
    }
    return { projects: out }
  },

  show(p, a) {
    const m = p.resolve(a._[0])
    return { checkpoint: summary(m), files: Object.keys(m.files).sort().map(rel => ({ path: rel, size: m.files[rel].s, absent: m.files[rel].h === null })), skippedSample: m.skipped?.sample ?? [], tests: m.tests ?? [] }
  },

  diff(p, a) {
    const m = p.resolve(a._[0])
    const pl = plan(p, m, a.path, false)
    const diffs = pl.actions.filter(x => x.action !== 'blocked').map(x => diffFor(p, m, x.path, m.files[x.path]))
    return { id: m.id, short: shortOf(m.id), unchanged: pl.unchanged, diffs }
  },

  preview(p, a) {
    const m = p.resolve(a._[0])
    return { preview: plan(p, m, a.path, !!a['delete-new']) }
  },

  restore(p, a) {
    const m = p.resolve(a._[0])
    return p.withLock(() => restore(p, m, a))
  },

  pin(p, a) { return setPin(p, a, true) },
  unpin(p, a) { return setPin(p, a, false) },

  prune(p, a) { return p.withLock(() => prune(p, a)) },

  config(p) {
    const { root, isGit, cfg } = p
    return { root, isGit, storage: p.dir, tests: cfg.tests, testTimeoutSec: cfg.testTimeoutSec, shellPatterns: cfg.shellPatterns, retention: cfg.retention, limits: cfg.limits, shellLimits: cfg.shellLimits }
  },

  test(p, a) { return runTests(p, a) },

  fork(p, a) { return fork(p, p.resolve(a._[0]), a) },

  export(p, a) { return exportZip(p, p.resolve(a._[0]), a) },
}

function setPin(p, a, value) {
  const m = p.resolve(a._[0])
  return p.withLock(() => {
    const fresh = readJson(p.manifestPath(m.id), m)
    fresh.pinned = value
    p.write(fresh)
    return { checkpoint: summary(fresh) }
  })
}

async function main() {
  const [name, ...rest] = process.argv.slice(2)
  try {
    const fn = COMMANDS[name]
    if (!fn) throw new ZeitError(`unknown command "${name ?? ''}" (commands: ${Object.keys(COMMANDS).join(', ')})`)
    const a = parseArgs(rest)
    const p = name === 'projects' ? null : new Project(a.root)
    process.stdout.write(JSON.stringify({ ok: true, ...(await fn(p, a)) }) + '\n')
  } catch (err) {
    const known = err instanceof ZeitError
    process.stdout.write(JSON.stringify({ ok: false, error: known ? err.message : `${err.code ?? err.name}: ${err.message}`, ...(known ? err.extra : {}) }) + '\n')
    process.exitCode = 1
  }
}

main()
