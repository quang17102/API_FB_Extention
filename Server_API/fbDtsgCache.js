const fs = require("fs/promises");
const path = require("path");

const CACHE_FILE = path.join(__dirname, "fbDtsgCache.json");

// Giống cơ chế khoá trong facebook.js — tuần tự hoá đọc/ghi để tránh nhiều request
// song song làm hỏng file.
let ioQueue = Promise.resolve();
function withFileLock(fn) {
  const run = ioQueue.then(fn, fn);
  ioQueue = run.then(
    () => {},
    () => {}
  );
  return run;
}

async function readCache() {
  try {
    const raw = await fs.readFile(CACHE_FILE, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return {};
    console.warn(`[fbDtsgCache] pageTokens không đọc được (${err.message}), coi như rỗng.`);
    return {};
  }
}

async function writeCache(cache) {
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
}

// { fbDtsg, userId, updatedAt } | null
async function getCachedFbDtsg(pageId) {
  return withFileLock(async () => {
    const cache = await readCache();
    return cache[pageId] || null;
  });
}

async function saveFbDtsg(pageId, { fbDtsg, userId }) {
  if (!fbDtsg) return;
  return withFileLock(async () => {
    const cache = await readCache();
    cache[pageId] = { fbDtsg, userId: userId || null, updatedAt: new Date().toISOString() };
    await writeCache(cache);
  });
}

module.exports = { getCachedFbDtsg, saveFbDtsg };
