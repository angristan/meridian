import type {
  PairingResult,
  PairingState,
  PairingStatus,
  RemoteDevice,
  RemoteOperation,
} from "../model"
import type { HttpResponse } from "./transport"

export class MeridianHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message)
    this.name = "MeridianHttpError"
  }
}

export function assertSuccess(response: HttpResponse, label: string): void {
  if (response.status >= 200 && response.status < 300) return
  const parsed = parseErrorBody(response.text)
  const detail =
    parsed?.message ??
    (response.status === 401 ? "Session expired or device unauthorized" : `HTTP ${response.status}`)
  throw new MeridianHttpError(response.status, parsed?.code ?? null, `${label} failed: ${detail}`)
}

function parseErrorBody(text: string): { code: string; message: string } | null {
  try {
    const value: unknown = JSON.parse(text)
    if (
      isRecord(value) &&
      isRecord(value.error) &&
      typeof value.error.code === "string" &&
      typeof value.error.message === "string"
    ) {
      return { code: value.error.code, message: value.error.message }
    }
  } catch {
    // Fall back to the stable status-based message.
  }
  return null
}

export function parseJsonBody(response: HttpResponse, label: string): unknown {
  if (response.text.length === 0) throw new Error(`${label} returned an empty JSON response`)
  try {
    return JSON.parse(response.text)
  } catch {
    throw new Error(`${label} returned invalid JSON`)
  }
}

export function parseDevice(value: unknown): RemoteDevice {
  if (!isRecord(value)) throw new Error("Server returned an invalid device")
  const role = value.role
  if (role !== "owner" && role !== "member") {
    throw new Error("Server returned an invalid device role")
  }
  return {
    deviceId: requiredString(value, "deviceId"),
    signingPublicKey: requiredString(value, "signingPublicKey"),
    hpkePublicKey: requiredString(value, "hpkePublicKey"),
    certificate: requiredString(value, "certificate"),
    role,
    authorizedAt: requiredNumber(value, "authorizedAt"),
    revokedAt: value.revokedAt === null ? null : requiredNumber(value, "revokedAt"),
    deviceName: typeof value.deviceName === "string" ? value.deviceName : null,
    platform: typeof value.platform === "string" ? value.platform : null,
    supportsCanonicalLog: value.supportsCanonicalLog === true,
    supportsEpochTransitions: value.supportsEpochTransitions === true,
  }
}

export function parsePairingStatus(value: unknown): PairingStatus {
  if (!isRecord(value)) throw new Error("Server returned an invalid pairing status")
  const status = pairingStatusValue(value.status)
  const result: PairingStatus = {
    pairingId: requiredString(value, "pairingId"),
    status,
    expiresAt: requiredNumber(value, "expiresAt"),
    ownerConfirmed: value.ownerConfirmed === true,
    candidateConfirmed: value.candidateConfirmed === true,
  }
  if (typeof value.requestedAt === "number") result.requestedAt = value.requestedAt
  if (isRecord(value.candidateConfirmation)) {
    result.candidateConfirmation = {
      transferHash: requiredString(value.candidateConfirmation, "transferHash"),
      proof: requiredString(value.candidateConfirmation, "proof"),
    }
  }
  if (isRecord(value.candidate)) {
    const candidate = {
      pairingId: requiredString(value.candidate, "pairingId"),
      vaultId: requiredString(value.candidate, "vaultId"),
      expiresAt: requiredNumber(value.candidate, "expiresAt"),
      deviceId: requiredString(value.candidate, "deviceId"),
      signingPublicKey: requiredString(value.candidate, "signingPublicKey"),
      hpkePublicKey: requiredString(value.candidate, "hpkePublicKey"),
      deviceName: requiredString(value.candidate, "deviceName"),
      platform: requiredString(value.candidate, "platform"),
      requestProof: requiredString(value.candidate, "requestProof"),
    }
    result.candidate = candidate
    result.candidatePackage = JSON.stringify(candidate)
  }
  return result
}

export function parsePairingResult(value: unknown): PairingResult {
  if (!isRecord(value)) throw new Error("Server returned an invalid pairing result")
  const status = pairingStatusValue(value.status)
  const result: PairingResult = {
    pairingId: requiredString(value, "pairingId"),
    status,
  }
  for (const key of [
    "deviceId",
    "certificate",
    "transcriptHash",
    "verificationPreview",
    "approvalSignature",
    "hpkeTransfer",
  ] as const) {
    if (typeof value[key] === "string") result[key] = value[key]
  }
  if (typeof value.verificationStartedAt === "number") {
    result.verificationStartedAt = value.verificationStartedAt
  }
  return result
}

function pairingStatusValue(value: unknown): PairingState {
  if (
    value !== "pending" &&
    value !== "joined" &&
    value !== "verifying" &&
    value !== "confirmed" &&
    value !== "released" &&
    value !== "completed" &&
    value !== "canceled"
  ) {
    throw new Error("Server returned an invalid pairing status")
  }
  return value
}

export function parseOperation(value: unknown): RemoteOperation {
  if (!isRecord(value)) throw new Error("Server returned an invalid operation")
  return {
    cursor: requiredNumber(value, "cursor"),
    logHash: requiredString(value, "chainHash"),
    envelope: value,
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function requiredString(value: unknown, key: string): string {
  if (!isRecord(value) || typeof value[key] !== "string" || value[key].length === 0) {
    throw new Error(`Server response is missing ${key}`)
  }
  return value[key]
}

export function requiredBoolean(value: unknown, key: string): boolean {
  if (!isRecord(value) || typeof value[key] !== "boolean") {
    throw new Error(`Server response is missing ${key}`)
  }
  return value[key]
}

export function requiredNumber(value: unknown, key: string): number {
  if (!isRecord(value)) throw new Error(`Server response is missing ${key}`)
  const parsed = optionalNumber(value[key])
  if (parsed === null) throw new Error(`Server response is missing ${key}`)
  return parsed
}

export function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
}
