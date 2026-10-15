# Operational Guide 06: Verification, Diagnostics & Logs

> **Topic:** Triage ladders, health verification, support bundles, log observation, and secret rotation.  
> **Source of Truth:** `.agents/skills/debugging-aibr-v2/SKILL.md`, `src/cli/verify.ts`, `src/cli/status.ts`, `src/cli/bundle.ts`.

---

## 1. The Operational Triage Ladder

When diagnosing an unhealthy node or failed request, execute checks in this exact order:

```bash
# 1. Dependency, Tailscale, config schema, and token file permissions
aibr verify --profile dev-main

# 2. Process check + 127.0.0.1:<port>/health responsiveness
aibr status --profile dev-main

# 3. Export redacted diagnostics support bundle (JSON to stdout)
aibr bundle --profile dev-main
```

---

## 2. Interpreting Health & Status

### 2.1 Understanding `aibr status`
`aibr status` reports one of three distinct values:

| Status Value | Meaning |
|---|---|
| `healthy` | tmux session exists AND the unauthenticated `/health` endpoint responds. |
| `session_missing` | The tmux session `aibridge-<profile>` is not running. |
| `bridge_unavailable` | The tmux session exists, but the HTTP bridge does not respond on port 8787. |

### 2.2 The "Healthy" Trap
> **`healthy` proves almost nothing.**
* The probe queries `/health`, which has **no authentication hook** and calls into OpenCode.
* It cannot detect a bearer token mismatch, an invalid project allowlist, or a dead ingress worker.
* If `aibr status` is `healthy` but `/trigger` fails with `401` or `403`, the issue is in your credentials or authorization allowlists, not service uptime.

---

## 3. Where Runtime Logs Actually Live

> [!IMPORTANT]
> **There are no log files in `~/.aibridge/.../logs/worker.log`.** Fastify runs with `{ logger: false }` and `StructuredLogger` is only active in unit tests.

To inspect actual execution activity, use authoritative sources:

```bash
# Capture recent bridge server stdout/stderr
tmux capture-pane -p -t aibridge-dev-main:bridge -S -2000

# Capture recent OpenCode stdout/stderr
tmux capture-pane -p -t aibridge-dev-main:opencode -S -2000

# Inspect authoritative job state record
cat ~/.local/state/aibridge/dev-main/jobs/<job_id>.json

# Inspect OpenCode's internal engine log
grep "<session_id>" ~/.local/share/opencode/log/opencode.log
```

---

## 4. Diagnostics Support Bundles (`aibr bundle`)

`aibr bundle` creates a sanitized diagnostic snapshot for troubleshooting:

```bash
# Output JSON support bundle to stdout
aibr bundle --profile dev-main

# Preview bundle in terminal without raw JSON output
aibr bundle --profile dev-main --preview
```

### 4.1 Automated Redaction
The bundle generator automatically scrubs:
* Bearer tokens, operator credentials, and runtime passwords.
* Raw prompts and memory entries.
* Absolute home directory paths.
* Ingress and egress payload bodies.

---

## 5. Token Rotation Procedure

Secrets are stored under `~/.local/share/aibridge/<profile>/secrets/` and are strictly **write-once**. Re-running setup over existing secrets will throw `Secret already exists`.

To rotate a compromised or expired bearer token across nodes:

```bash
# Step 1: Terminate running services on Node A
tmux kill-session -t aibridge-dev-main

# Step 2: Remove the immutable secret file on Node A
rm ~/.local/share/aibridge/dev-main/secrets/bearer_token

# Step 3: Run setup to generate or author the new secret on Node A
aibr setup --profile dev-main

# Step 4: Repeat steps 1-2 on Node B (e.g. test-vps)
tmux kill-session -t aibridge-test-vps
rm ~/.local/share/aibridge/test-vps/secrets/bearer_token

# Step 5: Author the identical token on Node B
# (Answer 'p' in setup Step 2 and paste the exact token from Node A)
aibr setup --profile test-vps

# Step 6: Restart both services
aibr start --profile dev-main     # on Node A
aibr start --profile test-vps     # on Node B

# Step 7: Verify connectivity with a zero-leak trigger probe
read -rs TOK; printf '\n'
curl -i -X POST http://<peer-ip>:8787/trigger \
  -H "Authorization: Bearer $TOK" \
  -H 'Content-Type: application/json' \
  -d '{}'
unset TOK
```
*(Verify you receive `HTTP 400 Bad Request`, indicating successful authentication).*
