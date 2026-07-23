const GRAPHQL_URL = "https://www.facebook.com/api/graphql/";
const DOC_ID = "30568280579452205";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

class WrappedUrlError extends Error {
  constructor(message) {
    super(message);
    this.status = 502;
  }
}

// Facebook đôi khi thêm tiền tố chống JSON-hijack "for (;;);" trước JSON thật
// (thường gặp ở response lỗi generic, khác hẳn dạng multi-line JSON của response
// GraphQL bình thường) — cắt bỏ tiền tố này trước khi parse.
function stripAntiHijackPrefix(text) {
  return text.startsWith("for (;;);") ? text.slice("for (;;);".length) : text;
}

// Endpoint GraphQL nội bộ của Facebook đôi khi trả về nhiều dòng JSON tách biệt
// (multi-part response) thay vì 1 object JSON duy nhất — dòng cuối thường có
// "is_final": true. Thử parse cả khối trước, nếu lỗi thì parse từng dòng và ưu
// tiên dòng nào có field "data" thật.
function parseGraphQLResponse(raw) {
  const trimmed = stripAntiHijackPrefix(raw.trim());
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    // fallthrough xuống parse theo từng dòng
  }

  let lastParsed = null;
  for (const line of trimmed.split("\n")) {
    const lineTrimmed = line.trim();
    if (!lineTrimmed) continue;
    try {
      const parsed = JSON.parse(lineTrimmed);
      lastParsed = parsed;
      if (parsed?.data) return parsed;
    } catch {
      // bỏ qua dòng không phải JSON hợp lệ
    }
  }

  return lastParsed;
}

// Response lỗi generic của Facebook (dạng "for (;;);{...}") có shape khác GraphQL
// bình thường: { error, errorSummary, errorDescription } thay vì { errors: [...] }.
function extractErrorMessage(data) {
  if (!data) return null;
  if (data.errorDescription || data.errorSummary) {
    return [data.errorSummary, data.errorDescription].filter(Boolean).join(" — ");
  }
  return data.errors?.[0]?.message || null;
}

// Gọi GraphQL nội bộ (endpoint không chính thức, reverse-engineer từ request thật của
// trình duyệt — Facebook có thể đổi doc_id/field bắt buộc bất kỳ lúc nào) để tạo link
// share rút gọn dạng facebook.com/share/... từ 1 postId đã tồn tại.
async function createWrappedShareUrl({ cookie, fbDtsg, lsd, userId, postId }) {
  const originalContentUrl = `https://www.facebook.com/${postId}`;

  const form = new URLSearchParams({
    av: userId || "",
    __aaid: "0",
    __user: userId || "",
    __a: "1",
    __req: "15",
    dpr: "1",
    __ccg: "EXCELLENT",
    __rev: "1043549335",
    __comet_req: "15",
    fb_dtsg: fbDtsg,
    __spin_r: "1043549335",
    __spin_b: "trunk",
    __spin_t: String(Math.floor(Date.now() / 1000)),
    __crn: "comet.fbweb.CometSinglePostDialogRoute",
    fb_api_caller_class: "RelayModern",
    fb_api_req_friendly_name: "useLinkSharingCreateWrappedUrlMutation",
    server_timestamps: "true",
    variables: JSON.stringify({
      input: {
        actor_id: userId || "",
        client_mutation_id: "1",
        original_content_url: originalContentUrl,
        product_type: "UNKNOWN_FROM_DEEP_LINK",
      },
    }),
    doc_id: DOC_ID,
  });

  const headers = {
    accept: "*/*",
    "accept-language": "en-US,en;q=0.9",
    "content-type": "application/x-www-form-urlencoded",
    origin: "https://www.facebook.com",
    priority: "u=1, i",
    "sec-ch-prefers-color-scheme": "light",
    "sec-ch-ua": '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
    "sec-ch-ua-full-version-list":
      '"Not;A=Brand";v="8.0.0.0", "Chromium";v="150.0.7871.129", "Google Chrome";v="150.0.7871.129"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-model": '""',
    "sec-ch-ua-platform": '"Windows"',
    "sec-ch-ua-platform-version": '"15.0.0"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": USER_AGENT,
    "x-asbd-id": "359341",
    "x-fb-friendly-name": "useLinkSharingCreateWrappedUrlMutation",
    "x-fb-lsd": lsd,
    cookie,
  };

  console.log("[wrapped_url] form data:", Object.fromEntries(form));
  console.log("[wrapped_url] headers:", headers);

  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers,
    body: form.toString(),
  });

  const raw = await response.text();
  const data = parseGraphQLResponse(raw);

  if (!data) {
    throw new WrappedUrlError(
      `Facebook trả về dữ liệu không hợp lệ (HTTP ${response.status}). Đầu response: ${raw.slice(0, 300)}`
    );
  }

  const wrappedUrl = data?.data?.xfb_create_share_url_wrapper?.share_url_wrapper?.wrapped_url;
  if (!wrappedUrl) {
    const errorMessage =
      extractErrorMessage(data) ||
      `Không lấy được wrapped_url từ Facebook (HTTP ${response.status}). Đầu response: ${raw.slice(0, 300)}`;
    throw new WrappedUrlError(errorMessage);
  }

  return wrappedUrl;
}

module.exports = { createWrappedShareUrl };
