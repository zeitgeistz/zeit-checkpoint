// What bin/zeit.mjs reports about one checkpoint.
export type ZeitCheckpoint = {
  id: string
  short: string
  label: string
  kind: 'manual' | 'auto' | 'shell' | 'undo' | 'test'
  scope: 'full' | 'paths'
  createdAt: number
  session: string | null
  turn: string | null
  fileCount: number
  bytes: number
  skippedCount: number
  skipped: Record<string, number>
  complete: boolean
  pinned: boolean
  verified: { name: string; command: string; at: number; stateHash: string } | null
  undoOf: string | null
  head: string | null
  branch: string | null
}

export type ZeitAction = {
  path: string
  action: 'overwrite' | 'recreate' | 'remove' | 'blocked'
  reason?: string
  isNew?: boolean
}

export type ZeitPreview = {
  id: string
  short: string
  label: string
  paths: string[] | null
  actions: ZeitAction[]
  unchanged: number
  counts: Record<string, number>
  token: string
}

export type ZeitDiff = { path: string; state?: string; diff?: string; note?: string }

export type ZeitSkip = { path: string; reason: string }

// What automatic capture protected during the current turn, for the band.
export type ZeitCoverage = {
  turn: string | null
  checkpoint: string | null
  protected: string[]
  skipped: ZeitSkip[]
  failed: { path: string; error: string }[]
  shell: { short: string; files: number; skipped: number; command: string } | null
  shellFailed: string | null
  // A project test command that failed this turn, and the verified checkpoint offered back.
  testFailed: { command: string; verified: string | null } | null
}

export type ZeitConfig = {
  root: string
  isGit: boolean
  tests: Record<string, string>
  testTimeoutSec: number
  shellPatterns: string[]
}

// The timeline pane: the list it shows and what is open in it.
export type ZeitTimeline = {
  items: ZeitCheckpoint[]
  selected: string | null
  files: { path: string; size: number; absent: boolean }[]
  changed: ZeitAction[]
  diff: ZeitDiff[] | null
  preview: ZeitPreview | null
  deleteNew: boolean
  message: string | null
  isBusy: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'zeit-checkpoint': {
      last: ZeitCheckpoint | null
      error: string | null
      coverage: ZeitCoverage
      config: ZeitConfig | null
      turn: string | null
      timeline: ZeitTimeline
    }
  }
}
