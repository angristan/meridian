import {
  type Hash,
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
