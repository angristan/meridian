import { LogFormat, Permission } from "@meridian/protocol"
import type { DeviceKeyMaterial, RemoteOperation } from "../model"
import { toBase64Url } from "../platform/bytes"
import { verifyWorkerOperation } from "./worker-operation"

export async function verifyLogFormatUpgrade(
  device: DeviceKeyMaterial,
  operation: RemoteOperation,
): Promise<"canonical-cbor-v1"> {
  const verified = verifyWorkerOperation(device, operation, "log-format-transition")
  const { authorCertificate, signedOperation: transition } = verified
  if (!authorCertificate.body.permissions.includes(Permission.ManageDevices)) {
    throw new Error("Log format transition author is not a device manager")
  }
  const body = transition.body
  const previousHash = stringField(operation.envelope, "previousHash")
  if (
    body.previousCursor + 1 !== operation.cursor ||
    toBase64Url(body.previousLogHash) !== previousHash ||
    body.nextLogFormat !== LogFormat.CanonicalCborV1
  ) {
    throw new Error("Log format transition does not match the legacy log head")
  }
  return body.nextLogFormat
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Remote log format transition is invalid")
  }
  const result = (value as Record<string, unknown>)[field]
  if (typeof result !== "string" || result.length === 0) {
    throw new Error(`Remote log format transition is missing ${field}`)
  }
  return result
}
