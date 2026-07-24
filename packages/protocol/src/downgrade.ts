import type { EpochDeclarationBody } from "./models.js"

export interface DowngradeState {
  readonly highestProtocolGeneration: number
  readonly highestEpochSequence: number
}

export class DowngradeRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DowngradeRejectedError"
  }
}

/**
 * Applies only after the epoch signature and authorization chain have been verified.
 * The returned state must be durably persisted before accepting data in the epoch.
 */
export function acceptAuthorizedEpoch(
  state: DowngradeState,
  epoch: EpochDeclarationBody,
): DowngradeState {
  if (epoch.suite.protocolGeneration < state.highestProtocolGeneration) {
    throw new DowngradeRejectedError("Signed epoch attempts a protocol downgrade")
  }
  if (epoch.sequence < state.highestEpochSequence) {
    throw new DowngradeRejectedError("Signed epoch sequence moved backwards")
  }
  if (
    epoch.sequence === state.highestEpochSequence &&
    epoch.suite.protocolGeneration !== state.highestProtocolGeneration
  ) {
    throw new DowngradeRejectedError("One epoch sequence cannot select multiple protocol suites")
  }
  return {
    highestProtocolGeneration: Math.max(
      state.highestProtocolGeneration,
      epoch.suite.protocolGeneration,
    ),
    highestEpochSequence: Math.max(state.highestEpochSequence, epoch.sequence),
  }
}
