import { Effect, Schema } from "effect"
import { errorResponse, HttpError } from "../errors"

const MAX_JSON_BODY_BYTES = 512 * 1024

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
      try: () => request.text(),
      catch: () => new HttpError(400, "invalid_body", "Request body could not be read"),
    })
    if (new TextEncoder().encode(text).length > MAX_JSON_BODY_BYTES) {
      return yield* Effect.fail(new HttpError(413, "body_too_large", "JSON body is too large"))
    }

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

export async function runResponse(effect: Effect.Effect<Response, HttpError>): Promise<Response> {
  try {
    return await Effect.runPromise(effect)
  } catch (error) {
    return errorResponse(error)
  }
}
