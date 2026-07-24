import type { WorkerEnv } from "../src/index"

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}
