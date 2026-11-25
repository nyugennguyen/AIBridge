# Đánh giá: Claude adapter & plugin — và mở rộng installer cho "Claude Code làm main orchestrator"

> Đánh giá cho [`claude-adapter-and-plugin.md`](./claude-adapter-and-plugin.md) (plan gốc, nằm untracked trên `dev`).
> Đối chiếu với code tại `dev@9402bd9`. Ngày: 2026-11-25.
> Các khẳng định về Claude Code CLI được đối chiếu với tài liệu chính thức (mục 5); những gì chưa chạy thật được đánh dấu **[cần Phase 0 xác nhận]**.

---

## 1. Kết luận nhanh

- **Hướng đi đúng, chẩn đoán đúng.** Mọi lỗi plan nêu cho `src/runtime/claude-adapter.ts` và `/trigger` đều có thật trong code. Phạm vi "giữ/tạm bỏ" hợp lý.
- **Plan thiếu một mảng lớn: cài đặt & cấu hình.** Hiện tại một máy *chỉ có Claude Code* không qua được `aibr setup` (preflight bắt buộc `opencode`), config bắt buộc khối `opencode`, `/trigger` trả 503 nếu OpenCode không chạy. Plan không có phase nào cho installer/wizard/preflight, và Phase 6 không nói plugin được *cài* vào Claude Code thế nào.
- **Phase 3 bỏ sót Rust router.** Khi `ingress_mode: "router"`, `/trigger` do `aibr-router` nhận chứ không phải Fastify; gắn middleware TS thôi là không đủ.
- **Phase 1 bỏ sót vài lỗi adapter** (stdin không bao giờ đóng → process không exit; `code ?? 0` biến process bị kill thành "exit 0"; `--system-prompt` thay toàn bộ system prompt mặc định; `restore()` không thật sự resume).
- **Thứ tự nên chỉnh:** tách Phase 6 thành 6a (plugin + installer, dùng bearer + capability chỉ-đọc) có thể làm ngay sau Phase 2, và 6b (ký ed25519, `repo@sha`) sau Phase 3/5. Người dùng "Claude Code làm orchestrator" có giá trị sớm hơn nhiều.

## 2. Đối chiếu từng phase với code

### Phase 0 — harness live
- `tests/live/` chưa tồn tại; `package.json` không có `test:live`. `claude` chưa cài trên máy dev này.
- "Fork, tạo branch `claude-bridge`" không cần — repo là của mình; làm trên branch tách từ `dev`.
- **Bổ sung:** test live nên kiểm luôn từng flag mà Phase 1–2 dựa vào (`--verbose`, `--permission-mode dontAsk`, `--max-budget-usd`, `--setting-sources`, `--strict-mcp-config`) bằng `claude --help` + 1 lần chạy thật, và in `claude --version` vào output để khi CLI đổi version thì biết ngay. Chạy định kỳ trong CI (job riêng, có secret), không nằm trong `release:check`.

### Phase 1 — sửa adapter (`src/runtime/claude-adapter.ts`)
Xác nhận các lỗi plan nêu:

| Plan nêu | Code hiện tại |
|---|---|
| Thiếu `--verbose` | args ở dòng 464–473 không có `--verbose` (docs không ghi là bắt buộc nhưng mọi ví dụ chính thức đều có → cứ thêm) |
| Sai format stdin | dòng 533, 585: `{"type":"user_message","message":...}`. Shape đúng theo docs còn có `"parent_tool_use_id": null` — plan thiếu field này |
| Parse `result` sai | dòng 561–563 đọc `parsed.outcome === "success"` và `parsed.summary` — không phải field thật. Field thật: `subtype`, `is_error`, `result`, `total_cost_usd`, `usage`, `num_turns`, `session_id`, `permission_denials`. Các subtype lỗi (`error_max_turns`, `error_during_execution`, `error_max_budget_usd`, …) **không có** `result` mà có `errors[]` |
| `permission_request`/`permission_response` giả | dòng 551–560 và `respond()` dòng 302–322 |
| ADR 0005 §3 mô tả protocol giả | đúng, ADR ghi `user_message` / `permission_response` |

