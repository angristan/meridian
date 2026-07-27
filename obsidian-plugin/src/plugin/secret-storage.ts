import type { SecretStorage } from "obsidian"

const PENDING_PAIRING_SECRET_PREFIX = "meridian-pending-pairing"
const PENDING_PAIRING_JOIN_PREFIX = "meridian-pending-pairing-join"
const PENDING_PAIRING_RESULT_PREFIX = "meridian-pending-pairing-result"
const PENDING_PAIRING_RELEASE_PREFIX = "meridian-pending-pairing-release"
const PENDING_PAIRING_COMPLETION_PREFIX = "meridian-pending-pairing-completion"

export class MeridianSecretStorage {
  constructor(private readonly storage: SecretStorage) {}

  setDeviceKeyBundle(deviceId: string, keyBundle: string): void {
    this.storage.setSecret(deviceSecretId(deviceId), keyBundle)
  }

  getDeviceKeyBundle(deviceId: string): string | null {
    return this.storage.getSecret(deviceSecretId(deviceId))
  }

  clearDeviceKeyBundle(deviceId: string): void {
    this.storage.setSecret(deviceSecretId(deviceId), "")
  }

  setPendingPairing(pairingId: string, secret: string): void {
    this.storage.setSecret(pairingSecretId(PENDING_PAIRING_SECRET_PREFIX, pairingId), secret)
  }

  getPendingPairing(pairingId: string): string | null {
    return this.storage.getSecret(pairingSecretId(PENDING_PAIRING_SECRET_PREFIX, pairingId))
  }

  setPendingPairingJoin(pairingId: string, join: string): void {
    this.storage.setSecret(pairingSecretId(PENDING_PAIRING_JOIN_PREFIX, pairingId), join)
  }

  getPendingPairingJoin(pairingId: string): string | null {
    return this.storage.getSecret(pairingSecretId(PENDING_PAIRING_JOIN_PREFIX, pairingId))
  }

  setPendingPairingResult(pairingId: string, result: string): void {
    this.storage.setSecret(pairingSecretId(PENDING_PAIRING_RESULT_PREFIX, pairingId), result)
  }

  getPendingPairingResult(pairingId: string): string | null {
    return this.storage.getSecret(pairingSecretId(PENDING_PAIRING_RESULT_PREFIX, pairingId))
  }

  setPendingPairingRelease(pairingId: string, release: string): void {
    this.storage.setSecret(pairingSecretId(PENDING_PAIRING_RELEASE_PREFIX, pairingId), release)
  }

  getPendingPairingRelease(pairingId: string): string | null {
    return this.storage.getSecret(pairingSecretId(PENDING_PAIRING_RELEASE_PREFIX, pairingId))
  }

  setPendingPairingCompletion(pairingId: string, completion: string): void {
    this.storage.setSecret(
      pairingSecretId(PENDING_PAIRING_COMPLETION_PREFIX, pairingId),
      completion,
    )
  }

  getPendingPairingCompletion(pairingId: string): string | null {
    return this.storage.getSecret(pairingSecretId(PENDING_PAIRING_COMPLETION_PREFIX, pairingId))
  }

  clearPendingPairing(pairingId: string): void {
    this.storage.setSecret(pairingSecretId(PENDING_PAIRING_SECRET_PREFIX, pairingId), "")
    this.storage.setSecret(pairingSecretId(PENDING_PAIRING_JOIN_PREFIX, pairingId), "")
    this.storage.setSecret(pairingSecretId(PENDING_PAIRING_RESULT_PREFIX, pairingId), "")
    this.storage.setSecret(pairingSecretId(PENDING_PAIRING_RELEASE_PREFIX, pairingId), "")
    this.storage.setSecret(pairingSecretId(PENDING_PAIRING_COMPLETION_PREFIX, pairingId), "")
  }
}

export function deviceSecretId(deviceId: string): string {
  const suffix = secretSuffix(deviceId, "Device ID")
  return `meridian-device-${suffix}`
}

function pairingSecretId(prefix: string, pairingId: string): string {
  return `${prefix}-${secretSuffix(pairingId, "Pairing ID")}`
}

function secretSuffix(value: string, label: string): string {
  const suffix = value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 40)
  if (!suffix) throw new Error(`${label} cannot be represented in SecretStorage`)
  return suffix
}
