import type { MeridianSettings, PairingCapability } from "../model"

export function hasConfiguredMeridianIdentity(
  settings: Pick<MeridianSettings, "endpoint" | "vaultId" | "deviceId" | "pendingDeviceRemoval">,
): boolean {
  return Boolean(
    settings.endpoint || settings.vaultId || settings.deviceId || settings.pendingDeviceRemoval,
  )
}

export interface PairingLinkParameters {
  readonly endpoint: string
  readonly pairingId: string
  readonly capability: string
  readonly vaultId: string
  readonly expiresAt: number
}

export function createPairingDeepLink(endpoint: string, pairing: PairingCapability): string {
  const query = new URLSearchParams({
    meridianEndpoint: endpoint,
    meridianPairingId: pairing.pairingId,
    meridianCapability: pairing.capability,
    meridianVaultId: pairing.vaultId,
    meridianExpiresAt: String(pairing.expiresAt),
  })
  return `obsidian://meridian-pair?${query.toString()}`
}

export function parsePairingLinkParameters(
  parameters: Record<string, string>,
): PairingLinkParameters | null {
  const endpoint = parameters.meridianEndpoint
  const pairingId = parameters.meridianPairingId
  const capability = parameters.meridianCapability
  const vaultId = parameters.meridianVaultId
  const expiresAt = Number(parameters.meridianExpiresAt)
  if (
    !endpoint ||
    !pairingId ||
    !capability ||
    !vaultId ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= 0
  ) {
    return null
  }
  return { endpoint, pairingId, capability, vaultId, expiresAt }
}
