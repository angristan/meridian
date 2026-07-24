export class HttpError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = "HttpError"
    this.status = status
    this.code = code
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status, headers: { "cache-control": "no-store" } },
    )
  }

  console.error("Unhandled Meridian request failure", {
    error: error instanceof Error ? error.name : "unknown",
  })
  return Response.json(
    { error: { code: "internal_error", message: "The request could not be completed" } },
    { status: 500, headers: { "cache-control": "no-store" } },
  )
}

export function assert(condition: unknown, error: HttpError): asserts condition {
  if (!condition) throw error
}
