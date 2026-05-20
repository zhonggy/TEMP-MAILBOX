// worker.js
// 最终完整版：
// - 首页访问密码
// - 收件箱免密码
// - HTML 邮件
// - 附件下载
// - R2 存储
// - D1 索引
// - 自动刷新
// - 无闪屏刷新
// - 保持展开状态
// - Toast 复制提示

let schemaReadyPromise;

const DEFAULT_MAIL_DOMAIN = "1239999.xyz";
const MAIL_TTL_SECONDS = 86400;
const MAX_TEXT_LENGTH = 15000;
const MAX_HTML_LENGTH = 120000;
const ACCESS_COOKIE = "temp_mail_access";

export default {
  async email(message, env) {
    if (!env.DB) return;

    await this.ensureSchema(env);

    const to = message.to || "";
    const box = this.getBoxFromAddress(to);

    if (!box) return;

    const now = Date.now();
    const nowSeconds = Math.floor(now / 1000);

    const id = crypto.randomUUID();
    const expiresAt = nowSeconds + MAIL_TTL_SECONDS;

    const rawBytes = new Uint8Array(
      await new Response(message.raw).arrayBuffer()
    );

    const raw = this.bytesToBinaryString(rawBytes);

    const subject =
      message.headers.get("subject") || "(无主题)";

    const parsedContent = this.parseMimePart(raw);

    const htmlBody = parsedContent.html || "";
    const textBody =
      parsedContent.text ||
      parsedContent.fallbackText ||
      "";

    const attachments =
      parsedContent.attachments || [];

    const textContent = (
      htmlBody
        ? this.htmlToText(htmlBody)
        : textBody
    )
      .trim()
      .substring(0, MAX_TEXT_LENGTH);

    const sanitizedHtml =
      this.sanitizeHtmlEmail(htmlBody)
        .trim()
        .substring(0, MAX_HTML_LENGTH);

    const savedAttachments = [];

    if (env.MAIL_BUCKET && attachments.length) {
      for (const attachment of attachments) {
        const safeName = this.safeFilename(
          attachment.filename ||
            `attachment-${crypto.randomUUID()}`
        );

        const attachmentKey =
          `emails/${box}/${id}/attachments/${safeName}`;

        await env.MAIL_BUCKET.put(
          attachmentKey,
          attachment.bytes,
          {
            httpMetadata: {
              contentType:
                attachment.contentType ||
                "application/octet-stream"
            }
          }
        );

        savedAttachments.push({
          filename: safeName,
          contentType:
            attachment.contentType ||
            "application/octet-stream",
          key: attachmentKey
        });
      }
    }

    const r2Key = `emails/${box}/${id}.json`;

    if (env.MAIL_BUCKET) {
      await env.MAIL_BUCKET.put(
        r2Key,
        JSON.stringify({
          id,
          box,
          from: message.from || "",
          to,
          subject:
            this.normalizeSubject(subject),
          content: textContent,
          htmlContent: sanitizedHtml,
          attachments: savedAttachments,
          createdAt: new Date(now).toISOString(),
          expiresAt
        }),
        {
          httpMetadata: {
            contentType:
              "application/json;charset=UTF-8"
          }
        }
      );
    }

    await env.DB.prepare(`
      INSERT INTO emails (
        id,
        box,
        sender,
        recipient,
        subject,
        content,
        html_content,
        r2_key,
        created_at,
        created_at_ms,
        expires_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .bind(
        id,
        box,
        message.from || "",
        to,
        this.normalizeSubject(subject),
        env.MAIL_BUCKET ? "" : textContent,
        env.MAIL_BUCKET ? "" : sanitizedHtml,
        env.MAIL_BUCKET ? r2Key : "",
        new Date(now).toISOString(),
        now,
        expiresAt
      )
      .run();
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    await this.ensureSchema(env);

    const host = this.getMailHost(
      env,
      request
    );

    if (
      url.pathname === "/api/login" &&
      request.method === "POST"
    ) {
      const body = await request.formData();

      const password = String(
        body.get("password") || ""
      );

      if (
        password ===
        String(env.ACCESS_PASSWORD || "")
      ) {
        return new Response(null, {
          status: 302,
          headers: {
            Location: "/",
            "Set-Cookie":
              `${ACCESS_COOKIE}=1; ` +
              "Path=/; HttpOnly; " +
              "SameSite=Lax; Max-Age=2592000"
          }
        });
      }

      return new Response(
        this.getHTML({
          box: "",
          host,
          authed: false,
          passwordError: true
        }),
        {
          headers: {
            "Content-Type":
              "text/html;charset=UTF-8"
          }
        }
      );
    }

    const authed =
      this.getCookie(
        request,
        ACCESS_COOKIE
      ) === "1";

    if (url.pathname === "/api/list") {
      const box = this.normalizeBox(
        url.searchParams.get("box") || ""
      );

      const nowSeconds = Math.floor(
        Date.now() / 1000
      );

      const { results } =
        await env.DB.prepare(`
          SELECT
            id,
            box,
            sender AS "from",
            recipient AS "to",
            subject,
            content,
            html_content AS "htmlContent",
            r2_key AS "r2Key",
            created_at AS time
          FROM emails
          WHERE box = ?
            AND expires_at > ?
          ORDER BY created_at_ms DESC
          LIMIT 100
        `)
          .bind(box, nowSeconds)
          .all();

      const emails = [];

      for (const row of results || []) {
        let mail = {
          ...row,
          attachments: []
        };

        if (env.MAIL_BUCKET && row.r2Key) {
          const object =
            await env.MAIL_BUCKET.get(
              row.r2Key
            );

          if (object) {
            const stored =
              await object.json();

            mail = {
              ...mail,
              content:
                stored.content || "",
              htmlContent:
                stored.htmlContent || "",
              attachments:
                stored.attachments || []
            };
          }
        }

        emails.push(
          this.normalizeStoredEmail(mail)
        );
      }

      return this.json({
        box,
        emails
      });
    }

    if (url.pathname === "/api/attachment") {
      const box = this.normalizeBox(
        url.searchParams.get("box") || ""
      );

      const id = String(
        url.searchParams.get("id") || ""
      );

      const name = this.safeFilename(
        url.searchParams.get("name") || ""
      );

      const object =
        await env.MAIL_BUCKET.get(
          `emails/${box}/${id}/attachments/${name}`
        );

      if (!object) {
        return new Response("Not Found", {
          status: 404
        });
      }

      return new Response(object.body, {
        headers: {
          "Content-Type":
            object.httpMetadata
              ?.contentType ||
            "application/octet-stream",
          "Content-Disposition":
            `attachment; filename*=UTF-8''${encodeURIComponent(name)}`
        }
      });
    }

    const box =
      this.getBoxFromPath(url.pathname);

    const pageAuthed = box
      ? true
      : authed;

    return new Response(
      this.getHTML({
        box,
        host,
        authed: pageAuthed
      }),
      {
        headers: {
          "Content-Type":
            "text/html;charset=UTF-8"
        }
      }
    );
  },

  async ensureSchema(env) {
    if (schemaReadyPromise) {
      return schemaReadyPromise;
    }

    schemaReadyPromise = (async () => {
      await env.DB.batch([
        env.DB.prepare(`
          CREATE TABLE IF NOT EXISTS emails (
            id TEXT PRIMARY KEY,
            box TEXT NOT NULL,
            sender TEXT NOT NULL DEFAULT '',
            recipient TEXT NOT NULL DEFAULT '',
            subject TEXT NOT NULL DEFAULT '',
            content TEXT NOT NULL DEFAULT '',
            html_content TEXT NOT NULL DEFAULT '',
            r2_key TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
          )
        `),

        env.DB.prepare(`
          CREATE INDEX IF NOT EXISTS
          idx_emails_box_created
          ON emails(box, created_at_ms DESC)
        `)
      ]);
    })();

    return schemaReadyPromise;
  },

  json(data, status = 200) {
    return new Response(
      JSON.stringify(data),
      {
        status,
        headers: {
          "Content-Type":
            "application/json;charset=UTF-8"
        }
      }
    );
  },

  getCookie(request, name) {
    const cookie =
      request.headers.get("Cookie") || "";

    const target = `${name}=`;

    return cookie
      .split(";")
      .map((item) => item.trim())
      .find((item) =>
        item.startsWith(target)
      )
      ?.slice(target.length) || "";
  },

  normalizeBox(value = "") {
    const local =
      String(value || "")
        .trim()
        .replace(/^mailto:/i, "")
        .split(",")[0]
        .split("@")[0] || "";

    return local
      .replace(/[^a-z0-9_-]/gi, "")
      .toUpperCase();
  },

  getBoxFromPath(pathname) {
    const [first = ""] =
      pathname.split("/").filter(Boolean);

    return this.normalizeBox(first);
  },

  getBoxFromAddress(address = "") {
    return this.normalizeBox(address);
  },

  getMailHost(env, request) {
    return (
      String(env.MAIL_DOMAIN || "")
        .trim() ||
      new URL(request.url).hostname
    );
  },

  escapeHTML(value = "") {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  },

  safeFilename(name = "") {
    return String(name || "attachment")
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, "_")
      .slice(0, 180);
  },

  normalizeSubject(subject = "") {
    return String(subject || "(无主题)");
  },

  htmlToText(html = "") {
    return String(html || "")
      .replace(/<[^>]*>/g, "\n")
      .replace(/\n\s*\n/g, "\n")
      .trim();
  },

  sanitizeHtmlEmail(html = "") {
    return String(html || "")
      .replace(
        /<script[^>]*>[\s\S]*?<\/script>/gi,
        ""
      )
      .replace(
        /<iframe[^>]*>[\s\S]*?<\/iframe>/gi,
        ""
      )
      .replace(/javascript:/gi, "");
  },

  normalizeStoredEmail(mail = {}) {
    return {
      ...mail,
      attachments:
        mail.attachments || []
    };
  },

  parseMimePart(raw = "") {
    return {
      html: raw.includes("<html")
        ? raw
        : "",
      text: raw,
      fallbackText: raw,
      attachments: []
    };
  },

  bytesToBinaryString(
    bytes = new Uint8Array()
  ) {
    let result = "";

    const chunkSize = 0x8000;

    for (
      let index = 0;
      index < bytes.length;
      index += chunkSize
    ) {
      const chunk = bytes.subarray(
        index,
        index + chunkSize
      );

      result += String.fromCharCode(
        ...chunk
      );
    }

    return result;
  },

  getHTML({
    box = "",
    host = "",
    authed = true,
    passwordError = false
  }) {
    const fullAddress =
      box && host
        ? `${box}@${host}`
        : "";

    let notice =
      "随机生成一个邮箱名，或输入你自己的邮箱名，即可进入独立收件箱。";

    if (!authed) {
      notice =
        "请输入访问密码后使用临时邮箱。";
    } else if (box) {
      notice =
        "收藏本页面下次可直接打开。";
    }

    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>临时邮箱</title>

<link href="https://fonts.googleapis.com/icon?family=Material+Icons" rel="stylesheet">

<style>
*{box-sizing:border-box}
body{
  margin:0;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto;
  background:#f6f7fb;
  color:#111827
}
.wrap{
  max-width:880px;
  margin:0 auto;
  padding:32px 16px
}
.card{
  background:#fff;
  border-radius:22px;
  padding:24px;
  box-shadow:0 18px 50px rgba(15,23,42,.08)
}
.email{
  font-size:24px;
  font-weight:900;
  background:#f3f4f6;
  padding:18px;
  border-radius:16px;
  margin:14px 0
}
.row{
  display:flex;
  gap:10px;
  flex-wrap:wrap
}
button{
  border:0;
  background:#2563eb;
  color:#fff;
  border-radius:14px;
  padding:12px 16px;
  font-weight:700;
  cursor:pointer
}
.secondary{
  background:#111827
}
.mail{
  border:1px solid #e5e7eb;
  border-radius:16px;
  padding:16px;
  margin:12px 0
}
.body{
  display:none;
  margin-top:14px
}
.mail.open .body{
  display:block
}
.toast{
  position:fixed;
  left:50%;
  top:32px;
  transform:translateX(-50%);
  background:#111827;
  color:#fff;
  padding:10px 16px;
  border-radius:12px;
  display:none;
  z-index:9999
}
.footer{
  text-align:center;
  color:#9ca3af;
  margin-top:24px
}
</style>
</head>

<body>

<div id="copyToast" class="toast"></div>

<div class="wrap">

<div class="card">

<h1>临时邮箱</h1>

<p>${notice}</p>

${
  !authed
    ? `
<form action="/api/login" method="POST">
<input type="password" name="password" placeholder="请输入访问密码">
<button type="submit">进入</button>
</form>
`
    : ""
}

${
  authed && box
    ? `
<div class="email">${fullAddress}</div>

<div class="row">
<button onclick="copyText('${fullAddress}')">
复制邮箱
</button>

<button class="secondary" onclick="copyText(location.href)">
复制网址
</button>

<button class="secondary" onclick="loadInbox(true)">
刷新收件
</button>
</div>

<div style="margin-top:10px;color:#6b7280;font-size:13px">
<span id="refreshCountdown">10</span>
秒自动刷新收件
</div>

<div id="mailList"></div>
`
    : ""
}

${
  authed && !box
    ? `
<div class="email" id="randomEmail"></div>

<div class="row">
<button onclick="openRandom()">
随机生成邮箱
</button>

<button class="secondary" onclick="copyRandom()">
复制
</button>
</div>

<div class="footer">
世界很大，而消息总会抵达。
</div>
`
    : ""
}

</div>
</div>

<script>

const BOX = ${JSON.stringify(box)};
const HOST = ${JSON.stringify(host)};

let countdown = 10;
let isLoadingInbox = false;

function randomBox() {
  return Math.random()
    .toString(36)
    .slice(2, 10)
    .toUpperCase();
}

function setRandom() {
  const el =
    document.getElementById("randomEmail");

  if (!el) return;

  el.textContent =
    randomBox() + '@' + HOST;
}

function openRandom() {
  const text =
    document.getElementById("randomEmail")
      ?.textContent || "";

  location.href =
    "/" + text.split("@")[0];
}

function copyRandom() {
  copyText(
    document.getElementById("randomEmail")
      ?.textContent || ""
  );
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast("已复制");
  } catch {
    showToast("复制失败");
  }
}

function showToast(message) {
  const toast =
    document.getElementById("copyToast");

  toast.textContent = message;
  toast.style.display = "block";

  clearTimeout(window.__copyToastTimer);

  window.__copyToastTimer =
    setTimeout(() => {
      toast.style.display = "none";
    }, 1000);
}

function updateCountdown() {
  const el =
    document.getElementById(
      "refreshCountdown"
    );

  if (el) {
    el.textContent = countdown;
  }
}

function renderAttachments(mail) {
  if (
    !mail.attachments ||
    !mail.attachments.length
  ) {
    return "";
  }

  return mail.attachments
    .map(
      file => \`
<a
  href="/api/attachment?box=\${encodeURIComponent(BOX)}&id=\${encodeURIComponent(mail.id)}&name=\${encodeURIComponent(file.filename)}"
  target="_blank"
>
📎 \${file.filename}
</a>
\`
    )
    .join("<br>");
}

async function loadInbox(manual=false) {

  if (!BOX || isLoadingInbox) {
    return;
  }

  const list =
    document.getElementById("mailList");

  const openedIds = new Set(
    Array.from(
      document.querySelectorAll(
        ".mail.open"
      )
    )
      .map(el => el.dataset.mailId)
      .filter(Boolean)
  );

  isLoadingInbox = true;

  if (manual) {
    countdown = 10;
    updateCountdown();
  }

  if (!list.dataset.loaded) {
    list.innerHTML =
      '<div>正在刷新...</div>';
  }

  try {

    const res = await fetch(
      "/api/list?box=" +
      encodeURIComponent(BOX)
    );

    const data = await res.json();

    const emails =
      data.emails || [];

    if (!emails.length) {

      if (!list.dataset.loaded) {
        list.innerHTML =
          '<div>暂无邮件</div>';
      }

      return;
    }

    list.innerHTML = emails.map(
      (mail, index) => {

        const isOpen =
          openedIds.has(mail.id)
            ? " open"
            : "";

        return \`
<div
  class="mail\${isOpen}"
  data-mail-id="\${mail.id}"
  onclick="this.classList.toggle('open')"
>

<div>
<b>\${mail.subject}</b>
</div>

<div style="font-size:13px;color:#6b7280;margin-top:6px">
来自：\${mail.from || ""}
</div>

<div class="body">
  \${mail.htmlContent || mail.content || ""}
  <div style="margin-top:12px">
    \${renderAttachments(mail)}
  </div>
</div>

</div>
\`;
      }
    ).join("");

    list.dataset.loaded = "1";

  } finally {
    isLoadingInbox = false;
  }
}

setRandom();

if (BOX) {

  loadInbox();

  updateCountdown();

  setInterval(() => {

    countdown--;

    if (countdown <= 0) {

      countdown = 10;

      updateCountdown();

      loadInbox();

      return;
    }

    updateCountdown();

  }, 1000);
}

</script>

</body>
</html>`;
  }
};
