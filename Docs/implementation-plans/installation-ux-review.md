# Đánh giá trải nghiệm cài đặt cho người dùng mới

> Bổ sung cho [claude-adapter-and-plugin-review.md](./claude-adapter-and-plugin-review.md) §3.
> Đối chiếu với `dev@9402bd9`, ngày 2026-11-25.
> Phương pháp: đọc `scripts/install.sh`, `src/cli/setup-wizard.ts`, `src/host/*`, README và `Docs/getting-started.md`; **chạy thật** `aibr --help`, `aibr verify`, `aibr setup` (qua pseudo-TTY, HOME/XDG cô lập trong thư mục tạm), `aibr serve` + `GET /health`. Chưa chạy `install.sh` thật (sẽ cài global) và chưa thử luồng hai máy.
> Mỗi phát hiện ghi rõ là **[quan sát]** (đã thấy khi chạy) hay **[theo code]** (suy ra từ source).

---

## 1. Kết luận

Installer và wizard hiện tại được viết rất cẩn thận về **an toàn** (không tự bật `auth_mode: none`, discovery không tự enrol peer, không tự load unit KeepAlive), nhưng gần như chưa được thiết kế cho **người dùng mới**:

- **Đường cài chính trong README (`curl … | bash`) bị hỏng ở mọi câu hỏi tương tác**, vì `read` đọc từ stdin — mà stdin lúc đó chính là nội dung script.
- **Secret gõ vào bị hiện rõ trên màn hình**, rồi mới in `****`.
- **Ghép hai máy là việc thủ công, có bẫy**: copy token bằng tay, enrol peer hai chiều bằng tay, và chạy lại `aibr setup` thì mặc định *sinh token mới*, làm hỏng máy bên kia mà không cảnh báo.
- **Có hai cách chạy daemon mâu thuẫn nhau** (`aibr start` qua tmux theo README, và unit launchd/systemd mà wizard đề nghị bật, chạy `aibr worker` của luồng router).
- **Không có cách nào kiểm tra "chạy được chưa" từ đầu đến cuối** ngoài tự viết `curl` với JSON 9 trường.

Ước tính hiện tại, từ máy trắng đến job đầu tiên trên hai máy: **khoảng 25 thao tác thủ công**, khoảng **12–15 câu hỏi wizard mỗi máy**, và **ít nhất 1 lần chạy lại setup**. Mục tiêu đề xuất: **≤ 3 lệnh mỗi máy, ≤ 4 câu hỏi, 0 lần copy secret bằng tay**.

## 2. Hành trình hiện tại của người dùng mới (2 máy)

| # | Việc người dùng phải làm | Ghi chú |
|---|---|---|
| 1–4 | Tự cài Bun, tmux, OpenCode, Tailscale, rồi `tailscale up` | installer chỉ *báo thiếu*, không cài (§3 H2) |
| 5 | `curl … \| bash` | prompt bị hỏng nếu không có `--yes` (§3 C1) |
| 6 | Tự sửa `PATH` nếu `aibr` không tìm thấy | installer chỉ in gợi ý |
| 7 | Bỏ qua cảnh báo `aibr-router not found` + hướng dẫn `cargo build` | không cần cho chế độ mặc định (§3 H3) |
| 8 | Máy A: `aibr setup --profile <name>` — khoảng 12 câu hỏi | §3 M1 |
| 9 | Copy token 64 ký tự in trên màn hình máy A | token nằm lại trong scrollback |
| 10 | Máy B: `aibr setup`, chọn **P**aste, dán token | token dán vào bị echo (§3 C2) |
| 11 | Máy B: enrol A bằng tay (id, url, capabilities) | A chưa chạy bridge nên discovery không nhận ra |
| 12 | Máy A: **chạy lại** `aibr setup` để enrol B | Overwrite? → token mặc định *Generate* → hỏng B (§3 C3) |
| 13 | Mỗi máy: `aibr start` rồi `aibr status` | hoặc chọn "Start the daemon now?" của wizard — hai luồng khác nhau (§3 H1) |
| 14 | Thử job đầu tiên bằng `curl` + JSON tự viết, đúng `project_dir` tuyệt đối | không có lệnh CLI nào làm việc này (§3 H4) |

