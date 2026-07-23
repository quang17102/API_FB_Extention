const tabUrlEl = document.getElementById("tabUrl");
const outputEl = document.getElementById("output");
const statusEl = document.getElementById("status");
const getCookiesBtn = document.getElementById("getCookiesBtn");
const copyBtn = document.getElementById("copyBtn");
const pageIdInput = document.getElementById("pageIdInput");
const savePageIdBtn = document.getElementById("savePageIdBtn");
const pageIdStatusEl = document.getElementById("pageIdStatus");

chrome.storage.local.get("managedPageId", ({ managedPageId }) => {
  if (managedPageId) pageIdInput.value = managedPageId;
});

savePageIdBtn.addEventListener("click", async () => {
  const pageId = pageIdInput.value.trim();
  await chrome.storage.local.set({ managedPageId: pageId });
  pageIdStatusEl.style.color = "#16a34a";
  pageIdStatusEl.textContent = pageId ? "Đã lưu, extension sẽ báo cho server ngay." : "Đã xoá — extension sẽ không phụ trách page nào.";
});

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

getActiveTab().then((tab) => {
  if (tab && tab.url) {
    tabUrlEl.textContent = tab.url;
  }
});

getCookiesBtn.addEventListener("click", async () => {
  statusEl.textContent = "";
  const tab = await getActiveTab();
  if (!tab || !tab.url) {
    statusEl.textContent = "Không tìm thấy tab hợp lệ.";
    statusEl.style.color = "#dc2626";
    return;
  }

  try {
    const cookies = await chrome.cookies.getAll({ url: tab.url });
    if (!cookies.length) {
      outputEl.value = "";
      statusEl.textContent = "Tab này không có cookie.";
      statusEl.style.color = "#dc2626";
      return;
    }

    const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    outputEl.value = cookieString;
    statusEl.style.color = "#16a34a";
    statusEl.textContent = `Đã lấy ${cookies.length} cookie.`;
  } catch (err) {
    statusEl.style.color = "#dc2626";
    statusEl.textContent = "Lỗi: " + err.message;
  }
});

copyBtn.addEventListener("click", async () => {
  if (!outputEl.value) {
    statusEl.style.color = "#dc2626";
    statusEl.textContent = "Chưa có cookie để copy.";
    return;
  }
  try {
    await navigator.clipboard.writeText(outputEl.value);
    statusEl.style.color = "#16a34a";
    statusEl.textContent = "Đã copy vào clipboard!";
  } catch (err) {
    statusEl.style.color = "#dc2626";
    statusEl.textContent = "Copy thất bại: " + err.message;
  }
});
