# PChess — Cờ Vua P2P Multiplayer

PChess là web game cờ vua 2 người chơi qua P2P (PeerJS/WebRTC), không cần server game riêng, không cần đăng nhập.

## 🚀 Tính năng chính

- **P2P Real-time**: Kết nối trực tiếp 2 trình duyệt qua WebRTC
- **Session/Link phòng**: Host tạo phòng → sinh link → đối thủ mở link vào chơi ngay
- **Luật cờ đầy đủ**: Nhập thành, bắt tốt qua đường, phong cấp, chiếu, chiếu hết, hòa
- **Anti-cheat nhẹ**: Validate nước đi bằng chess.js ở cả 2 phía
- **Chơi lại (Rematch)**: Reset ván mới trong cùng session, không cần tạo phòng mới
- **4 Theme**: Classic, Wood, Midnight, Forest
- **Âm thanh**: Web Audio API tự tạo (move, capture, check, checkmate, castle, promote)
- **Timer**: Tùy chọn 3/5/10/15 phút hoặc không giới hạn
- **Responsive**: Chơi được trên desktop và mobile

## 📁 Cấu trúc thư mục

```
pchess/
├── index.html          # Giao diện chính (landing, lobby, game, modals)
├── css/
│   └── style.css       # Styling + 4 theme + responsive
├── js/
│   └── app.js          # Logic game, PeerJS, chess.js, sound, timer
└── README.md           # Hướng dẫn này
```

## 🛠️ Chạy local

### Cách 1: Mở trực tiếp (đơn giản)
```bash
cd pchess
# Mở file index.html bằng trình duyệt
# Hoặc dùng Python simple server:
python -m http.server 8080
# Truy cập http://localhost:8080
```

### Cách 2: VS Code Live Server
1. Mở thư mục `pchess` trong VS Code
2. Cài extension **Live Server**
3. Click "Go Live" — trình duyệt sẽ mở tự động

> **Lưu ý**: Vì dùng PeerJS cloud server, bạn **cần kết nối Internet** để tạo/join phòng. Gameplay sau khi kết nối là P2P hoàn toàn.

## 🌐 Deploy lên Static Hosting

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

## ⚠️ Lưu ý kỹ thuật

### Giới hạn do không có backend

1. **PeerJS Cloud Server**: Dùng server signaling miễn phí của PeerJS (`0.peerjs.com`). Trong môi trường production, bạn nên:
   - Tự host [PeerServer](https://github.com/peers/peerjs-server) hoặc
   - Dùng dịch vụ TURN/STUN để cải thiện kết nối qua NAT

2. **Reconnect**: Nếu refresh trang, session sẽ bị mất (vì không có server lưu trữ). Tuy nhiên:
   - Host có thể tạo lại phòng cùng ID (nếu peer chưa timeout)
   - SessionStorage giúp reconnect nhanh trong cùng tab session

3. **Anti-cheat**: Chỉ ở mức client-side validation. Đối với game casual P2P là đủ, nhưng không chống được người chơi sửa code trình duyệt.

4. **Mất kết nối**: Nếu 1 bên mất kết nối > 30s, PeerJS cloud sẽ xóa peer ID. Cần tạo phòng mới.

## 🧩 Dependencies (CDN)

- [chess.js](https://github.com/jhlywa/chess.js) — Engine cờ vua
- [PeerJS](https://peerjs.com/) — WebRTC P2P connection

## 📜 License

MIT — Tự do sử dụng, chỉnh sửa và deploy.
