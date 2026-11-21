import { atom, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { ZeitCheckpoint, ZeitConfig, ZeitCoverage, ZeitTimeline } from '../types'
import { zeit } from './zeit'

export const EMPTY_COVERAGE: ZeitCoverage = { turn: null, checkpoint: null, protected: [], skipped: [], failed: [], shell: null, shellFailed: null, testFailed: null }
export const EMPTY_TIMELINE: ZeitTimeline = { items: [], selected: null, files: [], changed: [], diff: null, preview: null, deleteNew: false, message: null, isBusy: false }

// The engine lists a module's state by scanning each file, so every file that reads or
// writes a value declares its own atom for it (same reference, same initial value).
const last = atom({ plugin: 'zeit-checkpoint', key: 'last' } as const, null)
const error = atom({ plugin: 'zeit-checkpoint', key: 'error' } as const, null)
const config = atom({ plugin: 'zeit-checkpoint', key: 'config' } as const, null)

export async function refreshLast($: EngineInterface) {
  const r = await zeit($, ['list', '--limit', '1'], 15_000)
  if (r.ok) await update($, last, () => (r.checkpoints[0] as ZeitCheckpoint | undefined) ?? null)
  await update($, error, () => (r.ok ? null : r.error ?? 'unknown error'))
}

export async function loadConfig($: EngineInterface): Promise<ZeitConfig | null> {
  const r = await zeit($, ['config'], 15_000)
  if (!r.ok) {
    await update($, error, () => r.error ?? 'could not read the zeit config')
    return null
  }
  const cfg: ZeitConfig = { root: r.root, isGit: r.isGit, tests: r.tests, testTimeoutSec: r.testTimeoutSec ?? 540, shellPatterns: r.shellPatterns }
  await update($, config, () => cfg)
  return cfg
}
