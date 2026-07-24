import type { SecretStorage } from "obsidian"

const PENDING_PAIRING_SECRET_ID = "meridian-pending-pairing"

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

  setPendingPairing(secret: string): void {
    this.storage.setSecret(PENDING_PAIRING_SECRET_ID, secret)
  }

  getPendingPairing(): string | null {
    return this.storage.getSecret(PENDING_PAIRING_SECRET_ID)
  }

  clearPendingPairing(): void {
    this.storage.setSecret(PENDING_PAIRING_SECRET_ID, "")
  }
}

export function deviceSecretId(deviceId: string): string {
  const suffix = deviceId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 40)
  if (!suffix) throw new Error("Device ID cannot be represented in SecretStorage")
  return `meridian-device-${suffix}`
}
