export class CryptoError extends Error {
  readonly code: string
  override readonly cause?: unknown

  constructor(code: string, message: string, cause?: unknown) {
    super(message)
    this.name = "CryptoError"
    this.code = code
    this.cause = cause
  }
}

export class AuthenticationError extends CryptoError {
  constructor(message = "Cryptographic authentication failed", cause?: unknown) {
    super("AUTHENTICATION_FAILED", message, cause)
    this.name = "AuthenticationError"
  }
}

export class NonceReuseError extends CryptoError {
  constructor() {
    super("NONCE_REUSE", "A nonce was reused with the same revision key")
    this.name = "NonceReuseError"
  }
}

export class AuthorizationError extends CryptoError {
  constructor(message: string) {
    super("AUTHORIZATION_FAILED", message)
    this.name = "AuthorizationError"
  }
}
