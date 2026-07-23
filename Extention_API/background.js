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
      handleGetCookies(msg.requestId);
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

// Yêu cầu tới từ server (curl/API), không phải người dùng click trực tiếp, nên không thể
// dựa vào "tab đang active" — lúc đó Chrome có thể coi 1 cửa sổ khác là "focus gần nhất"
// dù cửa sổ đó không chứa tab Facebook. Tìm thẳng tab nào đang mở facebook.com thay vì đoán
// qua active/lastFocusedWindow.
async function findFacebookTab() {
  const fbTabs = await chrome.tabs.query({ url: ["*://*.facebook.com/*"] });
  if (fbTabs.length) {
    return fbTabs.find((t) => t.active) || fbTabs[0];
  }
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return activeTab || null;
}

async function handleGetCookies(requestId) {
  try {
    const tab = await findFacebookTab();
    if (!tab || !tab.url) {
      throw new Error("Không tìm thấy tab Facebook nào đang mở.");
    }

    const cookies = await chrome.cookies.getAll({ url: tab.url });
    console.log(`[FB_API] get_cookies: tab.url=${tab.url} -> ${cookies.length} cookie(s).`);
    const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const cUserCookie = cookies.find((c) => c.name === "c_user");

    const session = await extractFacebookSession(tab.id);
    // Ưu tiên userId cá nhân từ cookie c_user (đây mới là danh tính đăng nhập thật);
    // chỉ dùng USER_ID/ACCOUNT_ID/actorID lấy từ HTML làm phương án dự phòng.
    const userId = cUserCookie ? cUserCookie.value : session.userId;
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

// Lấy fb_dtsg/lsd/userId trực tiếp từ HTML của tab Facebook đang active (không phải
// tab nào cũng là Facebook — nếu không tìm thấy thì trả về null, không coi là lỗi).
async function extractFacebookSession(tabId) {
  try {
    const [{ result: html }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.documentElement.outerHTML,
    });
    return parseFacebookTokens(html || "");
  } catch {
    return { fbDtsg: null, lsd: null, userId: null };
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
