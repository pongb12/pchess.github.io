# PChess — Cờ Vua Multiplayer

PChess là web game cờ vua 2 người chơi qua **WebSocket relay** chạy trên **Cloudflare Durable Objects**. Server là nguồn sự thật (server-authoritative): mọi nước đi được validate bằng chess.js ngay trên server, chống gian lận kiểu sửa code trình duyệt.

## 🚀 Tính năng chính

- **Real-time qua WebSocket**: Kết nối ổn định qua relay server (Cloudflare Workers + Durable Objects), không phụ thuộc NAT/TURN như WebRTC
- **Session/Link phòng**: Host tạo phòng → sinh link ngắn (`#code`) → đối thủ mở link vào chơi ngay
- **Luật cờ đầy đủ**: Nhập thành, bắt tốt qua đường, phong cấp, chiếu, chiếu hết, hòa
- **Server-authoritative / Anti-cheat nâng cao**:
  - Nước đi được validate bằng chess.js **trên server**
  - Server giữ FEN + lịch sử nước đi (SQLite), client chỉ hiển thị
  - Chặn đi sai lượt, đi quân của đối thủ, nước bất hợp lệ, spam (rate limit)
  - **Audit log**: ghi lại timestamp mỗi nước đi, sự kiện join/leave/reconnect/takeover/rematch/resign/draw (lưu trong SQLite của DO, tối đa 500 entry cuối)
  - **Heuristic phát hiện engine-like**: flag `fast_move_streak` (4+ nước liên tiếp < 200ms) và `uniform_move_timing` (stddev < 50ms cho 8+ nước) — audit-only, không chặn realtime
  - **Signed events (HMAC-SHA256)**: các message critical (`joined`, `sync`, `move`, `game_over`, `draw_accept`) được ký bằng secret key (env `EVENT_SIGNING_SECRET` hoặc per-room derived key) — client không thể giả mạo
  - **Rate limit IP**: chống flood tạo phòng (20 phòng/phút/IP) và reconnect (30 lần/phút/IP)
  - **Rematch state machine rõ ràng** (fix bug): `idle → requested → accepted_by_<role> → accepted_by_both → reset game`. Trước đây server xóa game ngay khi nhận 1 accept, gây lệch state; bây giờ chỉ reset khi CẢ HAI đã accept
  - `move_rejected` trả về khi nước đi bị từ chối
- **Tự đồng bộ / Nối lại ván dở**: Refresh trang hoặc mất mạng → tự kết nối lại phòng và khôi phục ván cờ từ server
- **Sync banner**: khi reconnect, hiển thị "Đang khôi phục ván cờ..." trong vài giây thay vì nhảy trạng thái âm thầm. Server tự gửi `sync_banner` + `sync` ngay khi WS mở lại, không phụ thuộc logic hồi phục rải rác ở client
- **Connection banner phân biệt rõ 4 trạng thái**: mất mạng tạm thời (cam) / phòng đầy (đỏ) / phiên bị takeover (tím) / đối thủ rời phòng (đỏ)
- **Chơi lại (Rematch)**: Reset ván mới trong cùng phòng, chỉ khi cả hai đồng ý (state machine rõ ràng)
- **4 Theme**: Classic, Wood, Midnight, Forest
- **Âm thanh**: Web Audio API tự tạo (move, capture, check, checkmate, castle, promote)
- **Timer**: Tùy chọn 3/5/10/15 phút hoặc không giới hạn
- **Responsive**: Chơi được trên desktop và mobile, mobile có tab panel (Nước đi / Quân ăn / Kết nối) thay vì sidebar

## 🎨 UX/UI nổi bật

- **Trạng thái ván cờ prominent**: "Đến lượt bạn" (xanh, pulse), "Đang chờ đối thủ" (xám), "Đang bị chiếu" (đỏ, pulse), "Mất kết nối" (cam), "Kết thúc" (xám) — có màu và hành vi rõ, không chỉ là text nhỏ
- **Move indicators strip**: hiển thị trực diện nước vừa đi (SAN), chip "Chiếu" / "Ăn quân" / "Đang chờ phong cấp"
- **Move preview khi rê quân**: ghost piece ở ô đích + highlight nước hợp lệ (chấm tròn lớn trên mobile, viền đỏ khi ăn quân)
- **Flip board**: nút lật bàn cờ xem từ góc nhìn đối thủ (cả trong game và analysis)
- **Keyboard shortcuts**:
  - Trong game: `F` = flip board, `Esc` = bỏ chọn quân, `Enter` = xác nhận promotion/rematch/draw trong modal
  - Trong analysis: `←/→` = lùi/tiến nước, `Home/End` = đầu/cuối, `Space` = play/pause replay, `F` = flip board

