/**
 * M4.2 — node identity and enrollment.
 *
 * The seam every later mesh task authenticates against. Four things a consumer
 * must know before importing anything from here:
 *
 *   1. **`IdentityProvider` is the entry point.** M4.3 (registry), M4.4 (lease),
 *      M4.6 (SSE) and M4.7 (terminal WebSocket) should call
 *      `provider.authenticate(...)` — or register `createMeshIdentityHook` — and
 *      should NOT compose the trust store, the pin store, a clock and a replay
 *      guard themselves. Four places each re-deciding "is this node trusted" is
 *      four chances for one of them to skip the revocation check, and the one that
 *      skips it is the one that lets a revoked node keep working.
 *   2. **Revocation is inside `authenticate`, not after it.** A node identity is
 *      decided on the way in. There is no post-authentication "is this node still
 *      allowed" step, and a later task must not add one: a check that runs after
 *      authentication has already let the node hold a connection, a key, and a
 *      project path.
 *   3. **Tailscale reachability is not an identity input.** No function in this
 *      directory takes an address, a hostname, or a connection peer as an input
 *      to an identity decision. `verifyNodeTrust` and `resolvePinnedKey` take a
 *      `nodeId` and a `meshId` and nothing else, so there is no parameter a future
 *      caller can pass a peer address into. The existing shared bearer token
 *      (`src/security/auth-provider.ts`) is NOT accepted on a mesh route, and
 *      `middleware.ts` says why at length.
 *   4. **Nothing here is a wire schema.** This directory speaks the protocol in
 *      `src/mesh/protocol/`, it does not define a family, and it reads records
 *      only through `parseMeshEnvelope`.
 *
 * Purity: everything except `./middleware.js` and `./file-key-store.js` is pure
 * and clock-injected. Those two are the only modules permitted to touch the
 * framework and the filesystem, and both say so where a reader would otherwise
 * assume the module was pure.
 */

export * from "./crypto.js"
export * from "./time.js"
export * from "./node-key.js"
export * from "./key-store.js"
export * from "./file-key-store.js"
export * from "./memory-key-store.js"
export * from "./enrollment-code.js"
export * from "./enrollment.js"
export * from "./peer-key-pins.js"
export * from "./node-trust.js"
export * from "./request-signature.js"
export * from "./replay-guard.js"
export * from "./identity-provider.js"
export * from "./middleware.js"
