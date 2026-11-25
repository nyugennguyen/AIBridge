import type { FastifyInstance } from "fastify"
import { ENROLL_PATH } from "../../pairing/service.js"
import type { AppDependencies } from "../app.js"

/**
 * `POST /enroll` — the worker side of `aibr enroll join` (Phase 3, ADR 0012).
 *
 * Registered only when the app is given a pairing acceptor (`startBridge` does
 * so for engine-mode profiles), and served on the bridge's normal listener,
 * which is bound to the Tailscale address (AGENTS.md: 8787 is tailnet-only).
 * No bearer: the one-time code IS the credential, so the route is rate limited
 * and every attempt -- good or bad -- counts against the limit.
 */
export function registerEnrollRoute(app: FastifyInstance, dependencies: AppDependencies): void {
  const acceptor = dependencies.pairing
  if (acceptor === undefined) return
  const limiter = new SlidingWindowLimiter({ windowMs: 60_000, perKey: 5, global: 20 })

  app.post(ENROLL_PATH, async (request, reply) => {
    if (!limiter.allow(request.ip, Date.now())) {
      return reply.code(429).send({ error: "Too many pairing attempts; wait a minute and try again.", code: "pairing.rate_limited" })
    }
    const result = await acceptor.accept(request)
    return reply.code(result.status).send(result.body)
  })
}

export class SlidingWindowLimiter {
  readonly #hits = new Map<string, number[]>()
  #global: number[] = []

  constructor(private readonly limits: { readonly windowMs: number; readonly perKey: number; readonly global: number }) {}

  allow(key: string, now: number): boolean {
    const floor = now - this.limits.windowMs
    this.#global = this.#global.filter((t) => t > floor)
    const hits = (this.#hits.get(key) ?? []).filter((t) => t > floor)
    if (hits.length >= this.limits.perKey || this.#global.length >= this.limits.global) {
      this.#hits.set(key, hits)
      return false
    }
    hits.push(now)
    this.#global.push(now)
    this.#hits.set(key, hits)
    if (this.#hits.size > 1_000) {
      for (const [k, v] of this.#hits) if (v.every((t) => t <= floor)) this.#hits.delete(k)
    }
    return true
  }
}
