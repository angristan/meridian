import { type CursorOperation, copyRevision, operationEqual, type RevisionOperation } from "./model"

export interface CursorInboxSnapshot {
  readonly appliedCursor: number
  readonly accepted: readonly CursorOperation[]
  readonly buffered: readonly CursorOperation[]
}

function copyCursorOperation(operation: CursorOperation): CursorOperation {
  return {
    cursor: operation.cursor,
    operationId: operation.operationId,
    revision: copyRevision(operation.revision),
  }
}

function cursorOperationsEqual(left: CursorOperation, right: CursorOperation): boolean {
  return left.cursor === right.cursor && operationEqual(left, right)
}

/**
 * Buffers reordered delivery but exposes only the operation directly after the durable cursor.
 * The caller acknowledges it only after local application has committed.
 */
export class CursorInbox {
  #appliedCursor = 0
  readonly #accepted = new Map<number, CursorOperation>()
  readonly #buffered = new Map<number, CursorOperation>()

  constructor(snapshot?: CursorInboxSnapshot) {
    if (snapshot === undefined) return
    this.#appliedCursor = snapshot.appliedCursor
    for (const operation of snapshot.accepted)
      this.#accepted.set(operation.cursor, copyCursorOperation(operation))
    for (const operation of snapshot.buffered) this.receive(operation)
  }

  get appliedCursor(): number {
    return this.#appliedCursor
  }

  receive(operation: CursorOperation): "buffered" | "duplicate" {
    if (!Number.isSafeInteger(operation.cursor) || operation.cursor < 1) {
      throw new RangeError("Cursor must be a positive safe integer")
    }
    const normalized = copyCursorOperation(operation)
    const previous =
      operation.cursor <= this.#appliedCursor
        ? this.#accepted.get(operation.cursor)
        : this.#buffered.get(operation.cursor)
    if (previous !== undefined) {
      if (!cursorOperationsEqual(previous, normalized)) {
        throw new Error(`Cursor ${operation.cursor} equivocation detected`)
      }
      return "duplicate"
    }
    if (operation.cursor <= this.#appliedCursor) {
      throw new Error(`Unknown operation replayed below applied cursor ${this.#appliedCursor}`)
    }
    this.#buffered.set(operation.cursor, normalized)
    return "buffered"
  }

  next(): CursorOperation | undefined {
    const operation = this.#buffered.get(this.#appliedCursor + 1)
    return operation === undefined ? undefined : copyCursorOperation(operation)
  }

  acknowledge(operation: RevisionOperation): number {
    const cursor = this.#appliedCursor + 1
    const ready = this.#buffered.get(cursor)
    if (ready === undefined) throw new Error(`Cursor ${cursor} is not ready`)
    if (!operationEqual(ready, operation))
      throw new Error(`Cannot acknowledge a different operation`)
    this.#buffered.delete(cursor)
    this.#accepted.set(cursor, ready)
    this.#appliedCursor = cursor
    return cursor
  }

  snapshot(): CursorInboxSnapshot {
    return {
      appliedCursor: this.#appliedCursor,
      accepted: [...this.#accepted.values()]
        .sort((left, right) => left.cursor - right.cursor)
        .map(copyCursorOperation),
      buffered: [...this.#buffered.values()]
        .sort((left, right) => left.cursor - right.cursor)
        .map(copyCursorOperation),
    }
  }
}
