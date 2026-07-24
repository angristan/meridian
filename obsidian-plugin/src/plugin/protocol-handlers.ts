import { Notice, type Plugin } from "obsidian"
import { type MeridianUiHost, PairingJoinModal, SetupLinkModal } from "../ui/views"

export function registerProtocolHandlers(plugin: Plugin, host: MeridianUiHost): void {
  const handleSetupLink = (parameters: Record<string, string>) => {
    const endpoint = parameters.endpoint
    const setupSession = parameters.session
    const claimChallenge = parameters.challenge
    if (!endpoint || !setupSession || !claimChallenge) {
      new Notice("The Meridian setup link is incomplete", 8_000)
      return
    }
    new SetupLinkModal(host, endpoint, setupSession, claimChallenge).open()
  }

  plugin.registerObsidianProtocolHandler("meridian", handleSetupLink)
  plugin.registerObsidianProtocolHandler("meridian-pair", (parameters) => {
    const endpoint = parameters.endpoint
    const pairingId = parameters.pairing
    const capability = parameters.capability
    const vaultId = parameters.vault
    const expiresAt = Number(parameters.expires)
    if (!endpoint || !pairingId || !capability || !vaultId || !Number.isSafeInteger(expiresAt)) {
      new Notice("The Meridian pairing link is incomplete", 8_000)
      return
    }
    new PairingJoinModal(host, endpoint, pairingId, capability, vaultId, expiresAt).open()
  })
}