**Plan bỏ sót:**
1. **Stdin không bao giờ được đóng.** Với `--input-format stream-json`, docs ngụ ý process chỉ kết thúc sau khi "stdin has closed", nên sau `result` process có thể không exit → `observe()` báo `working` mãi cho tới timeout. Cần: sau `result` (job single-shot) thì `stdin.end()`; hoặc giữ mở có chủ đích cho multi-turn và đóng khi job kết thúc. **[cần Phase 0 xác nhận — docs không nói thẳng]**
2. **`active.exitCode = code ?? 0` (dòng 519).** Process bị kill bằng signal (`code === null`) bị coi là exit 0 → outcome `unknown` thay vì `failed`. Ghi cả `signal`.
3. **`--system-prompt` thay toàn bộ system prompt mặc định của Claude Code** (mất hướng dẫn dùng tool, git, v.v.). Nên dùng `--append-system-prompt` cho phần RoleBinder compile, trừ khi cố ý.
4. **`restore()` chỉ tra Map trong bộ nhớ**, không spawn `claude -r <uuid>` như ADR 0005 §2 nói. Sau khi bridge restart thì mất session. Hoặc implement, hoặc hạ capability `nativeSessionRestore` xuống `conditional`.
5. **`capabilityReport.structuredPermissions`** đang ghi "Supported via bidirectional stdin" — phải đổi thành `unsupported` (quyền do profile quyết định từ trước).
6. **`observe()` không phải stream**: yield phần đã buffer rồi return. Caller (monitor ở Phase 2) phải poll; nên nói rõ trong plan, hoặc đổi sang async queue.
7. **`--include-hook-events`** có thật (cần `stream-json`) — giữ được.
8. Lưu `total_cost_usd`, `usage`, `num_turns`, `session_id` vào `AgentResult` — Phase 2 cần để enforce/ghi budget.
9. **Tool bị từ chối**: không có `permission_request`, nhưng có system message `permission_denied` trong stream và `permission_denials` trong `result`. Đây chính là dữ liệu để giải rủi ro "agent im lặng thất bại" mà plan nêu ở cuối — map sang event riêng và đưa vào report.

### Phase 2 — `/trigger` → Claude + capability profiles
Xác nhận: `src/server/routes/trigger.ts` gắn cứng OpenCode — dòng 39 (`opencodeClient.health()` → 503), 110–112 (`createSession`/`sendPromptAsync`), `monitorSession` của OpenCode, response có `opencode_session_id`.

**Plan bỏ sót:**
1. **`opencode` là khối bắt buộc** trong `bridgeConfigSchema` (`src/config/schemas.ts:58`). Phải thành optional / theo `runtime.kind` (discriminated union), giữ default để config cũ vẫn parse.
2. **Đổi schema config ⇒ phải regenerate contracts.** `contracts/v1/bridge-config.schema.json` + Rust (`router/src/contracts.rs`, `crates/aibr-ipc`) được sinh từ schema TS; `bun run contracts:check` sẽ fail nếu quên. Đưa vào checklist Phase 2.
3. **Quan hệ giữa `capability_profiles` và cấu hình hiện có** chưa định nghĩa: `security.allowed_sources[].capabilities`, `projects[].capabilities`, `permissions.allow_tools`, `planning.require_approval_for`. Đề xuất: tên profile = chuỗi `capability`; quyền chạy = `allowed_sources ∩ projects ∩ capability_profiles`; `permissions.*` chỉ áp dụng cho runtime OpenCode. Ghi vào ADR.
4. **Đăng nhập Claude trên staging**: worker cần `CLAUDE_CODE_OAUTH_TOKEN` (từ `claude setup-token`, cần gói Pro/Max/Team/Enterprise, token hạn 1 năm và không tự lưu) hoặc `ANTHROPIC_API_KEY`. `sanitizeChildProcessEnv` hiện chỉ cho qua `ANTHROPIC_API_KEY` (dòng 484) → token OAuth sẽ bị lọc mất. Cần thêm vào allowlist. Lưu ý thứ tự ưu tiên: ở chế độ `-p`, nếu có `ANTHROPIC_API_KEY` thì nó **luôn** được dùng trước OAuth token — env worker chỉ nên có một trong hai để không bị tính tiền nhầm nguồn.
4b. **Luôn truyền `--permission-mode dontAsk` tường minh.** Từ v2.1.302, `-p` không có mode sẽ chạy Manual (từ chối mọi call cần duyệt). Kết quả gần giống, nhưng phụ thuộc mặc định của từng version CLI là rủi ro. Lưu ý thêm: tên tool trần trong `--disallowedTools` (vd `Edit`) gỡ hẳn tool khỏi context — tốt cho `investigate`.
5. **Immutable core**: profile là dữ liệu config, không phải charter, nhưng nên có test chứng minh profile không nới được `SAFETY_FLOOR` (vd. profile nào cũng phải có deny `Read(./.env*)`), tương tự `assertCharterDoesNotRelaxCore`.
6. **Preflight / wizard** (xem mục 3).

