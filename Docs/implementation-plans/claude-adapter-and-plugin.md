# Plan: AIBridge cho Claude — giao việc & kiểm soát Dev ↔ Staging

> Mục tiêu: Claude trên máy dev (local) giao việc cho Claude Code trên staging (VPS/cloud) qua Tailscale, có kiểm soát: biết ai gửi, giới hạn agent được làm gì, việc nhạy cảm phải có người duyệt, kết quả gắn với đúng commit.
> Đề xuất vị trí trong repo: `Docs/implementation-plans/claude-dev-staging.md`
> Cách dùng với Claude Code: **mỗi phase = 1 session + 1 PR**. Mở session bằng: *"Đọc plan này, làm Phase N, dừng khi đạt Done."*

---

## Phạm vi

**Giữ:** `router/`, `src/server`, `src/ingress`, `src/jobs`, `src/security`, `src/mesh/identity`, `src/orchestration` (dispatch propose/approve/execute), `src/callback`, `src/runtime/claude-adapter.ts`.
**Tạm bỏ qua (không xoá):** Herdr, roundtable, memory, Codex/OpenCode adapter, mesh lease/epoch.

## Thứ tự & MVP

| Phase | Nội dung | Ước lượng | MVP? |
|---|---|---|---|
| 0 | Fork + smoke test với `claude` thật | 0.5 ngày | ✅ |
| 1 | Sửa Claude adapter | 1 ngày | ✅ |
| 2 | `/trigger` chạy Claude + capability profiles | 1–2 ngày | ✅ |
| 3 | Danh tính node ký ed25519 cho `/trigger` | 1–2 ngày | ✅ |
| 4 | Duyệt bằng operator (ngoài kênh) | 1 ngày | ✅ |
| 5 | Job gắn `repo@sha` + bước deterministic | 1 ngày | |
| 6 | Plugin Claude (MCP + skill + hooks) | 2 ngày | |
| 7 | Tailscale ACL + runbook | 0.5 ngày | |

**MVP = Phase 0–4.** Trước khi xong Phase 3–4, chỉ bật capability chỉ-đọc (`investigate`).

---

## Phase 0 — Fork & harness test thật

- [ ] Fork, tạo branch `claude-bridge`.
- [ ] Thêm `tests/live/claude-cli.live.test.ts`, chỉ chạy khi `AIBR_LIVE_CLAUDE=1`: spawn `claude` thật, gửi 1 prompt, assert nhận `system/init` và `result`.
- [ ] Script `bun run test:live`.

**Done:** test live **fail** trên code hiện tại (chứng minh lỗi Phase 1).

## Phase 1 — Sửa `src/runtime/claude-adapter.ts`

- [ ] Thêm `--verbose` vào args (bắt buộc khi `-p` + `stream-json`).
- [ ] Stdin prompt đổi sang:
  `{"type":"user","message":{"role":"user","content":"<text>"}}`
- [ ] Parse `result` event thật: dùng field `result` (text), `is_error`, `subtype`, `total_cost_usd`, `usage`; bỏ `summary`.
- [ ] Bỏ `permission_request`/`permission_response` giả. Quyền xử lý bằng profile (Phase 2). `respond()` → trả `unsupported`.
- [ ] Map thêm `assistant`/`user` (tool_use/tool_result) → `working`.
- [ ] Cập nhật fake CLI trong test cho đúng format thật; sửa ADR 0005 mục 3.

**Done:** `bun test` + `bun run test:live` pass.

## Phase 2 — `/trigger` → Claude + capability profiles

- [ ] Config mới (`src/config/schemas.ts`):
  ```jsonc
  "runtime": { "kind": "claude" },            // "opencode" giữ tương thích
  "capability_profiles": {
    "investigate":   { "allow": ["Read","Grep","Glob","Bash(git log:*)","Bash(docker logs:*)"],
                       "deny":  ["Edit","Write","Read(./.env*)","Bash(curl:*)","Bash(ssh:*)"],
                       "max_budget_usd": 2, "timeout_s": 900 },
    "run-tests":     { "allow": ["Read","Grep","Bash(npm test:*)","Bash(npm run test:*)"],
                       "deny":  ["Edit","Write","Read(./.env*)","Bash(curl:*)"] },
    "fix-on-branch": { "allow": ["Read","Edit","Write","Bash(npm test:*)","Bash(git commit:*)","Bash(git push origin aibr/*)"],
                       "deny":  ["Read(./.env*)","Bash(git push origin main*)"],
                       "requires_approval": true },
    "deploy":        { "script": "scripts/deploy-staging.sh", "requires_approval": true }
  }
  ```
- [ ] `trigger.ts`: nếu `runtime.kind === "claude"` → không check OpenCode health; launch qua `ClaudeCodeRuntimeAdapter`. Capability không có trong `capability_profiles` → **403**.
- [ ] Adapter nhận profile → args:
  `--permission-mode dontAsk --allowedTools … --disallowedTools … --max-budget-usd N`
  `--setting-sources user --settings <staging-settings.json> --strict-mcp-config`
  > ⚠️ `--setting-sources user` để **không nạp `.claude/settings.json`, hooks, MCP trong repo** — code đến từ dev nên không được tự nới quyền trên staging.