## 🔍 Phân tích ván cờ (Stockfish 18)

- **Multi-PV 1-2-3**: hiển thị 3 đường tốt nhất kèm eval và move list cho mỗi line
- **Giải thích nhãn**: mỗi nhãn (Brilliant / Great / Best / Excellent / Good / Book / Inaccuracy / Mistake / Missed / Blunder) có 1-2 câu giải thích người thường đọc được
- **Opening name**: gọi tên khai cuộc (Ruy Lopez, Sicilian Najdorf, French Defense, ... + 30 phổ biến)
- **Eval theo phase**: tách eval chart thành 3 giai đoạn Opening / Middlegame / Endgame với trung bình eval từng phase
- **Review mode**: sau ván, nút "⭐ Điểm ngoặt" hiển thị top 3 khoảnh khắc quyết định (delta lớn nhất) kèm lý do + nút "Xem nước này"
- **Nút "Tại sao"**: popup nhỏ giải thích nước này tại sao tốt/tệ ("rớt X% thắng", "có nước rõ ràng tốt hơn: ...")
- **Replay scrub bar**: thanh trượt, jump theo nước, autoplay play/pause (Space)
- **Undo local analysis**: lùi 1 nước trong chế độ phân tích cục bộ (không ảnh hưởng multiplayer)
- **Flip board 2 màu**: xem board từ góc nhìn của cả Trắng và Đen khi phân tích

## 📁 Cấu trúc thư mục

Một Worker duy nhất vừa phục vụ trang tĩnh vừa làm relay WebSocket:

```
pchess/
├── public/                  # Static assets được serve bởi Worker
│   ├── index.html           # Giao diện chính (landing, lobby, game, analysis, modals)
│   ├── css/style.css        # Styling + 4 theme + responsive + new UI
│   ├── js/app.js           # Logic game, WebSocket client, chess.js, sound, timer, analysis
│   └── stockfish/           # Stockfish 18 lite (WASM)
├── index.html              # Bản đồng bộ với public/index.html
├── js/app.js               # Bản đồng bộ với public/js/app.js
├── css/style.css           # Bản đồng bộ với public/css/style.css
├── src/
│   └── index.ts            # PChessRoom Durable Object (WS relay + chess.js + anti-cheat)
├── lib/
│   └── chess.js            # chess.js 0.13.4 (bản ESM, vendor để build không cần npm)
├── wrangler.toml           # Config Worker: tên pchess-github-io + DO + static assets
├── package.json            # Dev deps (wrangler) — không cần cho production
└── README.md               # Hướng dẫn này
```

## 🌐 Deploy (Workers Builds — tự động khi push)

Repo được kết nối sẵn với **Cloudflare Workers Builds** (project `pchess-github-io`), build command là `npx wrangler deploy` chạy ở thư mục gốc. **Chỉ cần `git push` — mọi thứ tự deploy.**

URL của app + relay: `https://pchess-github-io.st163943.workers.dev`

### Deploy lần đầu bằng tay (nếu cần)

```bash
npx wrangler login
npx wrangler deploy        # chạy ở thư mục gốc
```

> Trong `public/js/app.js`, `CONFIG.WS_URL` đã trỏ đúng relay. Nếu deploy sang project khác, đổi `wrangler.toml` (`name`) và `WS_URL` cho khớp.

### Tùy chọn: Signed events secret

Để bật signed events mạnh hơn (chống giả mạo cross-room), set biến môi trường `EVENT_SIGNING_SECRET` trong Cloudflare Worker (Settings > Variables). Nếu không set, server fallback về per-room derived key (vẫn chống giả mạo nhưng không mạnh bằng).

