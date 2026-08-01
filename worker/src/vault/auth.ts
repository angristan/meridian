import type { TransactionSync } from "./domain"
import { VaultRecovery } from "./recovery"
import { VaultSessions } from "./sessions"
import { VaultSetup } from "./setup"

export { VaultRecovery } from "./recovery"
export { VaultSessions } from "./sessions"
export { VaultSetup } from "./setup"

export class VaultAuth {
  private readonly setup: VaultSetup
  private readonly sessions: VaultSessions
  private readonly recovery: VaultRecovery

  constructor(sql: SqlStorage, transactionSync: TransactionSync, closeAllSockets: () => void) {
    this.setup = new VaultSetup(sql, transactionSync)
    this.sessions = new VaultSessions(sql, transactionSync)
    this.recovery = new VaultRecovery(sql, transactionSync, closeAllSockets)
  }

  createSetupSession(): Promise<Response> {
    return this.setup.createSetupSession()
  }

  claim(request: Request): Promise<Response> {
    return this.setup.claim(request)
  }

  createAuthChallenge(request: Request): Promise<Response> {
    return this.sessions.createAuthChallenge(request)
  }

  createAuthSession(request: Request): Promise<Response> {
    return this.sessions.createAuthSession(request)
  }

  recoveryPackage(): Promise<Response> {
    return this.recovery.recoveryPackage()
  }

  createRecoveryChallenge(): Promise<Response> {
    return this.recovery.createRecoveryChallenge()
  }

  recover(request: Request): Promise<Response> {
    return this.recovery.recover(request)
  }
}
