const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const { createPost } = require("./facebook");
const { createWrappedShareUrl } = require("./shareUrl");

const app = express();
const PORT = process.env.PORT || 3000;
const LIVE_REQUEST_TIMEOUT_MS = 5000;

app.use(express.json({ limit: "1mb" }));

class LiveCookieError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// Mọi extension đang kết nối WebSocket, bất kể đã đăng ký pageId hay chưa.
const allSockets = new Set();
// Extension đã đăng ký phụ trách 1 pageId cụ thể (qua message "register" từ background.js,
// dựa theo pageId người dùng nhập ở popup). { pageId, socket }[]
const registrations = [];
const pageRotationIndex = new Map(); // pageId -> con trỏ xoay vòng trong nhóm cùng pageId
let autoRotateIndex = 0; // con trỏ xoay vòng toàn cục (không phân biệt page), dùng cho auto-rotate

const pendingRequests = new Map(); // requestId -> { resolve, reject, timer }

// Gửi yêu cầu "get_cookies" tới 1 socket cụ thể, chờ phản hồi qua WebSocket.
function getSessionFromSocket(socket) {
  if (!socket || socket.readyState !== socket.OPEN) {
    return Promise.reject(new LiveCookieError("Extension đã ngắt kết nối.", 503));
  }

  const requestId = crypto.randomUUID();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new LiveCookieError("Hết thời gian chờ extension phản hồi.", 504));
    }, LIVE_REQUEST_TIMEOUT_MS);

    pendingRequests.set(requestId, { resolve, reject, timer });
    socket.send(JSON.stringify({ type: "get_cookies", requestId }));
  });
}

// Lấy session từ đúng extension đã đăng ký phụ trách pageId này (round-robin nếu có
// nhiều extension cùng đăng ký 1 pageId, ví dụ tài khoản dự phòng).
function getLiveSession(pageId) {
  const candidates = registrations.filter((r) => r.pageId === pageId);
  if (!candidates.length) {
    return Promise.reject(
      new LiveCookieError(`Chưa có extension nào đăng ký phụ trách pageId=${pageId}.`, 503)
    );
  }

  const idx = (pageRotationIndex.get(pageId) || 0) % candidates.length;
  pageRotationIndex.set(pageId, idx + 1);

  return getSessionFromSocket(candidates[idx].socket);
}

// Chọn extension tiếp theo theo vòng xoay toàn cục — dùng cho chế độ tự động của
// /api/create_post_with_link khi không chỉ định pageId.
function pickNextAutoRotate() {
  if (!registrations.length) return null;
  const picked = registrations[autoRotateIndex % registrations.length];
  autoRotateIndex++;
  return picked;
}