### Phase 3 — danh tính node
- Đúng: `src/mesh/identity/middleware.ts` hiện chỉ gắn vào mesh gateway (`src/mesh/gateway/events/route.ts`, `terminal/route.ts`); `/trigger` & `/report` chỉ có bearer.
- **Bỏ sót Rust router**: với `ingress_mode: "router"`, router admit `/trigger` bằng bearer rồi ghi WAL. Hoặc router verify chữ ký (port `request-signature`/`replay-guard` sang Rust + contract parity), hoặc router chuyển nguyên header chữ ký vào record để worker verify trước khi chạy. Phải chọn một và ghi ADR.
- `aibr enroll` chưa có (lib `enrollment.ts`, `enrollment-code.ts`, `peer-key-pins.ts` đã có). `COMMANDS` trong `src/cli.ts:152` không có `enroll`.

### Phase 4 — duyệt bằng operator
- Xác nhận lỗ hổng: `src/planning/provider.ts:10-13` tin `metadata.plan_status === "approved"` từ body.
- Route thực tế là `POST /orchestration/commands` (lệnh `dispatch.propose/approve/execute` bên trong), không phải route riêng — plan nên ghi đúng.
- `aibr approve/reject` chưa có trong CLI.
- Điểm tốt của plan: operator token ngoài tầm Claude. Cần cụ thể hoá trong installer (mục 3.4).

### Phase 5 — `repo@sha`
- Hợp lý. Bổ sung: giới hạn số worktree đồng thời (dùng `budgets/` đã có), dọn worktree khi worker crash (quét `<state>/worktrees/` lúc khởi động), và `git fetch` cần credential chỉ-đọc riêng cho staging.

### Phase 6 — plugin Claude
Layout plan đề xuất đúng chuẩn plugin Claude Code. Góp ý:
1. **MCP server không nên là `bun mcp/server.ts` trỏ vào checkout.** Nên là lệnh của chính CLI: `aibr mcp serve --profile <p>` — cùng version với `aibr`, không phụ thuộc đường dẫn repo, không cần plugin tự mang `node_modules`.
2. **Plugin phải nằm trong npm package** (`package.json` `files` hiện chỉ có `dist`, `bin`, …) để installer cài được đúng version (mục 3).
3. **`bridge_await` phải có giới hạn ngắn** (≤ 60–120 s) và để skill lặp lại. Không phải vì client timeout — `MCP_TOOL_TIMEOUT` mặc định ~28 giờ — mà vì một tool call treo lâu sẽ chặn cả lượt của Claude, user không ngắt/ra lệnh khác được.
4. **Hook `SessionStart`** gọi mạng phải đặt `"timeout"` tường minh (vd 5 s; mặc định là 600 s) và im lặng khi lỗi — không được làm chậm/khoá mọi session Claude trên máy dev. Stdout của hook được đưa vào context, nên giữ output ngắn.
5. **Khoá node trên máy dev**: Claude chạy cùng OS user nên đọc được file `*.node-key.json` → có thể tự ký request bằng Bash, vượt qua MCP. Chấp nhận được (quyền thực sự do staging quyết định qua `allowed_sources` + profile), nhưng phải ghi rõ trong threat model. **Plugin không thể tự mang permission deny rule** (docs không có cơ chế này) → nếu muốn chặn, installer phải ghi deny `Read(<state>/**/*.node-key.json)` + file operator token vào `~/.claude/settings.json`, và chỉ khi user đồng ý rõ.
6. **Không có tool approve** — đúng, giữ nguyên.

