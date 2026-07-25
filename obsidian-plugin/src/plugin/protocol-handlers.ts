import { Notice, type Plugin } from "obsidian"
import { type MeridianUiHost, PairingJoinModal, SetupLinkModal } from "../ui/views"
import { parsePairingLinkParameters } from "./pairing-link"

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
    const pairing = parsePairingLinkParameters(parameters)
    if (!pairing) {
      new Notice("The Meridian pairing link is incomplete", 8_000)
      return
    }
    new PairingJoinModal(
      host,
      pairing.endpoint,
      pairing.pairingId,
      pairing.capability,
      pairing.vaultId,
      pairing.expiresAt,
    ).open()
  })
}
