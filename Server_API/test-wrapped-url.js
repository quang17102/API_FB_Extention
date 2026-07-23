// Test debug: gọi thẳng createWrappedShareUrl() thật (không qua HTTP route) với session
// lấy realtime từ extension đang đăng ký pageId này, in chi tiết toàn bộ field trước khi
// gửi lên Facebook và kết quả/lỗi trả về.
//
// Cách dùng: node test-wrapped-url.js <pageId> [postId]
// Nếu không truyền postId, dùng postId giả `${pageId}_0` chỉ để xem các field được build
// ra sao — Facebook chắc chắn sẽ từ chối vì postId không tồn tại, nhưng vẫn cho thấy
// cookie/fb_dtsg/userId có hợp lệ hay không qua nội dung lỗi trả về.

const { createWrappedShareUrl } = require("./shareUrl");

const BASE_URL = process.env.SERVER_URL || "http://localhost:3000";

function preview(value, len = 40) {
  if (!value) return value;
  return value.length > len ? `${value.slice(0, len)}... (${value.length} ký tự)` : value;
}

async function main() {
  const [, , pageId, postIdArg] = process.argv;

  if (!pageId) {
    console.error("Cách dùng: node test-wrapped-url.js <pageId> [postId]");
    process.exit(1);
  }

  const postId = postIdArg || `${pageId}_0`;
  if (!postIdArg) {
    console.log(`(Không truyền postId, dùng postId giả "${postId}" chỉ để xem field được build ra sao.)\n`);
  }

  console.log(`1) Lấy session realtime cho pageId=${pageId} ...`);
  const sessionRes = await fetch(`${BASE_URL}/api/debug/session?pageId=${encodeURIComponent(pageId)}`);
  const session = await sessionRes.json();

  if (!sessionRes.ok) {
    console.error("   Lỗi lấy session:", session);
    process.exit(1);
  }

  console.log("   cookieString:", preview(session.cookieString, 80));
  console.log("   fbDtsg      :", session.fbDtsg);
  console.log("   lsd         :", session.lsd, "(không còn dùng trong request, chỉ để tham khảo)");
  console.log("   userId      :", session.userId);

  console.log("\n2) Field sẽ truyền vào createWrappedShareUrl({ cookie, fbDtsg, userId, postId }):");
  console.log("   cookie :", preview(session.cookieString, 80));
  console.log("   fbDtsg :", session.fbDtsg);
  console.log("   userId :", session.userId);
  console.log("   postId :", postId);

  if (!session.fbDtsg) {
    console.error("\n   fbDtsg rỗng -> chắc chắn sẽ lỗi. Kiểm tra lại profile đó đã đăng nhập Facebook chưa.");
  }
  if (!session.userId) {
    console.error("\n   userId rỗng -> chắc chắn sẽ lỗi (thiếu cookie c_user, có nghĩa là chưa đăng nhập).");
  }

  console.log("\n3) Gọi createWrappedShareUrl() thật (sẽ tự in thêm form data + headers đầy đủ)...\n");
  try {
    const wrappedUrl = await createWrappedShareUrl({
      cookie: session.cookieString,
      fbDtsg: session.fbDtsg,
      userId: session.userId,
      postId,
    });
    console.log("\n=> THÀNH CÔNG. wrappedUrl:", wrappedUrl);
  } catch (err) {
    console.error("\n=> THẤT BẠI:", err.message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Lỗi không mong muốn:", err);
  process.exit(1);
});
