# FB_API

Nhiều Chrome profile (mỗi profile = 1 tài khoản Facebook quản lý 1 Page) cùng cài extension, mỗi extension đăng ký với server nó phụ trách `pageId` nào. Server dùng cookie/session realtime lấy từ đúng extension phụ trách để gọi Facebook (đăng post lên Page, lấy link share).

## Kiến trúc

```
Extention_API/   Chrome extension (Manifest V3) — 1 bản cài trên nhiều Chrome profile, mỗi profile phụ trách 1 pageId
Server_API/      Node.js + Express server — registry pageId -> extension, routing/round-robin/failover, cầu nối HTTP <-> WebSocket
```

**Lưu ý quan trọng**: cookie trong Chrome dùng chung theo profile, không theo tab — muốn nhiều tài khoản Facebook khác nhau phải dùng **nhiều Chrome profile** (mỗi profile 1 `--user-data-dir` riêng), không phải nhiều tab trong cùng 1 profile.

Luồng session realtime: mỗi extension có 1 background service worker giữ kết nối WebSocket liên tục tới server (`ws://localhost:3000/ws`), và gửi `{ type: "register", pageId }` báo cho server biết nó phụ trách page nào (pageId nhập ở popup, lưu trong `chrome.storage.local`). Khi server cần dữ liệu, nó gửi yêu cầu qua WS tới đúng extension phụ trách -> extension đọc **của tab đang active ngay lúc đó**: cookie (`chrome.cookies.getAll`) + `fb_dtsg`/`lsd`/`userId` (inject script đọc HTML tab, regex extract) -> trả về qua WS. Không cache — mỗi lần đều lấy tươi mới.

## Extention_API (Chrome Extension)

- `manifest.json` — MV3, quyền `cookies`, `activeTab`, `tabs`, `alarms`, `scripting`, `storage`, host permission `<all_urls>`, có `background.service_worker: background.js`.
- `background.js` — service worker chạy nền, cốt lõi phục vụ API realtime:
  - Tự kết nối `ws://localhost:3000/ws` khi khởi động (`onStartup`, `onInstalled`, ngay khi script load), gửi `{ type: "register", pageId }` ngay khi mở kết nối và mỗi khi `managedPageId` trong `chrome.storage.local` đổi (`chrome.storage.onChanged`).
  - **Giữ kết nối ổn định**: heartbeat `{ type: "ping" }` mỗi 20s trong lúc WS mở (server trả `{ type: "pong" }`) để tạo hoạt động thật, giảm khả năng Chrome tắt service worker do rảnh (~30s không hoạt động). Cộng thêm `chrome.alarms` mỗi 30s kiểm tra và tự reconnect nếu WS đã đóng. Best-effort, không đảm bảo tuyệt đối 24/7.
  - Khi nhận `{ type: "get_cookies", requestId }`: lấy tab active, đọc cookie (`chrome.cookies.getAll`) + `fb_dtsg`/`lsd` (inject script đọc `outerHTML`, regex extract — `null` nếu tab không phải Facebook đã đăng nhập) + `userId` (ưu tiên cookie `c_user`, fallback HTML). Gửi lại `{ type: "cookies_result", requestId, cookieString, fbDtsg, lsd, userId }`.
  - `WS_URL` (`background.js:1`) hard-code `localhost:3000` — đổi nếu server chạy ở địa chỉ khác.
- `popup.html` / `popup.js`:
  - **Lấy Cookie** / **Copy Cookie**: thao tác thủ công tại chỗ, không liên quan server.
  - **Ô nhập Page ID + nút Lưu**: cấu hình pageId mà extension trên profile này phụ trách — lưu vào `chrome.storage.local`, `background.js` tự báo cho server ngay khi lưu.

## Server_API (Node.js/Express + ws + facebook-business)

Chạy: `cd Server_API && npm install && npm start` (mặc định port `3000`, override bằng env `PORT`).

### Registry & routing (trong `server.js`)

- `allSockets` (Set): mọi extension đang kết nối WS, bất kể đã đăng ký pageId hay chưa — dùng cho `/api/cookie/live` khi không chỉ định `pageId`.
- `registrations` (`{ pageId, socket }[]`): các extension đã đăng ký phụ trách 1 pageId cụ thể, cập nhật qua message `register` từ `background.js`; dọn dẹp khi socket đóng.
- `getLiveSession(pageId)`: tìm đúng extension đã đăng ký `pageId` này; nếu nhiều extension cùng đăng ký 1 page (tài khoản dự phòng) thì round-robin trong nhóm đó; không có ai đăng ký -> lỗi `503`.
- `pickNextAutoRotate()`: round-robin qua **toàn bộ** extension đang đăng ký (không phân biệt page) — dùng cho chế độ tự động của `/api/create_post_with_link`.

### Endpoints

