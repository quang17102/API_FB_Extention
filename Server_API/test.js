// Script test thủ công cho Server_API: kiểm tra cookie realtime + đăng post lên Facebook Page.
// Đây là request THẬT tới Facebook Graph API — pageId hợp lệ sẽ tạo post thật trên page đó.
//
// Lưu ý: pageId truyền vào PHẢI đã được đăng ký (mở popup extension -> nhập pageId -> Lưu)
// trên đúng Chrome profile đang đăng nhập tài khoản quản lý page đó. Kiểm tra danh sách
// page đang đăng ký bằng: curl http://localhost:3000/api/pages

const BASE_URL = process.env.SERVER_URL || "http://localhost:3000";

async function main() {
  const [, , pageId, message] = process.argv;

  if (!pageId || !message) {
    console.error('Cách dùng: node test.js <pageId> "<nội dung post>"');
    process.exit(1);
  }

  console.log("1) Kiểm tra server + extension...");
  const health = await fetch(`${BASE_URL}/`).then((r) => r.json());
  console.log("  ", health);

  if (!health.extensionConnected) {
    console.error(
      "\nExtension chưa kết nối WebSocket tới server. Kiểm tra lại:\n" +
        "  - Server_API đang chạy (npm start)\n" +
        "  - Extension đã được load/reload trong chrome://extensions\n" +
        "  - Trình duyệt Chrome đang mở (service worker của extension cần chạy)"
    );
    process.exit(1);
  }

  const pages = await fetch(`${BASE_URL}/api/pages`).then((r) => r.json());
  console.log("   Page đang đăng ký:", pages.pages);
  if (!pages.pages.some((p) => p.pageId === pageId)) {
    console.error(
      `\npageId=${pageId} chưa được extension nào đăng ký. Mở popup extension -> nhập pageId -> Lưu, rồi thử lại.`
    );
    process.exit(1);
  }

  console.log("\n2) Lấy cookie mới nhất từ tab đang active...");
  const cookieRes = await fetch(`${BASE_URL}/api/cookie/live`);
  const cookieData = await cookieRes.json();
  if (!cookieRes.ok) {
    console.error("  Lỗi lấy cookie:", cookieData);
    process.exit(1);
  }
  console.log(`   Đã lấy cookie (${cookieData.cookieString.length} ký tự).`);

  console.log(`\n3) Đăng post lên pageId=${pageId} ...`);
  const postRes = await fetch(`${BASE_URL}/api/create_post`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pageId, message }),
  });
  const postData = await postRes.json();

  if (!postRes.ok) {
    console.error(`   Thất bại (HTTP ${postRes.status}):`);
    console.error(JSON.stringify(postData, null, 2));
    process.exit(1);
  }

  console.log("   Thành công! postId:", postData.postId);
  console.log(JSON.stringify(postData, null, 2));

  if (!postData.postId) {
    console.log("\n(Không có postId nên bỏ qua bước lấy wrapped_url.)");
    return;
  }

  console.log(`\n4) Lấy link share (wrapped_url) cho postId=${postData.postId} ...`);
  const wrappedRes = await fetch(`${BASE_URL}/api/wrapped_url?postId=${encodeURIComponent(postData.postId)}`);
  const wrappedData = await wrappedRes.json();

  if (!wrappedRes.ok) {
    console.error(`   Thất bại (HTTP ${wrappedRes.status}):`, wrappedData);
    process.exit(1);
  }

  console.log("   wrappedUrl:", wrappedData.wrappedUrl);
}

main().catch((err) => {
  console.error("Lỗi không mong muốn:", err);
  process.exit(1);
});