app.get("/api/cookie/live", async (req, res) => {
  try {
    const { pageId } = req.query;
    let session;

    if (pageId) {
      session = await getLiveSession(pageId);
    } else {
      const anySocket = allSockets.values().next().value;
      if (!anySocket) {
        return res.status(503).json({ error: "Chưa có extension nào kết nối WebSocket tới server." });
      }
      session = await getSessionFromSocket(anySocket);
    }

    res.json({ cookieString: session.cookieString });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Đăng post lên Facebook Page bằng cookie mới nhất lấy realtime từ đúng extension
// đã đăng ký phụ trách pageId này.
app.post("/api/create_post", async (req, res) => {
  const { pageId, message } = req.body || {};
  if (!pageId || !message) {
    return res.status(400).json({ error: "Thiếu pageId hoặc message." });
  }

  try {
    const session = await getLiveSession(pageId);
    const result = await createPost({ cookie: session.cookieString, pageId, message });
    res.json({ ok: true, postId: result.data?.id || result.data?.post_id || null, result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, result: err.result });
  }
});

// Lấy link share rút gọn (facebook.com/share/...) từ 1 postId đã tồn tại.
// postId Facebook có dạng "pageId_xxxxx" nên tự tách ra để routing đúng extension.
app.get("/api/wrapped_url", async (req, res) => {
  const { postId } = req.query;
  if (!postId) {
    return res.status(400).json({ error: "Thiếu postId." });
  }

  const pageId = String(postId).split("_")[0];

  try {
    const session = await getLiveSession(pageId);
    if (!session.fbDtsg || !session.lsd) {
      return res.status(502).json({
        error:
          "Không lấy được fb_dtsg/lsd từ tab đang active. Hãy đảm bảo tab Facebook (đã đăng nhập) đang mở và active, rồi thử lại.",
      });
    }

    const wrappedUrl = await createWrappedShareUrl({
      cookie: session.cookieString,
      fbDtsg: session.fbDtsg,
      lsd: session.lsd,
      userId: session.userId,
      postId,
    });

    res.json({ wrappedUrl });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Đăng post rồi lấy luôn wrapped_url. postId đã tồn tại (đăng thành công thật trên
// Facebook) thì KHÔNG được phép failover sang page khác nữa — tránh đăng trùng nội
// dung lên nhiều page. err.stage đánh dấu lỗi xảy ra ở bước nào để phân biệt.
async function postAndGetLink(session, pageId, message) {
  const postResult = await createPost({ cookie: session.cookieString, pageId, message });
  const postId = postResult.data?.id || postResult.data?.post_id || null;

  if (!postId) {
    const err = new Error("Đăng post thất bại, không lấy được postId.");
    err.status = 502;
    err.stage = "create_post";
    throw err;
  }

  if (!session.fbDtsg || !session.lsd) {
    const err = new Error(
      `Đã đăng post thành công (postId: ${postId}) nhưng không lấy được fb_dtsg/lsd để tạo wrapped_url. Gọi lại GET /api/wrapped_url?postId=${postId} sau khi mở tab Facebook.`
    );
    err.status = 502;
    err.stage = "wrapped_url";
    err.postId = postId;
    throw err;
  }

  try {
    const wrappedUrl = await createWrappedShareUrl({
      cookie: session.cookieString,
      fbDtsg: session.fbDtsg,
      lsd: session.lsd,
      userId: session.userId,
      postId,
    });
    return { postId, wrappedUrl };
  } catch (err) {
    err.stage = "wrapped_url";
    err.postId = postId;
    throw err;
  }
}

// Có pageId trong body -> đăng đúng page đó, lỗi thì báo lỗi luôn (không failover).
// Không có pageId -> tự xoay vòng qua các page đang đăng ký; nếu lỗi TRƯỚC khi tạo
// post thật (chưa có postId) thì tự chuyển sang page/account tiếp theo.
app.post("/api/create_post_with_link", async (req, res) => {
  const { pageId, message } = req.body || {};
  if (!message) {
    return res.status(400).json({ error: "Thiếu message." });
  }

  if (pageId) {
    try {
      const session = await getLiveSession(pageId);
      const { postId, wrappedUrl } = await postAndGetLink(session, pageId, message);
      return res.json({ ok: true, pageId, postId, wrappedUrl });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message, pageId, postId: err.postId || null });
    }
  }

  const totalCandidates = registrations.length;
  if (!totalCandidates) {
    return res.status(503).json({ error: "Chưa có extension nào đăng ký phụ trách page nào." });
  }

  const attempts = [];
  for (let i = 0; i < totalCandidates; i++) {
    const picked = pickNextAutoRotate();
    if (!picked) break;

    try {
      const session = await getSessionFromSocket(picked.socket);
      const { postId, wrappedUrl } = await postAndGetLink(session, picked.pageId, message);
      return res.json({
        ok: true,
        pageId: picked.pageId,
        postId,
        wrappedUrl,
        triedPages: [...attempts.map((a) => a.pageId), picked.pageId],
      });
    } catch (err) {
      attempts.push({ pageId: picked.pageId, error: err.message });

      if (err.stage === "wrapped_url") {
        // Post đã đăng thật lên page này rồi -> dừng, không thử page khác nữa.
        return res.status(err.status || 502).json({
          error: err.message,
          pageId: picked.pageId,
          postId: err.postId,
          triedPages: attempts.map((a) => a.pageId),
        });
      }
      // Chưa đăng gì thật (lỗi lấy session hoặc lỗi create_post) -> thử page tiếp theo.
    }
  }

  res.status(502).json({ error: "Tất cả page/account đều thất bại.", attempts });
});

// Danh sách page/extension đang hoạt động (đã kết nối WS + đã khai báo pageId qua popup).
app.get("/api/pages", (req, res) => {
  res.json({
    pages: registrations
      .filter((r) => r.socket.readyState === r.socket.OPEN)
      .map((r) => ({ pageId: r.pageId })),
  });
});

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Server_API đang chạy.",
    extensionConnected: allSockets.size > 0,
    connectedExtensions: allSockets.size,
    registeredPages: registrations.length,
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (socket) => {
  console.log("Extension đã kết nối WebSocket.");
  allSockets.add(socket);

  socket.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "ping") {
      socket.send(JSON.stringify({ type: "pong" }));
      return;
    }

    if (msg.type === "register") {
      // Gỡ đăng ký cũ của chính socket này (phòng trường hợp đổi sang pageId khác), rồi thêm mới.
      for (let i = registrations.length - 1; i >= 0; i--) {
        if (registrations[i].socket === socket) registrations.splice(i, 1);
      }
      if (msg.pageId) {
        registrations.push({ pageId: String(msg.pageId), socket });
        console.log(`Extension đăng ký phụ trách pageId=${msg.pageId}.`);
      }
      return;
    }

    if (msg.type !== "cookies_result" || !msg.requestId) return;

    const pending = pendingRequests.get(msg.requestId);
    if (!pending) return;

    clearTimeout(pending.timer);
    pendingRequests.delete(msg.requestId);

    if (msg.error) {
      pending.reject(new LiveCookieError(msg.error, 502));
    } else {
      pending.resolve({
        cookieString: msg.cookieString || "",
        fbDtsg: msg.fbDtsg || null,
        lsd: msg.lsd || null,
        userId: msg.userId || null,
      });
    }
  });

  const cleanup = () => {
    allSockets.delete(socket);
    for (let i = registrations.length - 1; i >= 0; i--) {
      if (registrations[i].socket === socket) registrations.splice(i, 1);
    }
  };

  socket.on("close", () => {
    console.log("Extension đã ngắt kết nối WebSocket.");
    cleanup();
  });

  socket.on("error", () => {
    cleanup();
  });
});

server.listen(PORT, () => {
  console.log(`Server_API đang chạy tại http://localhost:${PORT}`);
});
