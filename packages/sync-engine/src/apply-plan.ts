import type { MaterializedEntry } from "./materialize"
import { bytesEqual, type CursorOperation, compareIds } from "./model"

export interface LocalSnapshot {
  readonly cursor: number
  readonly files: ReadonlyMap<string, Uint8Array>
  /** Paths previously written by Meridian. Unmanaged user files are never removed. */
  readonly managedPaths: ReadonlySet<string>
}

export interface StageStep {
  readonly id: string
  readonly type: "stage"
  readonly path: string
  readonly temporaryPath: string
  readonly content: Uint8Array
}

export interface CommitStep {
  readonly id: string
  readonly type: "commit"
  readonly path: string
  readonly temporaryPath: string
  readonly content: Uint8Array
}

export interface RemoveStep {
  readonly id: string
  readonly type: "remove"
  readonly path: string
}

export interface CheckpointStep {
  readonly id: string
  readonly type: "checkpoint"
  readonly cursor: number
  readonly managedPaths: readonly string[]
}

export type ApplicationStep = StageStep | CommitStep | RemoveStep | CheckpointStep

export interface ApplicationPlan {
  readonly id: string
  readonly cursor: number
  readonly operationId: string
  readonly steps: readonly ApplicationStep[]
}

function stepKey(cursor: number, operationId: string, path: string): string {
  return `${cursor}:${encodeURIComponent(operationId)}:${encodeURIComponent(path)}`
}

/** Creates a stable write-before-delete plan. The cursor checkpoint is always last. */
export function planApplication(
  local: LocalSnapshot,
  desiredEntries: readonly MaterializedEntry[],
  operation: CursorOperation,
): ApplicationPlan {
  if (operation.cursor !== local.cursor + 1) {
    throw new Error(`Expected cursor ${local.cursor + 1}, received ${operation.cursor}`)
  }
  const desired = new Map<string, MaterializedEntry>()
  for (const entry of desiredEntries) {
    if (desired.has(entry.path)) throw new Error(`Duplicate materialized path ${entry.path}`)
    desired.set(entry.path, entry)
  }

  const stages: StageStep[] = []
  const commits: CommitStep[] = []
  let ordinal = 0
  for (const [path, entry] of [...desired.entries()].sort(([left], [right]) =>
    compareIds(left, right),
  )) {
    const current = local.files.get(path)
    if (current !== undefined && bytesEqual(current, entry.content)) continue
    const key = stepKey(operation.cursor, operation.operationId, path)
    const temporaryPath = `.meridian/tmp/${operation.cursor}-${ordinal}`
    stages.push({
      id: `${key}:stage`,
      type: "stage",
      path,
      temporaryPath,
      content: new Uint8Array(entry.content),
    })
    commits.push({
      id: `${key}:commit`,
      type: "commit",
      path,
      temporaryPath,
      content: new Uint8Array(entry.content),
    })
    ordinal += 1
  }

  const removals: RemoveStep[] = [...local.managedPaths]
    .filter((path) => !desired.has(path))
    .sort(compareIds)
    .map((path) => ({
      id: `${stepKey(operation.cursor, operation.operationId, path)}:remove`,
      type: "remove",
      path,
    }))
  const managedPaths = [...desired.keys()].sort(compareIds)
  const checkpoint: CheckpointStep = {
    id: `${operation.cursor}:${encodeURIComponent(operation.operationId)}:checkpoint`,
    type: "checkpoint",
    cursor: operation.cursor,
    managedPaths,
  }
  return {
    id: `${operation.cursor}:${encodeURIComponent(operation.operationId)}`,
    cursor: operation.cursor,
    operationId: operation.operationId,
    steps: [...stages, ...commits, ...removals, checkpoint],
  }
}

export interface ApplicationJournalSnapshot {
  readonly plan: ApplicationPlan
  readonly completedStepIds: readonly string[]
}

export class ApplicationJournal {
  readonly plan: ApplicationPlan
  readonly #completed = new Set<string>()

  constructor(plan: ApplicationPlan, completedStepIds: readonly string[] = []) {
    this.plan = plan
    for (const id of completedStepIds) {
      if (!plan.steps.some((step) => step.id === id))
        throw new Error(`Unknown completed step ${id}`)
      this.#completed.add(id)
    }
  }

  next(): ApplicationStep | undefined {
    return this.plan.steps.find((step) => !this.#completed.has(step.id))
  }

  complete(stepId: string): void {
    const next = this.next()
    if (next?.id !== stepId) throw new Error(`Step ${stepId} completed out of order`)
    this.#completed.add(stepId)
  }

  get done(): boolean {
    return this.next() === undefined
  }

  snapshot(): ApplicationJournalSnapshot {
    return { plan: this.plan, completedStepIds: [...this.#completed] }
  }
}

/** In-memory filesystem model used by adapters and crash simulation. */
export class LocalReplica {
  cursor: number
  readonly files = new Map<string, Uint8Array>()
  readonly temporaryFiles = new Map<string, Uint8Array>()
  readonly managedPaths = new Set<string>()

  constructor(snapshot?: LocalSnapshot) {
    this.cursor = snapshot?.cursor ?? 0
    for (const [path, content] of snapshot?.files ?? []) {
      this.files.set(path, new Uint8Array(content))
    }
    for (const path of snapshot?.managedPaths ?? []) this.managedPaths.add(path)
  }

  snapshot(): LocalSnapshot {
    return {
      cursor: this.cursor,
      files: new Map([...this.files].map(([path, content]) => [path, new Uint8Array(content)])),
      managedPaths: new Set(this.managedPaths),
    }
  }

  /** Safe to repeat if a crash happened after the effect but before journal persistence. */
  execute(step: ApplicationStep): void {
    switch (step.type) {
      case "stage":
        this.temporaryFiles.set(step.temporaryPath, new Uint8Array(step.content))
        return
      case "commit": {
        const staged = this.temporaryFiles.get(step.temporaryPath)
        if (staged === undefined) {
          const committed = this.files.get(step.path)
          if (committed !== undefined && bytesEqual(committed, step.content)) return
          throw new Error(`Temporary content ${step.temporaryPath} is missing`)
        }
        if (!bytesEqual(staged, step.content)) throw new Error("Staged content does not match plan")
        this.files.set(step.path, new Uint8Array(staged))
        this.temporaryFiles.delete(step.temporaryPath)
        return
      }
      case "remove":
        this.files.delete(step.path)
        return
      case "checkpoint":
        if (this.cursor > step.cursor) throw new Error("Refusing to roll back local cursor")
        if (this.cursor < step.cursor - 1) throw new Error("Refusing to skip a local cursor")
        this.cursor = step.cursor
        this.managedPaths.clear()
        for (const path of step.managedPaths) this.managedPaths.add(path)
        return
    }
  }
}
