// Disposable fixtures for the helper's acceptance tests: every test gets its own temp
// workspace and its own ZEIT_HOME, so nothing outside the OS temp dir is touched.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'zeit.mjs')

export function fixture({ git = false, files = {} } = {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'zeit-test-')))
  const root = path.join(base, 'work')
  const home = path.join(base, 'home')
  fs.mkdirSync(root)
  const f = {
    base, root, home,
    file: rel => path.join(root, ...rel.split('/')),
    write(rel, text) { fs.mkdirSync(path.dirname(this.file(rel)), { recursive: true }); fs.writeFileSync(this.file(rel), text) },
    read: rel => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8'),
    exists: rel => fs.existsSync(path.join(root, ...rel.split('/'))),
    rm: rel => fs.rmSync(path.join(root, ...rel.split('/')), { force: true, recursive: true }),
    git(...args) {
      const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
      return r.stdout
    },
    // Runs the helper the way the mod does: cwd is the workspace.
    zeit(...args) {
      const r = spawnSync(process.execPath, [HELPER, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, ZEIT_HOME: home } })
      const line = r.stdout.trim().split('\n').pop()
      try { return JSON.parse(line) } catch { throw new Error(`helper printed no JSON: ${r.stdout}\n${r.stderr}`) }
    },
    ok(...args) {
      const out = this.zeit(...args)
      if (!out.ok) throw new Error(`zeit ${args.join(' ')} failed: ${out.error}`)
      return out
    },
    cleanup() {
      try { spawnSync('git', ['-C', root, 'worktree', 'prune']) } catch { /* not a repo */ }
      fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 })
    },
  }
  for (const [rel, text] of Object.entries(files)) f.write(rel, text)
  if (git) {
    f.git('init', '-q', '-b', 'main')
    f.git('config', 'user.email', 'test@example.invalid')
    f.git('config', 'user.name', 'zeit test')
    f.git('config', 'core.autocrlf', 'false')
    f.git('add', '-A')
    f.git('commit', '-q', '-m', 'initial')
  }
  return f
}

// Lists every file under a directory, relative and posix, for "nothing was written here" checks.
export function tree(dir) {
  const out = []
  const walk = d => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      // .git is a folder in a repository and a file in a worktree.
      if (ent.name === '.git') continue
      const p = path.join(d, ent.name)
      if (ent.isDirectory()) walk(p)
      else out.push(path.relative(dir, p).split(path.sep).join('/'))
    }
  }
  walk(dir)
  return out.sort()
}
