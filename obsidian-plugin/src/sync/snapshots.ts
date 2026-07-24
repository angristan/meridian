import type { FileSnapshot } from "../model"
import { fingerprint } from "../platform/bytes"
import { isConfigPath } from "../vault/path-policy"

export async function snapshotFor(
  path: string,
  fileId: string,
  bytes: ArrayBuffer,
  configDir: string,
): Promise<FileSnapshot> {
  return {
    path,
    fileId,
    fingerprint: await fingerprint(bytes),
    size: bytes.byteLength,
    mtime: Date.now(),
    kind: isConfigPath(path, configDir) ? "config" : "vault",
  }
}