## 3. Phát hiện

### Nghiêm trọng

**C1. `curl | bash` làm hỏng mọi câu hỏi tương tác** — [theo code]
`confirm()` (`scripts/install.sh:17-22`) và câu hỏi cài Bun (`install.sh:106-107`) dùng `read -r ans`. Khi chạy `curl … | bash`, stdin là chính script, nên `read` nuốt dòng script kế tiếp làm "câu trả lời". Kết quả: câu trả lời không phải `y`, nên bị coi là từ chối ("Aborted: bun is required"), và bash bỏ qua mất một dòng script. Riêng câu hỏi cài Bun còn **bỏ qua `--yes`**.
→ Sửa: đọc từ `/dev/tty` (`read -r ans < /dev/tty`). Nếu không có TTY và không có `--yes` thì dừng với thông báo rõ ràng. Câu hỏi Bun phải tôn trọng `--yes`. Thêm test chạy `cat install.sh | bash` không có TTY, kiểm tra script không treo và không nuốt dòng.

**C2. Secret bị hiện rõ trên màn hình** — [quan sát + theo code]
`BunPrompter.promptSecret` (`src/host/runtime.ts:206-214`) ở chế độ thật chỉ `readLine()` rồi in `*`. Comment nói "characters are hidden by the terminal's echo suppression", nhưng không có chỗ nào tắt echo (`setRawMode` không được gọi). Khi chạy thử, mật khẩu OpenCode hiện nguyên văn, sau đó mới tới `************`. Áp dụng cho cả bearer token khi chọn **P**aste.
→ Sửa: bật raw mode / tắt echo trong lúc đọc secret, và có test bằng pseudo-TTY.

**C3. Chạy lại `aibr setup` âm thầm đổi token** — [theo code]
Chạy lại trên profile đã có thì hỏi "Overwrite?". Sau đó lựa chọn token mặc định (Enter) là **Generate**, nên token mới được ghi đè, và mọi peer đang dùng token cũ nhận 401. Mà theo bước 11–12 ở §2, người dùng *buộc phải* chạy lại setup để enrol peer.
→ Sửa: chạy lại = chế độ "sửa", mặc định **giữ** token hiện có; đổi token chỉ qua lựa chọn tường minh (`--rotate-token`) kèm cảnh báo "peer X, Y sẽ mất kết nối". Lâu dài: thay bằng pairing (§4.2).

### Cao

**H1. Hai cách chạy daemon mâu thuẫn nhau** — [theo code; đã quan sát wizard ghi unit]
README và `getting-started` hướng dẫn `aibr start`: tmux chạy `opencode` + `aibr serve` ở chế độ engine. Còn Step 5 của wizard ghi một unit launchd/systemd chạy `aibr worker --profile … --ipc-publish` (`src/host/daemonizer.ts:39`) và hỏi "Start the daemon now?". Worker là luồng *drain hàng đợi router*, cần `aibr-router` và `AIBRIDGE_INGRESS_OUTBOX` — mà mặc định không cài cái nào. Nếu người dùng chọn `y`, họ có một unit KeepAlive chạy song song với luồng tmux mà README dạy. Thêm nữa, lệnh gợi ý là `launchctl load -w`, cú pháp đã deprecated trên macOS hiện đại.
→ Sửa: mỗi nền tảng chỉ một cách chạy mặc định (xem §4.3). Unit của wizard phải chạy cùng thứ mà `aibr start` chạy.

