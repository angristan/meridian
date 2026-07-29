import type {
  CryptoPort,
  DecryptedRevision,
  DeviceKeyMaterial,
  LocalRevision,
  RemotePort,
} from "../model"

export class RevisionLoader {
  constructor(
    private readonly remote: RemotePort,
    private readonly crypto: CryptoPort,
    private readonly maximumFileBytes: () => number,
  ) {}

  async load(device: DeviceKeyMaterial, recorded: LocalRevision): Promise<DecryptedRevision> {
    let operation = recorded.operation
    if (!operation) {
      if (recorded.cursor === null) throw new Error("The selected revision was never committed")
      const changes = await this.remote.getChanges(recorded.cursor - 1, null)
      operation =
        changes.operations.find((candidate) => candidate.cursor === recorded.cursor) ?? null
      if (!operation) throw new Error("The selected remote operation is no longer available")
    }

    const decrypted = await this.crypto.decryptRevision(
      device,
      operation,
      this.maximumFileBytes(),
      (blobId) => this.remote.getBlob(blobId),
    )
    if (decrypted.revisionId !== recorded.revisionId || decrypted.fileId !== recorded.fileId) {
      throw new Error("Recorded history does not match the authenticated remote operation")
    }
    return decrypted
  }
}