- [ ] Monitor job từ `observe()` → `markCompleted/markFailed` → callback như cũ.
- [ ] Worker chạy dưới user OS riêng (`aibr`), không đọc được secrets ngoài project.

**Done:** test: capability lạ → 403; profile `investigate` không thể `Edit` (test live); repo có `.claude/settings.json` cho phép `Bash(*)` vẫn bị chặn.

## Phase 3 — Danh tính node cho `/trigger`

- [ ] Gắn middleware `src/mesh/identity/middleware.ts` vào `/trigger` và `/report` (đã dùng cho mesh gateway).
- [ ] `source_agent_id` lấy từ **khoá đã verify**, bỏ qua giá trị trong body (hoặc reject nếu lệch).
- [ ] Enrollment: `aibr enroll` trao đổi public key 1 lần, pin vào `peer-key-pins`.
- [ ] Config `security.legacy_shared_token: false` (mặc định false cho profile mới).

**Done:** request đúng token nhưng không có chữ ký → 401; chữ ký từ key chưa pin → 403; replay → bị `replay-guard` chặn.

## Phase 4 — Duyệt bằng operator

- [ ] Capability có `requires_approval` → job vào `blocked/awaiting_approval`, **không** tin `metadata.plan_status`.
- [ ] Duyệt qua luồng có sẵn `dispatch.propose → dispatch.approve → dispatch.execute` (`routes/orchestration.ts`), `actor.kind = "user"` + `AIBRIDGE_OPERATOR_TOKEN`.
- [ ] CLI cho người: `aibr approve <job>` / `aibr reject <job>` (hiện prompt + diff/plan trước khi duyệt).
- [ ] Operator token **chỉ ở máy người duyệt**, ngoài tầm Claude: không nằm trong env của session Claude, thêm deny `Read(~/.local/share/aibridge/**/operator*)`.

**Done:** agent dev gửi `plan_status: approved` vẫn bị giữ; chỉ `aibr approve` mới chạy được.

## Phase 5 — Gắn commit & bước deterministic

- [ ] Trigger thêm `repo` + `ref` (branch/sha). Worker: `git fetch && git checkout --detach <sha>` trong worktree riêng mỗi job (`<state>/worktrees/<job>`), xoá sau khi xong.
- [ ] Profile có `script` → chạy script (không qua LLM), log + exit code vào report.
- [ ] Profile có thể có `pre`/`post` script (vd build, seed) quanh bước Claude.
- [ ] Report thêm `sha`, `script_results[]`.

**Done:** 2 job khác sha chạy song song không đụng nhau; report luôn có sha.

## Phase 6 — Plugin Claude

```
plugins/aibridge/
  .claude-plugin/plugin.json
  .mcp.json                   # stdio: bun mcp/server.ts
  mcp/server.ts               # chỉ gọi HTTP (ký bằng node key), không có business logic
  skills/aibridge-dispatch/SKILL.md
  commands/bridge-send.md  commands/bridge-status.md
  hooks/hooks.json            # SessionStart: in danh sách peer + job đang chạy
```

- [ ] MCP tools: `bridge_peers`, `bridge_dispatch(target, capability, repo, ref, prompt)`, `bridge_status(job)`, `bridge_await(job, timeout_s)`, `bridge_result(job)`, `bridge_cancel(job)`. **Không có** tool approve.
- [ ] Skill: khi nào giao staging (test tích hợp, tái hiện bug, đọc log), luôn push branch trước rồi gửi `ref`, đọc `findings` để sửa vòng tiếp; không chuyển tiếp việc đã bị từ chối quyền.
- [ ] Callback về dev: MCP poll `/jobs/<id>` (đơn giản) — SSE để sau.

**Done:** trong Claude Code trên dev: *"chạy run-tests trên staging cho branch hiện tại và sửa lỗi"* chạy trọn vòng ≥ 2 lần lặp.

## Phase 7 — Mạng & vận hành

- [ ] Tailscale ACL:
  ```jsonc
  {"action":"accept","src":["tag:aibr-dev"],"dst":["tag:aibr-staging:8787"]},
  {"action":"accept","src":["tag:aibr-staging"],"dst":["tag:aibr-dev:8787"]}
  // staging không có rule tới tag:prod; tắt Tailscale SSH cho tag:aibr-staging
  ```
- [ ] Runbook `Docs/runbooks/claude-dev-staging.md`: enroll, xoay key, kill switch (`aibr stop --all-jobs`), đọc audit log.

---

## Ngoài phạm vi (lần sau)
Multi-staging fan-out, Codex/OpenCode, UI web, SSE push, quản lý secrets tập trung.

## Rủi ro chính
- Flag/format CLI Claude đổi theo version → giữ `test:live` trong CI định kỳ.
- `--permission-mode dontAsk` từ chối mọi tool ngoài allowlist → profile phải đủ, nếu không agent "im lặng" thất bại; log rõ tool bị từ chối vào report.
- Code từ dev chạy trên staging (test scripts) vẫn là code không tin cậy → user OS riêng + không secrets prod trên staging.