| Method | Path | Mô tả |
|---|---|---|
| `GET` | `/api/cookie/live?pageId=` (optional) | Có `pageId` -> lấy cookie đúng extension phụ trách; không có -> lấy đại 1 extension bất kỳ đang kết nối. Trả `{ cookieString }`. |
| `POST` | `/api/create_post` | Body `{ pageId, message }` (bắt buộc cả 2). Đăng post lên đúng Page qua `facebook-business`. Trả `{ ok: true, postId, result }`. `503` nếu chưa có extension nào đăng ký `pageId` này. |
| `GET` | `/api/wrapped_url?postId=` | Tự tách `pageId` từ `postId` (định dạng Facebook `pageId_xxxxx`) để routing đúng extension. Trả `{ wrappedUrl }`. |
| `POST` | `/api/create_post_with_link` | Body `{ pageId?, message }`. **Có `pageId`**: đăng đúng page đó, lỗi thì báo lỗi luôn (không failover). **Không có `pageId`**: tự động chọn page/account theo vòng xoay (round-robin toàn cục) — gọi lần 1 dùng page/account đầu tiên, lần 2 chuyển sang cái tiếp theo, v.v. Nếu lỗi **trước khi đăng post thật** (chưa có `postId`) thì tự chuyển sang page/account kế tiếp thử lại; nếu post đã đăng thành công rồi mới lỗi ở bước lấy `wrappedUrl` thì **dừng ngay, không failover** (tránh đăng trùng nội dung lên nhiều page) — trả `502` kèm `postId` đã tạo. Response thành công trả `{ ok: true, pageId, postId, wrappedUrl }` (kèm `pageId` để biết page nào vừa được dùng). |
| `GET` | `/api/pages` | Danh sách `pageId` đang có extension đăng ký + kết nối (`{ pages: [{ pageId }, ...] }`). |
| `GET` | `/ws` (WebSocket, không phải HTTP) | Kênh `background.js` kết nối vào để nhận lệnh `get_cookies` và gửi `register`/`ping`. |
| `GET` | `/` | Health check: `extensionConnected`, `connectedExtensions`, `registeredPages`. |

### `shareUrl.js` — lấy wrapped_url (link share rút gọn)

- Gọi thẳng `https://www.facebook.com/api/graphql/` (endpoint nội bộ của Facebook web, **không phải Graph API chính thức**) với `doc_id` cố định của mutation `useLinkSharingCreateWrappedUrlMutation`, header/body khớp request thật capture trong `test.py` (kể cả các header client-hint `sec-ch-ua*`, `sec-fetch-*`, `x-asbd-id`).
- Cần `fb_dtsg`/`lsd`/`userId` (lấy từ tab active qua extension) + `cookie`. Không gửi `jazoest`/`lsd` trong body (chỉ `lsd` ở header `x-fb-lsd`) — khớp theo request đã xác nhận hoạt động thật.
- Parser chịu được trường hợp Facebook trả về nhiều dòng JSON tách biệt (multi-part response).
- Rủi ro: API nội bộ không chính thức, Facebook có thể đổi `doc_id`/field bắt buộc bất kỳ lúc nào.

### `facebook.js` — đăng post + cache pageAccessToken

- Bọc package `facebook-business`. `getPageToken()` trả `null` khi thất bại (không throw); `createPagePost()` luôn resolve `{ ok, data, attempts }` (không throw khi Facebook từ chối — phải kiểm tra `result.ok`).
- Cache `pageAccessToken` theo `pageId` vào `pageTokens.json` (gitignore): dùng cache trước, chỉ `getPageToken` lại khi chưa có cache hoặc lần đăng trước thất bại (`result.ok === false`), thử lại đúng 1 lần với token mới.
- Page Access Token đại diện cho **Page** (không gắn với tài khoản cá nhân nào lấy nó) — dù extension/tài khoản nào trong vòng xoay lấy token, cache theo `pageId` vẫn dùng lại bình thường.

## Lưu ý / nợ kỹ thuật

- Không có auth cho endpoint HTTP lẫn kênh WebSocket — ai gọi được `localhost:3000` đều đăng post/lấy cookie thay bạn được, và ai kết nối được `/ws` cũng có thể giả làm extension rồi `register` một `pageId` bất kỳ để "cướp" lượt route. Cân nhắc thêm token/API key nếu server chạy ngoài localhost hoặc máy nhiều người dùng.
- MV3 service worker có thể bị Chrome tắt khi rảnh; đã có heartbeat + alarm 30s giảm thiểu nhưng không đảm bảo tuyệt đối 24/7.
- `pageTokens.json` lưu access token dạng plaintext trên đĩa — đã gitignore nhưng cân nhắc mã hoá/giới hạn quyền đọc nếu deploy máy nhiều người dùng.
- `main.js` vẫn hardcode 1 cookie session Facebook thật — chỉ tham khảo cục bộ, không commit, không chạy trực tiếp (đã thay bằng `/api/create_post`).
- Tên thư mục `Extention_API` sai chính tả (đúng ra "Extension") — giữ nguyên tránh phá đường dẫn hiện có.
- **`/api/create_post` và `/api/create_post_with_link` (khi truyền `pageId`) giờ yêu cầu đúng `pageId` đó đã được 1 extension đăng ký qua popup** — nếu trước đây gọi API mà không quan tâm popup/pageId thì giờ phải mở popup từng profile, nhập `pageId`, bấm Lưu trước.
- `/api/wrapped_url` và routing theo `pageId` đều cần tab Facebook (đã đăng nhập) đang active ở đúng profile phụ trách page đó.
- Chưa có test tự động (`test.js` là script chạy tay, gọi API thật — có kiểm tra `pageId` đã đăng ký chưa trước khi chạy).
