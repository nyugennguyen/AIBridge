export interface AuthProvider {
  validate(authorizationHeader: string | undefined): boolean
}

export class BearerAuthProvider implements AuthProvider {
  constructor(private readonly token: string) {}

  validate(authorizationHeader: string | undefined): boolean {
    if (!authorizationHeader?.startsWith("Bearer ")) return false
    const received = Buffer.from(authorizationHeader.slice("Bearer ".length))
    const expected = Buffer.from(this.token)
    return received.length === expected.length && timingSafeEqual(received, expected)
  }
}
import { timingSafeEqual } from "node:crypto"
