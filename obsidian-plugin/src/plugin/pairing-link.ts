import type { PairingCapability } from "../model"

export interface PairingLinkParameters {
  readonly endpoint: string
  readonly pairingId: string
  readonly capability: string
  readonly vaultId: string
  readonly expiresAt: number
}

export function createPairingDeepLink(endpoint: string, pairing: PairingCapability): string {
  const query = new URLSearchParams({
    endpoint,
    pairing: pairing.pairingId,
    capability: pairing.capability,
    vaultId: pairing.vaultId,
    expires: String(pairing.expiresAt),
  })
  return `obsidian://meridian-pair?${query.toString()}`
}

export function parsePairingLinkParameters(
  parameters: Record<string, string>,
): PairingLinkParameters | null {
  const endpoint = parameters.endpoint
  const pairingId = parameters.pairing
  const capability = parameters.capability
  const vaultId = parameters.vaultId
  const expiresAt = Number(parameters.expires)
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
