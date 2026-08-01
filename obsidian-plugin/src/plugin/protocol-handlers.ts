import { Notice, type Plugin } from "obsidian"
import { type MeridianUiHost, PairingJoinModal, SetupLinkModal } from "../ui/views"
import { hasConfiguredMeridianIdentity, parsePairingLinkParameters } from "./pairing-link"

export function registerProtocolHandlers(plugin: Plugin, host: MeridianUiHost): void {
  const handleSetupLink = (parameters: Record<string, string>) => {
    if (hasConfiguredMeridianIdentity(host.settings)) {
      new Notice("Meridian is already set up and connected in this vault.", 8_000)
      return
    }
    const endpoint = parameters.endpoint
    const setupSession = parameters.session
    const claimChallenge = parameters.challenge
    if (!endpoint || !setupSession || !claimChallenge) {
      new Notice("The Meridian setup link is incomplete", 8_000)
      return
    }
    const requestedLogFormat = parameters.logFormat
    const logFormat =
      requestedLogFormat === undefined
        ? "legacy-http-v1"
        : requestedLogFormat === "canonical-cbor-v1"
          ? requestedLogFormat
          : null
    if (logFormat === null) {
      new Notice("Update Meridian to use this setup link", 8_000)
      return
    }
    new SetupLinkModal(host, endpoint, setupSession, claimChallenge, logFormat).open()
  }

  plugin.registerObsidianProtocolHandler("meridian", handleSetupLink)
  plugin.registerObsidianProtocolHandler("meridian-pair", (parameters) => {
    if (hasConfiguredMeridianIdentity(host.settings)) {
      new Notice("Meridian is already set up and connected in this vault.", 8_000)
      return
    }
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