### Phase 7 — mạng & vận hành
Hợp lý. Bổ sung: `aibr stop --all-jobs` chưa có trong CLI (`COMMANDS` không có `stop`) — cần đưa vào Phase 4 hoặc 7 chứ không chỉ nhắc trong runbook.

### Lặt vặt
- Plan tự ghi vị trí đề xuất là `claude-dev-staging.md` nhưng file tên `claude-adapter-and-plugin.md` → thống nhất một tên.
- `scripts/install.sh --version` in `2.0.0`, package là `3.0.0`; installer nên đọc từ `src/version.ts` hoặc test khoá lại.

## 3. Mở rộng cài đặt: Claude Code làm main orchestrator

> Đánh giá chi tiết trải nghiệm cài đặt cho người dùng mới (lỗi `curl | bash`, secret bị echo, ghép nối hai máy, quickstart `aibr init`, …) nằm ở [installation-ux-review.md](./installation-ux-review.md). Mục này chỉ nói phần dành riêng cho vai trò orchestrator.

### 3.1 Hai vai trò cài đặt
Hiện installer và wizard chỉ biết một vai: **node worker chạy OpenCode**. Cần thêm khái niệm *vai trò node*:

| Vai trò | Ai dùng | Cần gì | Không cần |
|---|---|---|---|
| `worker` (hiện có) | staging/VPS nhận job | tailscale, tmux, runtime (`opencode` **hoặc** `claude`) | plugin |
| `orchestrator` (mới) | máy dev, Claude Code giao việc | tailscale, `claude`, `aibr` CLI, khoá node, plugin | opencode, tmux, router, unit supervisor |
| `both` | máy vừa giao vừa nhận | hợp của hai | — |

### 3.2 `install.sh`
- Cờ mới: `--role worker|orchestrator|both` (mặc định `worker` để không đổi hành vi cũ), `--runtime opencode|claude` cho worker, `--with-claude-plugin` / `--without-claude-plugin`.
- `check_prereqs` theo vai trò: orchestrator không đòi `opencode`/`tmux`; worker-claude đòi `claude` thay `opencode`.
- Phát hiện `claude`: nếu thiếu thì chỉ in hướng dẫn cài chính thức, **không tự cài** (giống cách đang làm với opencode).
- Plugin: installer chỉ gọi `aibr plugin install claude` (logic nằm trong TypeScript để test được, shell giữ mỏng).
- Sửa `--version` cho khớp package; cập nhật `tests/unit/installer/*` và `readme-installer.test.ts`.

### 3.3 Lệnh mới `aibr plugin` (đề xuất, chưa có)
- `aibr plugin install claude [--scope user|project] [--profile <p>] [--marketplace bundled|github]`
- `aibr plugin uninstall claude [--scope …]`
- `aibr plugin status claude`

- **Nguồn plugin mặc định = bản đóng gói trong npm package** (`<pkg>/plugins/aibridge` + `<pkg>/.claude-plugin/marketplace.json`, entry `"source": "./plugins/aibridge"` — đường dẫn tương đối phải bắt đầu bằng `./` và tính từ gốc marketplace) → version plugin luôn khớp `aibr`. Tuỳ chọn `--marketplace github` dùng `nyugennguyen/AIBridge` (hoặc `nyugennguyen/AIBridge#vX.Y.Z` để ghim version) cho người muốn theo repo.
- Chỉ dùng CLI chính thức của Claude Code: `claude plugin marketplace add <dir> --scope <s>` rồi `claude plugin install aibridge@aibridge --scope <s> -y --json`; gỡ bằng `claude plugin uninstall aibridge@aibridge -s <s> -y --json`. **Không** sửa tay `~/.claude.json` hay `~/.claude/settings.json` (nhất quán với ADR 0005 §1 "non-invasive").
- Idempotent: đọc `claude plugin list` — đã cài cùng version → no-op; khác version → `claude plugin marketplace update` + `claude plugin update`.
- Fallback khi `claude` quá cũ, thiếu lệnh `plugin`: in lệnh `/plugin marketplace add …` + `/plugin install …` để user tự gõ trong Claude Code; exit code khác 0 để script biết. Thử nhanh không cài: `claude --plugin-dir <pkg>/plugins/aibridge`.
- Plugin cần biết profile: dùng `userConfig` của plugin (khoá `profile`, không sensitive) → `.mcp.json` chạy `"command": "aibr", "args": ["mcp","serve","--profile","${user_config.profile}"]`. Trạng thái cục bộ (cache peer, job gần nhất) để ở `${CLAUDE_PLUGIN_DATA}`. Không nhúng token/khoá vào file plugin.
- Phụ thuộc: chạy qua `ProcessRunner` (đã có trong `src/host/`) để unit test bằng fake.

