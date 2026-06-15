export interface AuthProvider {
  validate(authorizationHeader: string | undefined): boolean
}

export class BearerAuthProvider implements AuthProvider {
  constructor(private readonly token: string) {}

  validate(authorizationHeader: string | undefined): boolean {
    if (!authorizationHeader?.startsWith("Bearer ")) return false
    return authorizationHeader.slice("Bearer ".length) === this.token
  }
}
