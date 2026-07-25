export const MASKED_RECOVERY_CODE = "•••• •••• •••• •••• •••• ••••"

export interface RecoveryCodePresentation {
  readonly text: string
  readonly codeLabel: string
  readonly toggleLabel: string
}

export function recoveryCodePresentation(
  recoveryCode: string,
  revealed: boolean,
): RecoveryCodePresentation {
  return revealed
    ? {
        text: recoveryCode,
        codeLabel: "Recovery code visible",
        toggleLabel: "Hide recovery code",
      }
    : {
        text: MASKED_RECOVERY_CODE,
        codeLabel: "Recovery code hidden",
        toggleLabel: "Show recovery code",
      }
}
