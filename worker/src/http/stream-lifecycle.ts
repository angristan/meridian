export type StreamOutcome = "completed" | "cancelled" | "failed"

export function observeStreamOutcome<T>(
  source: ReadableStream<T>,
  onOutcome: (outcome: StreamOutcome) => void,
): ReadableStream<T> {
  const reader = source.getReader()
  let outcome: StreamOutcome | undefined
  let released = false

  const releaseReader = () => {
    if (released) return
    released = true
    reader.releaseLock()
  }

  const finish = (nextOutcome: StreamOutcome) => {
    if (outcome !== undefined) return
    outcome = nextOutcome
    onOutcome(nextOutcome)
  }

  return new ReadableStream<T>({
    async pull(controller) {
      try {
        const result = await reader.read()
        if (outcome !== undefined) return

        if (result.done) {
          finish("completed")
          releaseReader()
          controller.close()
          return
        }

        controller.enqueue(result.value)
      } catch (error) {
        if (outcome !== undefined) return
        finish("failed")
        releaseReader()
        controller.error(error)
      }
    },

    async cancel(reason) {
      finish("cancelled")
      try {
        await reader.cancel(reason)
      } finally {
        releaseReader()
      }
    },
  })
}