### 3.4 `aibr setup` (wizard)
- **Step 1** thêm câu hỏi vai trò (`worker` / `orchestrator` / `both`) và runtime cho worker (`opencode` / `claude`).
- **Step 0 preflight** (`src/host/preflight.ts:132`, `PREREQS = ["tmux","opencode","tailscale"]`) đổi thành danh sách theo vai trò/runtime. Đây là chỗ chặn cứng duy nhất hiện nay cho user Claude-only.
- **Step 2** với orchestrator: sinh khoá node (`file-key-store`), in public key + enrollment code để dán sang staging (`aibr enroll` phía staging). Không sinh router bearer nếu không chạy router.
- **Step 4** (peers) giữ nguyên tinh thần "Discovery proposes, the operator enrols": chọn staging peer nào plugin được phép giao việc.
- **Step 5** với orchestrator: không cài unit supervisor; thay bằng hỏi "Cài plugin AIBridge vào Claude Code? (scope user/project)" → gọi `aibr plugin install claude`. Hỏi tiếp (mặc định *không*, phải đồng ý rõ) có thêm deny rule cho file khoá/operator token vào `~/.claude/settings.json` không — đây là sửa cấu hình người dùng nên phải có xác nhận.
- Worker-claude ở Step 5: hướng dẫn `claude setup-token` và ghi `CLAUDE_CODE_OAUTH_TOKEN` vào env file mode `0600` (hoặc chỉ in hướng dẫn — không nhận token qua prompt nếu không cần). Tạo OS user riêng (`aibr`) chỉ in hướng dẫn, không tự tạo.

### 3.5 `aibr verify` / `aibr status`
- Orchestrator: kiểm `claude --version`, `claude plugin list` có `aibridge@…` đúng version, `aibr mcp serve` trả lời `initialize`, peer staging reachable + khoá đã được pin bên kia (`bridge_peers`).
- Worker-claude: kiểm `claude` đăng nhập được (một lần `claude -p` rất ngắn với budget nhỏ, chỉ khi user chạy `verify --live`).

### 3.6 Gate & test
- `tests/unit/cli/plugin.test.ts` (fake `ProcessRunner`): cài mới, cài lại idempotent, claude thiếu, claude cũ.
- `tests/unit/installer`: cờ `--role`, `--with-claude-plugin`; `shellcheck` vẫn sạch.
- Test cấu trúc plugin: `plugin.json`/`marketplace.json` hợp lệ, `.mcp.json` không chứa secret, version plugin == `package.json`.
- `release:check`: thêm kiểm `bun pm pack --dry-run` có `plugins/aibridge/**` và `.claude-plugin/marketplace.json`; chạy `claude plugin validate <dir> --strict` (exit 0 = pass) nếu có `claude` (không bắt buộc trên CI).
- AGENTS.md / README: thêm luồng "Claude Code orchestrator" vào phần cài đặt; mục Release thêm bước bump version plugin.

## 4. Thứ tự đề xuất (chỉnh lại)

