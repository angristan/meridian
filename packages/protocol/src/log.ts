import { bytesEqual, type Hash, type VaultId } from "./bytes.js"
import { encodeCanonical } from "./canonical-cbor.js"
import { Domain, MAX_SAFE_CURSOR } from "./constants.js"
import type { SignedOperation } from "./models.js"
import { operationBodyToCbor } from "./operation.js"

export function logEntryHashInput(
  vaultId: VaultId,
  cursor: number,
  previousHash: Hash,
  operation: SignedOperation,
): Uint8Array {
  if (!Number.isSafeInteger(cursor) || cursor < 1 || cursor > MAX_SAFE_CURSOR) {
    throw new RangeError("Log cursor must be a positive safe integer")
  }
  return encodeCanonical({
    domain: Domain.LogEntry,
    vaultId,
    cursor,
    previousHash,
    operation: {
      body: operationBodyToCbor(operation.body),
      signature: operation.signature,
    },
  })
}

export interface PersistedHighWaterMark {
  readonly cursor: number
  readonly logHash: Hash
  readonly protocolGeneration: number
}

export class RollbackDetectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RollbackDetectedError"
  }
}

/** Checks a server head against state persisted before the previous acknowledgement. */
export function assertConsistentHighWaterMark(
  persisted: PersistedHighWaterMark,
  observed: PersistedHighWaterMark,
): void {
  if (observed.protocolGeneration < persisted.protocolGeneration) {
    throw new RollbackDetectedError("Server advertised an older protocol generation")
  }
  if (observed.cursor < persisted.cursor) {
    throw new RollbackDetectedError("Server log cursor moved backwards")
  }
  if (observed.cursor === persisted.cursor && !bytesEqual(observed.logHash, persisted.logHash)) {
    throw new RollbackDetectedError("Server log hash forked at the trusted cursor")
  }
}
