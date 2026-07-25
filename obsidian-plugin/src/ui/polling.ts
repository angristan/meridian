export interface PollUntilOptions<T> {
  readonly read: () => Promise<T>
  readonly isDone: (value: T) => boolean
  readonly expiresAt: number
  readonly signal: AbortSignal
  readonly onValue?: (value: T) => void
  readonly now?: () => number
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

export async function pollUntil<T>(options: PollUntilOptions<T>): Promise<T> {
  const now = options.now ?? Date.now
  const wait = options.wait ?? waitFor
  let attempt = 0

  while (true) {
    throwIfAborted(options.signal)
    if (now() >= options.expiresAt) throw new Error("Pairing request expired")

    const value = await options.read()
    options.onValue?.(value)
    if (options.isDone(value)) return value

    const remaining = options.expiresAt - now()
    if (remaining <= 0) throw new Error("Pairing request expired")
    await wait(Math.min(pairingPollDelay(attempt), remaining), options.signal)
    attempt += 1
  }
}

export function pairingPollDelay(attempt: number): number {
  if (attempt < 3) return 1_000
  if (attempt < 6) return 2_000
  return 3_000
}

export function isPollingCanceled(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Polling canceled", "AbortError")
}

function waitFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      signal.removeEventListener("abort", cancel)
      resolve()
    }, milliseconds)
    const cancel = () => {
      window.clearTimeout(timeout)
      reject(new DOMException("Polling canceled", "AbortError"))
    }
    signal.addEventListener("abort", cancel, { once: true })
  })
}
