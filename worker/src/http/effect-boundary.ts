import { Effect, Schema } from "effect"
import { errorResponse, HttpError } from "../errors"

const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024

export function decodeJsonEffect<S extends Schema.ConstraintDecoder<unknown, never>>(
  request: Request,
  schema: S,
) {
  return Effect.gen(function* () {
    const contentType = request.headers.get("content-type") ?? ""
    if (!contentType.toLowerCase().startsWith("application/json")) {
      return yield* Effect.fail(
        new HttpError(415, "unsupported_media_type", "Expected application/json"),
      )
    }

    const declaredLength = Number(request.headers.get("content-length") ?? "0")
    if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
      return yield* Effect.fail(new HttpError(413, "body_too_large", "JSON body is too large"))
    }

    const text = yield* Effect.tryPromise({
      try: () => readBoundedBody(request),
      catch: (error) =>
        error instanceof HttpError
          ? error
          : new HttpError(400, "invalid_body", "Request body could not be read"),
    })

    let input: unknown
    try {
      input = JSON.parse(text)
    } catch {
      return yield* Effect.fail(
        new HttpError(400, "invalid_json", "Request body is not valid JSON"),
      )
    }

    return yield* Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(input).pipe(
      Effect.mapError(
        () =>
          new HttpError(400, "invalid_request", "Request body does not match the protocol schema"),
      ),
    )
  })
}

async function readBoundedBody(request: Request): Promise<string> {
  if (!request.body) return ""

  const reader = request.body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  let totalBytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      totalBytes += chunk.value.byteLength
      if (totalBytes > MAX_JSON_BODY_BYTES) {
        await reader.cancel()
        throw new HttpError(413, "body_too_large", "JSON body is too large")
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

export async function runResponse(effect: Effect.Effect<Response, HttpError>): Promise<Response> {
  try {
    return await Effect.runPromise(effect)
  } catch (error) {
    return errorResponse(error)
  }
}