**H2. Installer không cài prerequisite, lại còn gợi ý lệnh sai** — [theo code]
- Hàm `install_missing_prereqs` (`install.sh:80-91`) được định nghĩa nhưng **không bao giờ được gọi** trong `main`.
- Lệnh gợi ý cài Tailscale cho Debian/Ubuntu là `tailscale install-from-source --confirm --prefix=/usr/local` (`install.sh:58`). Lệnh này không có trong CLI Tailscale theo những gì tôi biết, và không có `tailscale` thì cũng không chạy được nó. Fallback `apt-get install -y tailscale` sẽ fail nếu chưa thêm repo của Tailscale.
- Thiếu `opencode` chỉ in ✗ rồi cài tiếp. Người dùng đi hết installer, rồi mới bị `aibr setup` chặn ở preflight (`src/host/preflight.ts:132`). Lỗi phát hiện muộn.
- `--with-units` dùng `$(dirname "${BASH_SOURCE[0]}")/../packaging`. Chạy qua `curl | bash` thì không có thư mục repo, và `packaging/` cũng không nằm trong `files` của npm package. Cờ này chỉ chạy được từ một bản checkout.

**H3. Cảnh báo router làm người mới hoảng** — [theo code]
Mọi lần cài đều in `⚠ aibr-router not found` kèm hướng dẫn `cargo build`, dù chế độ mặc định (`ingress_mode: "engine"`) không cần router. Nên ẩn đi, chỉ hiện khi có `--ingress router`.

**H4. Không có cách kiểm tra đầu-cuối** — [quan sát]
- Job đầu tiên phải tự viết `curl` với 9 trường JSON, `project_dir` phải khớp chính xác đường dẫn đã allowlist, `callback_url` trỏ về bridge của máy gửi.
- `aibr status` "healthy" chỉ chứng minh `/health` trả lời (skill `debugging-aibr-v2` cũng ghi điều này). `/health` trả `"capabilities": []` khi chưa enrol peer nào, nhưng không có gì giải thích vì sao đó là vấn đề.
- Không có lệnh kiểm "máy A gửi được việc tới máy B".

**H5. `aibr start` báo thành công mà không kiểm tra** — [theo code; quan sát một phần]
`aibr start` in "Started tmux session" ngay sau khi tạo session. Nếu tiến trình trong cửa sổ chết, cửa sổ biến mất cùng thông báo lỗi (không có `remain-on-exit`, không có file log). Khi tôi chạy thử, cả hai cửa sổ đều biến mất. Nguyên nhân ở lần đó là môi trường test cô lập HOME của tôi, không phải lỗi sản phẩm: chạy `aibr serve` trực tiếp thì `/health` trả 200. Nhưng chính vì thế người dùng thật sẽ không có manh mối nào khi gặp lỗi tương tự. `aibr serve` cũng không in log nào ra stdout trong 20 giây chạy.

### Trung bình

**M1. Wizard hỏi những câu người mới không trả lời được** — [quan sát]
Thứ tự thực tế: đường dẫn file config (default dài hơn 150 ký tự) → chế độ token → "nhấn Enter để tiếp tục" → **mật khẩu OpenCode** (phải tự nghĩ ra, không có lựa chọn sinh tự động) → agent ID → đường dẫn project → chọn peer → cổng bridge → cổng OpenCode → lưu? → bật daemon?
- Đường dẫn config, agent ID, hai cổng: nên lấy default và đưa vào `--advanced`.
- Project path mặc định là thư mục hiện tại. Chạy `aibr setup` từ `~` thì **cả thư mục home bị allowlist**. Nên mặc định lấy git root, và từ chối `$HOME` và `/`.
- Chỉ allowlist được **một** project. Capability của project bị gán cứng `["development","orchestration"]`, trong khi ví dụ trong README gửi `capability: "testing"`.

