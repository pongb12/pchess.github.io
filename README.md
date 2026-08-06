# PChess — Cờ Vua Multiplayer

PChess là web game cờ vua 2 người chơi qua **WebSocket relay** chạy trên **Cloudflare Durable Objects**. Server là nguồn sự thật (server-authoritative): mọi nước đi được validate bằng chess.js ngay trên server, chống gian lận kiểu sửa code trình duyệt.

## 🚀 Tính năng chính

- **Real-time qua WebSocket**: Kết nối ổn định qua relay server (Cloudflare Workers + Durable Objects), không phụ thuộc NAT/TURN như WebRTC
- **Session/Link phòng**: Host tạo phòng → sinh link ngắn (`#code`) → đối thủ mở link vào chơi ngay
- **Luật cờ đầy đủ**: Nhập thành, bắt tốt qua đường, phong cấp, chiếu, chiếu hết, hòa
- **Server-authoritative / Anti-cheat**: 
  - Nước đi được validate bằng chess.js **trên server**
  - Server giữ FEN + lịch sử nước đi, client chỉ hiển thị
  - Chặn đi sai lượt, đi quân của đối thủ, nước bất hợp lệ, spam (rate limit)
  - `move_rejected` trả về khi nước đi bị từ chối
- **Tự đồng bộ / Nối lại ván dở**: Refresh trang hoặc mất mạng → tự kết nối lại phòng và khôi phục ván cờ từ server
- **Chơi lại (Rematch)**: Reset ván mới trong cùng phòng
- **4 Theme**: Classic, Wood, Midnight, Forest
- **Âm thanh**: Web Audio API tự tạo (move, capture, check, checkmate, castle, promote)
- **Timer**: Tùy chọn 3/5/10/15 phút hoặc không giới hạn
- **Responsive**: Chơi được trên desktop và mobile

## 📁 Cấu trúc thư mục

```
pchess/
├── index.html              # Giao diện chính (landing, lobby, game, modals)
├── css/
│   └── style.css           # Styling + 4 theme + responsive
├── js/
│   └── app.js              # Logic game, WebSocket client, chess.js, sound, timer
├── worker/                 # Cloudflare Worker (relay + validate)
│   ├── wrangler.toml       # Config Durable Object binding
│   ├── package.json
│   └── src/
│       └── index.ts        # PChessRoom Durable Object (WebSocket relay + chess.js)
└── README.md               # Hướng dẫn này
```

## 🛠️ 1. Deploy Worker (BẮT BUỘC — app cần server để chơi)

App không còn dùng PeerJS nữa; mọi kết nối đi qua relay Worker. Cần deploy 1 lần:

```bash
cd worker
npm install
npx wrangler login       # đăng nhập Cloudflare (mở trình duyệt)
npx wrangler deploy
```

Sau khi deploy, Cloudflare in ra URL dạng:
`https://pchess-worker.<subdomain>.workers.dev`

**Dán URL đó vào `js/app.js`**:

```js
// js/app.js
const CONFIG = {
    WS_URL: 'wss://pchess-worker.<subdomain>.workers.dev',
    ...
};
```

> Nhớ dùng `wss://` (không phải `https://`) cho kết nối WebSocket.

### Test local (không cần deploy)

```bash
cd worker
npx wrangler dev --port 8787
# mở index.html, sửa WS_URL tạm thời thành ws://127.0.0.1:8787 để chơi thử
```

## 🌐 2. Deploy Static Site

### GitHub Pages
1. Push code lên repo GitHub
2. Settings → Pages → Source: Deploy from branch → chọn `main` / `root`
3. Truy cập `https://<username>.github.io/pchess`

### Netlify / Vercel / Cloudflare Pages
1. Kéo thả thư mục `pchess` lên dashboard
2. Hoặc connect với Git repo
3. Site sẽ được deploy tự động

> PChess là **static site thuần** (HTML/CSS/JS), không cần build step.

## 🎮 Cách chơi

1. **Tạo phòng**: Click "Tạo phòng mới" → hệ thống sinh link
2. **Copy link**: Bấm nút copy bên cạnh link → gửi cho đối thủ (Messenger, Zalo, v.v.)
3. **Vào phòng**: Đối thủ mở link — tự động vào phòng, không cần nhập code
4. **Chơi cờ**: Host (Trắng) đi trước, Guest (Đen) đi sau
5. **Chơi lại**: Sau khi kết thúc, bấm "🔄 Chơi lại" — cả 2 đồng ý là ván mới bắt đầu ngay

## ⚙️ Cài đặt

Bấm nút ⚙️ để mở Settings:

- **Theme**: Classic / Wood / Midnight / Forest
- **Phong cấp**: Tự động Hậu / Luôn hỏi (Hậu/Xe/Tượng/Mã)
- **Âm thanh**: Bật/tắt
- **Hiệu ứng**: Animation + Tọa độ bàn cờ
- **Timer**: Không giới hạn / 3/5/10/15 phút

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
                 - lưu FEN + lịch sử (SQLite)
                           ▲
Trình duyệt B ──WebSocket──┘
```

**Protocol chính** (JSON):
| Message | Ý nghĩa |
|---|---|
| `joined {role, color, game}` | Server báo vai trò + màu + ván dở (nếu có) |
| `peer_joined` / `peer_left` | Đối thủ vào / rời phòng |
| `init` | Host gửi cấu hình cho Guest khi bắt đầu |
| `move {from,to,promotion}` | Client gửi nước đi → server validate |
| `move {san, fen}` | Server broadcast nước đi hợp lệ tới cả 2 |
| `move_rejected {reason}` | Nước đi bị từ chối (illegal / not_your_turn / rate_limit) |
| `sync_request` / `sync` | Đồng bộ trạng thái (server trả FEN + lịch sử) |
| `ping` / `pong` | Heartbeat + đo ping |
| `resign`, `draw_offer/accept/decline`, `rematch_*`, `game_over` | Relay verbatim |

## 📜 License

MIT — Tự do sử dụng, chỉnh sửa và deploy.