### Test local

```bash
npx wrangler dev --port 8787
# Mở http://127.0.0.1:8787 — trang tĩnh + relay chạy chung trên cùng port
```

## 🎮 Cách chơi

1. **Tạo phòng**: Click "Tạo phòng mới" → hệ thống sinh link
2. **Copy link**: Bấm nút copy bên cạnh link → gửi cho đối thủ (Messenger, Zalo, v.v.)
3. **Vào phòng**: Đối thủ mở link — tự động vào phòng, không cần nhập code
4. **Chơi cờ**: Host (Trắng) đi trước, Guest (Đen) đi sau
5. **Chơi lại**: Sau khi kết thúc, bấm "🔄 Chơi lại" — cả 2 đồng ý (state machine rõ ràng) là ván mới bắt đầu

## ⚙️ Cài đặt

Bấm nút ⚙️ để mở Settings:

- **Theme**: Classic / Wood / Midnight / Forest
- **Phong cấp**: Tự động Hậu / Luôn hỏi (Hậu/Xe/Tượng/Mã)
- **Âm thanh**: Bật/tắt
- **Hiệu ứng**: Animation + Tọa độ bàn cờ
- **Timer**: Không giới hạn / 3/5/10/15 phút
- **Stockfish**: Auto / Lite (~7MB) / Full (~108MB, tự tải về và lưu trong IndexedDB)

## 🐞 Debug

Bấm nút **🐞** góc dưới để mở Debug Panel:
- Trạng thái WebSocket (CONNECTING/OPEN/CLOSED), Role, Color, Room code, Ping
- Log đầy đủ mọi message gửi/nhận
- Nút **Reconnect WS** để thử kết nối lại
- Nút **📋** để copy toàn bộ log (dán khi báo lỗi)

## 🧩 Kiến trúc

```
Trình duyệt A ──WebSocket──┐
                           ▼
                 PChessRoom (Durable Object)
                 - relay message giữa 2 người
                 - validate nước đi bằng chess.js
                 - lưu FEN + lịch sử + audit log (SQLite)
                 - anti-cheat heuristic (fast/uniform move timing)
                 - signed events (HMAC-SHA256)
                 - rematch state machine
                           ▲
Trình duyệt B ──WebSocket──┘
```

**Protocol chính** (JSON, các message critical có `sig` HMAC):
| Message | Ý nghĩa |
|---|---|
| `joined {role, color, game, rematch, reconnect, sig}` | Server báo vai trò + màu + ván dở (nếu có) + trạng thái rematch |
| `peer_joined` / `peer_left {reason}` | Đối thủ vào / rời phòng (server phân biệt `disconnect`) |
| `init` | Host gửi cấu hình cho Guest khi bắt đầu |
| `move {from,to,promotion, san, fen, ts, sig}` | Server broadcast nước đi hợp lệ tới cả 2 (có HMAC sig) |
| `move_rejected {reason, ts}` | Nước đi bị từ chối (illegal / not_your_turn / rate_limit) |
| `sync_banner {state: 'restoring'}` | Server báo đang khôi phục ván cờ (reconnect) |
| `sync {fen, history, captured, turn, ts, source, sig}` | Server gửi full state (source: `reconnect` hoặc `request`) |
| `rematch_request {by, ts}` | Yêu cầu chơi lại từ role `by` |
| `rematch_accept_partial {by, status, ts}` | Một bên đã accept, chờ bên kia |
| `rematch_accept {by, ts}` | Broadcast khi cả hai đã accept — client reset game |
| `rematch_decline {by, ts}` | Một bên từ chối |
| `cheat_flagged {role, reason, ts}` | Heuristic flag (audit-only, không chặn) |
| `session-takeover` | Phiên bị thay thế (mở ở nơi khác) |
| `room-full` | Phòng đã đủ 2 người |
| `ping` / `pong` | Heartbeat + đo ping |
| `resign`, `draw_offer/accept/decline`, `game_over` | Relay verbatim (game_over + draw_accept có sig) |

## 📜 License

MIT — Tự do sử dụng, chỉnh sửa và deploy. (chess.js — BSD-2-Clause, file vendored tại `lib/chess.js`.)



