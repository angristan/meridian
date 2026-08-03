import type { Context, Hono } from "hono"

export interface WorkerEnv extends Env {
  SETUP_TOKEN?: string
}

export type WorkerBindings = { Bindings: WorkerEnv }

export type WorkerContext = Context<WorkerBindings>
export type WorkerApp = Hono<WorkerBindings>
