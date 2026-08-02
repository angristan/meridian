import { ErrorResponseSchema } from "@meridian/protocol"
import { Schema } from "effect"
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
    const decoded = Schema.decodeUnknownSync(ErrorResponseSchema)(JSON.parse(text))
    return decoded.error.message === undefined
      ? null
      : { code: decoded.error.code, message: decoded.error.message }
  } catch {
    // Fall back to the stable status-based message for invalid error responses.
    return null
  }
}

export function parseJsonBody(response: HttpResponse, label: string): unknown {
  if (response.text.length === 0) throw new Error(`${label} returned an empty JSON response`)
  try {
    return JSON.parse(response.text)
  } catch {
    throw new Error(`${label} returned invalid JSON`)
  }
}

export function decodeResponse<S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  value: unknown,
  label: string,
): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema)(value)
  } catch {
    throw new Error(`${label} returned an invalid response`)
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
}
