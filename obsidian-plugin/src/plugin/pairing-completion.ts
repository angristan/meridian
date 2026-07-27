export async function confirmRemotePairingCompletion(options: {
  complete: () => Promise<void>
  isDeviceAuthorized: () => Promise<boolean>
}): Promise<void> {
  try {
    await options.complete()
  } catch (completionError) {
    try {
      if (await options.isDeviceAuthorized()) return
    } catch {
      // Preserve the completion failure when the confirmation probe is also inconclusive.
    }
    throw completionError
  }
}