**M2. Phần discovery quá dài và nhiễu** — [quan sát]
Wizard in ba khối liên tiếp (bảng discovery, một đoạn khoảng 90 từ về "reachability is not authentication", rồi danh sách peer lặp lại), và liệt kê cả iPhone trên tailnet như một peer có thể enrol. Nên chỉ liệt kê máy trả lời `/health` là AIBridge; các máy khác gộp thành một dòng "N thiết bị khác".

**M3. Nhấn Enter ở "Save configuration?" là mất hết** — [quan sát]
Enter được hiểu là `n` → "Setup declined.", và mọi câu trả lời trước đó bị bỏ. Câu cuối cùng nên mặc định `Y`, hoặc ít nhất hỏi lại.

**M4. Tài liệu mô tả một UI không tồn tại** — [theo code]
Docs và header của file nói về "Interactive 5-Step TUI stepper" với phím tắt và chuột. Nhưng `runSetupWizard` luôn gọi `runHeadlessWizard`: biến `isInteractiveTty` được tính rồi không dùng (`setup-wizard.ts:543`), `StepperFSM` không được dùng. Người dùng thấy một chuỗi câu hỏi dòng lệnh.

**M5. Trợ giúp của CLI** — [quan sát]
`aibr setup --help` in help chung, không có help riêng cho từng lệnh. `verify` được mô tả là "Validate dependencies, **SSL token**…" (không có SSL nào). Cuối `aibr setup` không in "bước tiếp theo" (chỉ in "Profile created" và trạng thái daemon).

**M6. PATH** — [theo code]
Nếu thư mục bin của Bun không nằm trong `PATH`, installer chỉ in một dòng gợi ý, rồi cuối cùng vẫn bảo người dùng chạy `aibr setup` — lệnh sẽ báo "command not found".

### Thấp
- `install.sh --version` in `2.0.0`, package là `3.0.0`.
- Installer lấy từ nhánh `main` nhưng cài bản npm `latest`, nên hai bên có thể lệch nhau.
- Linux không phải Debian/Ubuntu bị coi là Ubuntu mà không báo.
- Bắt buộc cài Bun cho người chỉ muốn dùng `aibr`, trong khi repo đã có `package:binaries`. Có thể phát hành binary độc lập sau này.

## 4. Trải nghiệm mục tiêu

### 4.1 Ba lệnh mỗi máy
1. `curl -fsSL …/install.sh | bash`: cài `aibr`, đề nghị cài các prerequisite còn thiếu theo vai trò (có hỏi xác nhận qua `/dev/tty`), tự sửa `PATH` (có hỏi), rồi **tự chạy luôn bước 2** nếu có TTY.
2. `aibr init` (quickstart, tối đa 4 câu hỏi):
   1. Máy này làm gì? `worker` / `orchestrator` (Claude Code giao việc) / `both`
   2. Runtime: tự phát hiện `opencode` / `claude`, chỉ hỏi khi có cả hai
   3. Thư mục project: mặc định git root của thư mục hiện tại; từ chối `$HOME`
   4. "Tạo mạng mới" hay "Tham gia bằng mã ghép nối"

   Mọi thứ khác (cổng, đường dẫn config, agent id, mật khẩu OpenCode tự sinh, chế độ auth) có default an toàn. `aibr setup --advanced` giữ wizard đầy đủ như hiện nay.
3. `aibr doctor`: gộp `verify`, `status` và `discover` thành một danh sách ✓/✗, mỗi dòng ✗ kèm **lệnh sửa cụ thể**, và cuối cùng là một lần `ping` đầu-cuối.

### 4.2 Ghép nối thay cho copy token
- Máy A: `aibr pair` in một mã ngắn, dùng một lần, có hạn ngắn (lib `src/mesh/identity/enrollment-code.ts` đã có).
- Máy B: `aibr pair <mã>`. Hai máy trao đổi public key qua tailnet và pin lẫn nhau (`peer-key-pins.ts`), rồi **cả hai** tự ghi `agents[]` và `allowed_sources[]` cho nhau với cùng một capability.
- Cách này xoá đồng thời C3, bước 9–12 ở §2, và bài toán con gà–quả trứng khi enrol. Nó cũng chính là "mặt UX" của Phase 3 (danh tính ed25519) trong plan Claude: làm một lần, dùng cho cả hai mục tiêu.
- Bearer token vẫn tồn tại cho tương thích ngược, nhưng không còn là con đường mặc định.

