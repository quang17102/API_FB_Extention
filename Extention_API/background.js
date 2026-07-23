const WS_URL = "ws://localhost:3000/ws";
const RECONNECT_DELAY_MS = 3000;
const HEARTBEAT_INTERVAL_MS = 20000;

let ws = null;
let heartbeatIntervalId = null;

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log("[FB_API] Đã kết nối WebSocket tới server.");
    startHeartbeat();
    sendRegister();
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.type === "get_cookies") {
      handleGetCookies(msg.requestId, !!msg.skipTokenFetch);
    }
  };

  ws.onclose = () => {
    ws = null;
    stopHeartbeat();
    setTimeout(connect, RECONNECT_DELAY_MS);
  };

  ws.onerror = () => {
    try {
      ws.close();
    } catch {}
  };
}

// Gửi ping đều đặn trong lúc WS đang mở — tạo hoạt động thật (network + JS) để
// hạn chế việc Chrome tắt service worker do rảnh (idle timeout ~30s của MV3).
// Đây chỉ là giảm thiểu, không đảm bảo tuyệt đối 24/7 vì Chrome có thể tắt SW
// vì lý do khác (máy sleep, extension reload, đóng hết cửa sổ Chrome...) —
// khi đó chrome.alarms bên dưới sẽ tự phát hiện và reconnect lại.
function startHeartbeat() {
  stopHeartbeat();
  heartbeatIntervalId = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (heartbeatIntervalId) {
    clearInterval(heartbeatIntervalId);
    heartbeatIntervalId = null;
  }
}

// Báo cho server biết extension này đang phụ trách pageId nào (cấu hình qua popup,
// lưu trong chrome.storage.local). Gọi lại mỗi khi kết nối WS mới hoặc khi pageId đổi.
async function sendRegister() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const { managedPageId } = await chrome.storage.local.get("managedPageId");
  ws.send(JSON.stringify({ type: "register", pageId: managedPageId || null }));
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.managedPageId) {
    sendRegister();
  }
});

// Không phụ thuộc tab nào đang mở/đang active — lấy thẳng cookie theo domain và fetch
// trực tiếp 1 trang Facebook (kèm cookie tự động nhờ credentials:"include") để luôn có
// fb_dtsg/lsd TƯƠI MỚI từ server. Đọc HTML tab đã mở sẵn (cách cũ) dễ bị stale vì
// Facebook là SPA, có thể tự xoay token phía client mà không re-render lại HTML gốc.
const TOKEN_DISCOVERY_URLS = ["https://www.facebook.com/", "https://business.facebook.com/"];
const TOKEN_FETCH_TIMEOUT_MS = 8000;

async function fetchFreshFacebookTokens() {
  for (const url of TOKEN_DISCOVERY_URLS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TOKEN_FETCH_TIMEOUT_MS);
      let res;
      try {
        res = await fetch(url, { credentials: "include", cache: "no-store", signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      const html = await res.text();
      const tokens = parseFacebookTokens(html);
      console.log(
        `[FB_API] fetch tokens từ ${url}: status=${res.status}, bytes=${html.length}, ` +
          `fbDtsg=${tokens.fbDtsg ? tokens.fbDtsg.slice(0, 12) + "..." : "null"}, ` +
          `lsd=${tokens.lsd ? tokens.lsd.slice(0, 8) + "..." : "null"}, userId=${tokens.userId}`
      );
      // Chỉ cần fbDtsg (lsd không còn dùng trong request thật nữa) -> dừng ngay, không
      // fetch thêm URL dự phòng nếu không cần thiết, tránh tốn thời gian/dễ timeout.
      if (tokens.fbDtsg) return tokens;
    } catch (err) {
      console.log(`[FB_API] fetch tokens từ ${url} lỗi: ${err.message}`);
    }
  }
  return { fbDtsg: null, lsd: null, userId: null };
}

// fbDtsg giờ được cache ở phía SERVER (fbDtsgCache.json), không phải trong bộ nhớ
// extension nữa — cache trong service worker dễ mất khi Chrome tắt SW do rảnh (~30s),
// còn cache ở server thì bền hơn (sống sót qua việc SW restart, chỉ mất khi server restart).
// skipTokenFetch: true -> server đã có fbDtsg cache sẵn, extension chỉ cần trả cookie
// (đọc local, không cần fetch mạng) cho nhanh.
async function handleGetCookies(requestId, skipTokenFetch) {
  try {
    const cookies = await chrome.cookies.getAll({ domain: "facebook.com" });
    console.log(`[FB_API] get_cookies: ${cookies.length} cookie(s) cho domain facebook.com.`);
    const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const cUserCookie = cookies.find((c) => c.name === "c_user");
    // i_user xuất hiện khi trình duyệt đang "act as Page" theo hệ thống định danh mới của
    // Meta — lúc đó fb_dtsg lấy được sẽ scope theo danh tính Page (i_user), không phải tài
    // khoản cá nhân (c_user). Dùng nhầm c_user trong trường hợp này khiến Facebook từ chối
    // request (đã kiểm chứng thực tế). Ưu tiên i_user nếu có, fallback c_user nếu không.
    const iUserCookie = cookies.find((c) => c.name === "i_user");

    const session = skipTokenFetch
      ? { fbDtsg: null, lsd: null, userId: null }
      : await fetchFreshFacebookTokens();
    const userId = (iUserCookie || cUserCookie)?.value || null;
    const { fbDtsg, lsd } = session;

    ws.send(
      JSON.stringify({
        type: "cookies_result",
        requestId,
        cookieString,
        fbDtsg,
        lsd,
        userId,
      })
    );
  } catch (err) {
    ws.send(
      JSON.stringify({
        type: "cookies_result",
        requestId,
        error: err.message,
      })
    );
  }
}

function parseFacebookTokens(html) {
  return {
    fbDtsg: firstMatch(html, [
      /"DTSGInitialData",\[\],{"token":"([^"]+)"/,
      /"DTSGInitData",\[\],{"token":"([^"]+)"/,
      /name="fb_dtsg"\s+value="([^"]+)"/,
      /"fb_dtsg"\s*:\s*"([^"]+)"/,
    ]),
    lsd: firstMatch(html, [
      /"LSD",\[\],{"token":"([^"]+)"/,
      /name="lsd"\s+value="([^"]+)"/,
      /"lsd"\s*:\s*"([^"]+)"/,
    ]),
    userId: firstMatch(html, [
      /"USER_ID"\s*:\s*"(\d+)"/,
      /"ACCOUNT_ID"\s*:\s*"(\d+)"/,
      /"actorID"\s*:\s*"(\d+)"/,
    ]),
  };
}

function firstMatch(html, patterns) {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return decodeEscapes(match[1]);
  }
  return null;
}

function decodeEscapes(value) {
  return value.replace(/\\u0025/g, "%").replace(/\\\//g, "/").replace(/\\"/g, '"');
}

// Service worker MV3 có thể bị Chrome tắt khi rảnh; các listener dưới đây
// đảm bảo kết nối WebSocket được thiết lập lại mỗi khi service worker "thức dậy".
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms.create("ws-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "ws-keepalive") connect();
});

connect();
