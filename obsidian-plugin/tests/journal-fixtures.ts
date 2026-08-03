import type { FileSnapshot } from "../src/model"
import type { JournalPort } from "../src/storage/contracts"

export async function seedSnapshots(
  journal: Pick<JournalPort, "clearSnapshots" | "commitReconciliation">,
  snapshots: FileSnapshot[],
): Promise<void> {
  await journal.clearSnapshots()
  await journal.commitReconciliation({
    entries: [],
    putSnapshots: snapshots,
    removeSnapshotPaths: [],
    consumeDirtyPaths: [],
  })
}
