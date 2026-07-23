const fs = require("fs/promises");
const path = require("path");
const { createFacebookBusinessClient, getLastGraphErrorMessage } = require("facebook-business");

const TOKEN_CACHE_FILE = path.join(__dirname, "pageTokens.json");
const GRAPH_VERSION = "v24.0";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

class FacebookPostError extends Error {
  constructor(message, result) {
    super(message);
    this.status = 502;
    this.result = result;
  }
}

async function readTokenCache() {
  try {
    const raw = await fs.readFile(TOKEN_CACHE_FILE, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

async function writeTokenCache(cache) {
  await fs.writeFile(TOKEN_CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
}

async function getCachedPageToken(pageId) {
  const cache = await readTokenCache();
  return cache[pageId]?.accessToken || null;
}

async function saveCachedPageToken(pageId, accessToken) {
  const cache = await readTokenCache();
  cache[pageId] = { accessToken, updatedAt: new Date().toISOString() };
  await writeTokenCache(cache);
}

// getPageToken() trả về null (không throw) khi không lấy được token — chỉ cache khi có giá trị thật.
async function fetchFreshPageToken(facebook, pageId) {
  const accessToken = await facebook.getPageToken({ pageId });
  if (accessToken) {
    await saveCachedPageToken(pageId, accessToken);
  }
  return accessToken;
}

async function tryCreatePagePost(facebook, { pageId, accessToken, message }) {
  return facebook.createPagePost({
    pageId,
    accessToken: accessToken || undefined,
    message,
    attachmentType: "none",
  });
}

// Đăng post lên Facebook Page. Ưu tiên dùng pageAccessToken đã cache trong
// pageTokens.json; chỉ lấy token mới (và cache lại) khi chưa có cache hoặc khi
// createPagePost bằng token cũ trả về ok:false (token hết hạn/không hợp lệ).
// Lưu ý: createPagePost của SDK không throw khi thất bại, nó resolve với { ok:false, ... }.
async function createPost({ cookie, pageId, message }) {
  const facebook = createFacebookBusinessClient({
    cookie,
    graphVersion: GRAPH_VERSION,
    userAgent: USER_AGENT,
  });

  let accessToken = await getCachedPageToken(pageId);
  if (!accessToken) {
    accessToken = await fetchFreshPageToken(facebook, pageId);
  }

  let result = await tryCreatePagePost(facebook, { pageId, accessToken, message });

  if (!result.ok) {
    accessToken = await fetchFreshPageToken(facebook, pageId);
    result = await tryCreatePagePost(facebook, { pageId, accessToken, message });
  }

  if (!result.ok) {
    throw new FacebookPostError(
      getLastGraphErrorMessage(result.attempts) || "Đăng post thất bại.",
      result
    );
  }

  return result;
}

module.exports = { createPost };
