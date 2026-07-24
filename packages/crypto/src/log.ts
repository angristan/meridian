import {
  type Hash,
  hashBytes,
  logEntryHashInput,
  type SignedOperation,
  type VaultId,
} from "@meridian/protocol"
import { sha256 } from "./hash.js"

export async function computeLogEntryHash(
  vaultId: VaultId,
  cursor: number,
  previousHash: Hash,
  operation: SignedOperation,
): Promise<Hash> {
  return sha256(logEntryHashInput(vaultId, cursor, previousHash, operation))
}

export function initialLogHash(): Hash {
  return hashBytes(new Uint8Array(32))
}
