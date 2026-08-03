import { checkpointLogFormats, LogFormat as LogFormats, ZERO_HASH } from "@meridian/protocol"
import type { LogFormat, TrustedCheckpoint } from "../model"
import { toBase64Url } from "../platform/bytes"

export const INITIAL_LOG_HASH = toBase64Url(ZERO_HASH)
export const LEGACY_LOG_FORMAT = LogFormats.LegacyHttpV1

export function checkpointFormats(
  checkpoint: Pick<TrustedCheckpoint, "initialLogFormat" | "logFormat">,
): { initialLogFormat: LogFormat; logFormat: LogFormat } {
  return checkpointLogFormats(checkpoint)
}

export function initialCheckpoint(logFormat: LogFormat = LEGACY_LOG_FORMAT): TrustedCheckpoint {
  return {
    cursor: 0,
    logHash: INITIAL_LOG_HASH,
    initialLogFormat: logFormat,
    logFormat,
  }
}
