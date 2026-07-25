import { describe, expect, it } from "vitest"
import { MASKED_RECOVERY_CODE, recoveryCodePresentation } from "../src/ui/recovery-code"

const RECOVERY_CODE = "mdn1-secret-recovery-material"

describe("recovery code presentation", () => {
  it("does not expose recovery material before an explicit reveal", () => {
    const presentation = recoveryCodePresentation(RECOVERY_CODE, false)

    expect(presentation.text).toBe(MASKED_RECOVERY_CODE)
    expect(presentation.text).not.toContain(RECOVERY_CODE)
    expect(presentation.codeLabel).toBe("Recovery code hidden")
    expect(presentation.toggleLabel).toBe("Show recovery code")
  })

  it("exposes recovery material only while revealed", () => {
    expect(recoveryCodePresentation(RECOVERY_CODE, true)).toEqual({
      text: RECOVERY_CODE,
      codeLabel: "Recovery code visible",
      toggleLabel: "Hide recovery code",
    })
  })
})
