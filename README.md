# FB_API

Nhiều Chrome profile (mỗi profile = 1 tài khoản Facebook quản lý 1 Page) cùng cài extension, mỗi extension đăng ký với server nó phụ trách `pageId` nào. Server dùng cookie/session realtime lấy từ đúng extension phụ trách để gọi Facebook (đăng post lên Page, lấy link share).

## Kiến trúc

```
Extention_API/   Chrome extension (Manifest V3) — 1 bản cài trên nhiều Chrome profile, mỗi profile phụ trách 1 pageId
Server_API/      Node.js + Express server — registry pageId -> extension, routing/round-robin/failover, cầu nối HTTP <-> WebSocket
```

**Lưu ý quan trọng**: cookie trong Chrome dùng chung theo profile, không theo tab — muốn nhiều tài khoản Facebook khác nhau phải dùng **nhiều Chrome profile** (mỗi profile 1 `--user-data-dir` riêng), không phải nhiều tab trong cùng 1 profile.

Luồng session realtime: mỗi extension có 1 background service worker giữ kết nối WebSocket liên tục tới server (`ws://localhost:3000/ws`), và gửi `{ type: "register", pageId }` báo cho server biết nó phụ trách page nào (pageId nhập ở popup, lưu trong `chrome.storage.local`). Khi server cần dữ liệu, nó gửi yêu cầu qua WS tới đúng extension phụ trách -> extension lấy cookie theo domain + fetch trực tiếp 1 trang Facebook để có token tươi (xem chi tiết bên dưới) -> trả về qua WS. Không cache — mỗi lần đều lấy tươi mới, **không phụ thuộc tab nào đang mở/đang active**.

## Extention_API (Chrome Extension)

- `manifest.json` — MV3, quyền `cookies`, `activeTab`, `tabs`, `alarms`, `storage`, host permission `<all_urls>`, có `background.service_worker: background.js`.
- `background.js` — service worker chạy nền, cốt lõi phục vụ API realtime:
  - Tự kết nối `ws://localhost:3000/ws` khi khởi động (`onStartup`, `onInstalled`, ngay khi script load), gửi `{ type: "register", pageId }` ngay khi mở kết nối và mỗi khi `managedPageId` trong `chrome.storage.local` đổi (`chrome.storage.onChanged`).
  - **Giữ kết nối ổn định**: heartbeat `{ type: "ping" }` mỗi 20s trong lúc WS mở (server trả `{ type: "pong" }`) để tạo hoạt động thật, giảm khả năng Chrome tắt service worker do rảnh (~30s không hoạt động). Cộng thêm `chrome.alarms` mỗi 30s kiểm tra và tự reconnect nếu WS đã đóng. Best-effort, không đảm bảo tuyệt đối 24/7.
  - Khi nhận `{ type: "get_cookies", requestId }`:
    - Cookie: `chrome.cookies.getAll({ domain: "facebook.com" })` — lấy theo domain, **không cần tab nào đang mở**.
    - `fb_dtsg`/`lsd`: `fetch("https://www.facebook.com/", { credentials: "include" })` (fallback `business.facebook.com` nếu thiếu) — service worker tự gọi thẳng, cookie tự động gửi kèm nhờ `credentials:"include"`, luôn lấy được HTML **mới nhất từ server** rồi regex extract. Cách này thay cho việc đọc `outerHTML` của tab đã mở sẵn (đã bỏ) — vì Facebook là SPA, có thể tự xoay token phía client mà không re-render lại HTML gốc, khiến giá trị đọc từ tab cũ dễ bị lệch (stale) so với cookie hiện tại và bị Facebook từ chối (lỗi "session không đồng bộ").
    - `userId`: ưu tiên cookie `i_user` nếu có, fallback `c_user`. **Quan trọng**: `i_user` xuất hiện khi trình duyệt đang "act as Page" theo hệ thống định danh mới của Meta — khi đó `fb_dtsg` lấy được scope theo danh tính Page (`i_user`), không phải tài khoản cá nhân (`c_user`). Dùng nhầm `c_user` trong trường hợp này khiến `/api/wrapped_url` bị Facebook từ chối dù mọi field khác đều đúng (đã kiểm chứng thực tế: cùng 1 `fb_dtsg`/cookie, đổi `actor_id` từ `c_user` sang `i_user` là thành công ngay).
    - Gửi lại `{ type: "cookies_result", requestId, cookieString, fbDtsg, lsd, userId }`.
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
- Cần `fb_dtsg`/`lsd`/`userId` (extension tự fetch trực tiếp từ facebook.com để lấy tươi, không qua tab đang mở — xem trên) + `cookie`. Không gửi `jazoest`/`lsd` trong body (chỉ `lsd` ở header `x-fb-lsd`) — khớp theo request đã xác nhận hoạt động thật.
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
- `/api/wrapped_url` và routing theo `pageId` cần đúng profile phụ trách page đó đang **đăng nhập Facebook** (có cookie hợp lệ) — **không** cần mở sẵn tab Facebook nào, cũng không cần tab đang active (đã bỏ phụ thuộc tab từ bản sửa lỗi stale token).
- Chưa có test tự động (`test.js` là script chạy tay, gọi API thật — có kiểm tra `pageId` đã đăng ký chưa trước khi chạy).