| # | Nội dung | Phụ thuộc | Ghi chú |
|---|---|---|---|
| 0 | Live harness + xác minh flag CLI | — | như plan, thêm kiểm flag |
| 1 | Sửa adapter (+ 8 điểm bổ sung ở §2) | 0 | sửa ADR 0005 |
| 2 | `/trigger` → Claude, profiles, `opencode` optional, preflight theo runtime | 1 | regenerate contracts |
| **I1** | **Installer/wizard theo vai trò + `aibr plugin` + plugin 6a** | 2 | bearer + chỉ `investigate`; giá trị sớm cho user orchestrator |
| 3 | Ký ed25519 cho `/trigger` (**cả router**) + `aibr enroll` | 2 | ADR cho router |
| 4 | Duyệt operator, `aibr approve/reject`, `aibr stop --all-jobs` | 3 | bỏ tin `plan_status` |
| 5 | `repo@sha`, script deterministic | 2 | |
| 6b | Plugin dùng chữ ký + `repo/ref`, skill vòng lặp sửa lỗi | 3, 5, I1 | Done như Phase 6 gốc |
| 7 | ACL + runbook | 4 | |

Ràng buộc an toàn của plan giữ nguyên: **trước khi xong 3–4, chỉ bật `investigate`** — I1 tuân thủ điều này (plugin mặc định chỉ đề xuất capability chỉ-đọc).

## 5. Xác minh Claude Code CLI

Đối chiếu với docs chính thức tại `code.claude.com/docs` (2026-11-25), **chưa chạy thật** — Phase 0 phải xác nhận lại bằng `claude --help` trên đúng version cài ở staging.

| Plan dựa vào | Kết quả | Ghi chú |
|---|---|---|
| `-p --output-format stream-json --verbose` | Có | `--verbose` không ghi là bắt buộc, nhưng mọi ví dụ đều dùng |
| Stdin `{"type":"user","message":{"role":"user","content":…}}` | Gần đúng | Thêm `"parent_tool_use_id": null` |
| Field `result`: `result`, `is_error`, `subtype`, `total_cost_usd`, `usage` | Có | Thêm `permission_denials`, `num_turns`, `session_id`; subtype lỗi có `errors[]`, không có `result` |
| `permission_request` / `permission_response` | **Không tồn tại** | Plan đúng khi bỏ. Duyệt quyền thật đi qua `--permission-prompt-tool`, hook `PermissionRequest`, hoặc SDK |
| `--include-hook-events` | Có | Cần `stream-json` |
| `--permission-mode dontAsk` | Có | Tự từ chối mọi call cần hỏi; allow rule + hook vẫn chạy. Từ v2.1.302 `-p` mặc định Manual |
| `--allowedTools` / `--disallowedTools` | Có | Cú pháp `"Bash(git log *)"`; plan đang viết dạng cũ `Bash(git log:*)` → kiểm lại khi viết profile |
| `--max-budget-usd` | Có (chỉ `-p`) | Ước lượng phía client, tính cả subagent. Có thêm `--max-turns` |
| `--setting-sources user` | Có | Giá trị: `user,project,local` |
| `--settings <file>` | Có | File hoặc JSON inline, tối đa 2 MiB |
| `--strict-mcp-config` | Có | Bỏ qua cả `.mcp.json`, `~/.claude.json` **và MCP của plugin** — đúng ý staging |
| `--system-prompt` | Có, **thay toàn bộ** prompt mặc định | Dùng `--append-system-prompt` để giữ hướng dẫn tool/an toàn mặc định |
| `claude setup-token` / `CLAUDE_CODE_OAUTH_TOKEN` | Có | Cần gói trả phí; `ANTHROPIC_API_KEY` thắng OAuth token trong `-p` |
| `claude plugin marketplace add` / `install` / `uninstall` / `list` / `validate` / `update` | Có | `--scope user\|project\|local`, `-y`, `--json`; `validate --strict` |
| Plugin `userConfig`, `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}` | Có | |
| Plugin tự mang permission deny rule | **Không có** | Phải ghi vào settings của user (có xác nhận) |
| Timeout MCP tool | `MCP_TOOL_TIMEOUT`, mặc định ~28 giờ | Không phải lý do để giới hạn `bridge_await` — lý do là UX |
| Hook `SessionStart` | Stdout vào context; `timeout` mặc định 600 s | Phải đặt timeout ngắn |

**Điểm plan cần sửa theo bảng này:** shape stdin (`parent_tool_use_id`), cú pháp rule `Bash(cmd *)` thay cho `Bash(cmd:*)` (Phase 0 kiểm xem dạng cũ còn được chấp nhận không), xử lý subtype lỗi không có `result`, và dùng `permission_denials` cho báo cáo tool bị từ chối.