### 4.3 Một cách chạy duy nhất cho mỗi nền tảng
- `aibr start`: cài và load **user service** (launchd LaunchAgent trên macOS, systemd `--user` trên Linux), chạy đúng thứ mà tmux đang chạy (engine mode). Dừng bằng `aibr stop`.
- `aibr start --foreground` (hoặc `--tmux`): cho phát triển và debug.
- Router/worker chỉ bật khi chọn `--ingress router` ở chế độ advanced. Installer chỉ nhắc tới router khi người dùng hỏi tới.
- Ghi log ra file trong state dir; thêm `aibr logs [-f]`; đặt `remain-on-exit` cho chế độ tmux.

### 4.4 Lệnh kiểm tra và giao việc đầu tiên
- `aibr ping <peer>`: gửi một job no-op đã ký tới peer và chờ callback. Đây là bằng chứng duy nhất đáng tin rằng hai máy làm việc với nhau được.
- `aibr send <peer> "<prompt>" [--capability …] [--project …]`: thay cho `curl` trong README; tự điền `source_agent_id`, `callback_url`, `project_dir`.
- Với vai trò orchestrator thì Claude Code plugin làm việc này (xem review §3).

### 4.5 Sửa nhanh trong installer và wizard
- `/dev/tty` cho mọi câu hỏi; `--yes` áp dụng cho mọi câu hỏi; không có TTY và không có `--yes` thì dừng rõ ràng.
- Gọi `install_missing_prereqs` (có hỏi xác nhận); dùng link cài chính thức của Tailscale; kiểm runtime ngay trong installer, không đợi tới preflight.
- Secret: tắt echo; tự sinh mật khẩu OpenCode; không in token ra màn hình khi đã có pairing.
- Chạy lại setup: mặc định giữ token; câu "Save?" mặc định `Y`; luôn in "bước tiếp theo".
- Help cho từng lệnh; sửa mô tả "SSL token"; `--version` của installer lấy từ package.

## 5. Lộ trình đề xuất

| Đợt | Nội dung | Ước lượng | Giải quyết |
|---|---|---|---|
| **A. Sửa nhanh** | C1, C2, C3, M3, M5, M6, H2 (gọi hàm cài, sửa lệnh Tailscale, fail sớm), H3, version | 1–2 ngày | Các lỗi chặn người dùng mới |
| **B. Quickstart** | `aibr init` ≤ 4 câu hỏi, project default theo git root, `aibr doctor`, `aibr logs`, sửa docs (M4) | 3–4 ngày | M1, M2, M4, H5 |
| **C. Một cách chạy** | `aibr start`/`stop` = user service; tmux thành `--foreground`; wizard không ghi unit `worker` nữa | 2 ngày | H1 |
| **D. Ghép nối & kiểm tra** | `aibr pair`, `aibr ping`, `aibr send` | 3–5 ngày, gộp với Phase 3 của plan Claude | bước 9–14 ở §2, C3 tận gốc, H4 |
| **E. Vai trò orchestrator** | `--role`, preflight theo vai trò, `aibr plugin install claude` | xem review §3, bước I1 | user Claude Code |

**Kiểm thử để không thoái lui:**
- Test installer chạy `cat install.sh | bash` không có TTY.
- Test pseudo-TTY cho `promptSecret` (không echo).
- **Smoke test hai profile trên cùng một máy** (hai cổng khác nhau: init → pair → ping) chạy trong CI. Đây là thứ gần nhất với "người dùng mới cài lần đầu" mà CI chạy được.
