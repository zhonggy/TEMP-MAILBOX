let schemaReadyPromise;

const DEFAULT_MAIL_DOMAIN = "1239999.xyz";

// 解析多个域名（逗号分隔），返回数组
function parseMailDomains(env) {
  const raw = String(env.MAIL_DOMAINS || env.MAIL_DOMAIN || "").trim();
  if (!raw) return [DEFAULT_MAIL_DOMAIN];
  const domains = raw.split(",").map(d => d.trim().toLowerCase()).filter(Boolean);
  return domains.length > 0 ? domains : [DEFAULT_MAIL_DOMAIN];
}
// 邮件存储时间为 1 年 (365 * 24 * 60 * 60)
const MAIL_TTL_SECONDS = 31536000;
const MAX_TEXT_LENGTH = 15000;
const MAX_HTML_LENGTH = 120000;
const STATS_TIMEZONE = "Asia/Shanghai";
const ACCESS_COOKIE = "temp_mail_access";

const EMPTY_STATS = {
  todayCount: 0,
  last30DaysCount: 0,
  totalCount: 0,
  currentDbCount: 0,
  mailboxCount: 0,
  storageUsed: 0
};

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

    const rawBytes = new Uint8Array(await new Response(message.raw).arrayBuffer());
    const raw = this.bytesToBinaryString(rawBytes);

    const subject = message.headers.get("subject") || "(无主题)";
    const parsedContent = this.parseMimePart(raw);
    const htmlBody = parsedContent.html || "";
    const textBody = parsedContent.text || parsedContent.fallbackText || "";
    const attachments = parsedContent.attachments || [];

    const textContent = (htmlBody ? this.htmlToText(htmlBody) : textBody)
      .trim()
      .substring(0, MAX_TEXT_LENGTH);

    const sanitizedHtml = this.sanitizeHtmlEmail(htmlBody)
      .trim()
      .substring(0, MAX_HTML_LENGTH);

    const savedAttachments = [];

    if (env.MAIL_BUCKET && attachments.length) {
      for (const attachment of attachments) {
        const safeName = this.safeFilename(attachment.filename || `attachment-${crypto.randomUUID()}`);
        const attachmentKey = `emails/${box}/${id}/attachments/${safeName}`;

        await env.MAIL_BUCKET.put(attachmentKey, attachment.bytes, {
          httpMetadata: {
            contentType: attachment.contentType || "application/octet-stream"
          }
        });

        savedAttachments.push({
          filename: safeName,
          contentType: attachment.contentType || "application/octet-stream",
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
          subject: this.normalizeSubject(subject),
          content: textContent,
          htmlContent: sanitizedHtml,
          raw,
          attachments: savedAttachments,
          createdAt: this.formatBeijingTime(now),
          expiresAt
        }),
        {
          httpMetadata: {
            contentType: "application/json;charset=UTF-8"
          }
        }
      );
    }

    await env.DB.prepare(`
      INSERT INTO emails (
        id, box, sender, recipient, subject,
        content, html_content, r2_key,
        created_at, created_at_ms, expires_at
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
        this.formatBeijingTime(now),
        now,
        expiresAt
      )
      .run();

    await this.incrementMailStats(env, now);
    await this.maybeCleanupExpiredEmails(env, nowSeconds);
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const host = this.getMailHost(env, request);
    const domains = this.getMailDomains(env);

    if (!env.DB) {
      return new Response(this.getHTML({
        box: "",
        host,
        domains,
        missingDb: true,
        stats: EMPTY_STATS,
        authed: false
      }), {
        status: 500,
        headers: { "Content-Type": "text/html;charset=UTF-8" }
      });
    }

    await this.ensureSchema(env);

    // 登录接口
    if (url.pathname === "/api/login" && request.method === "POST") {
      const body = await request.formData();
      const password = String(body.get("password") || "");

      if (env.ACCESS_PASSWORD && password === String(env.ACCESS_PASSWORD)) {
        return new Response(null, {
          status: 302,
          headers: {
            "Location": "/",
            "Set-Cookie": `${ACCESS_COOKIE}=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`
          }
        });
      }

      const stats = await this.getMailStats(env);
      return new Response(this.getHTML({
        box: "",
        host,
        domains,
        missingDb: false,
        stats,
        authed: false,
        passwordError: true
      }), {
        status: 401,
        headers: { "Content-Type": "text/html;charset=UTF-8" }
      });
    }

    // --- 🔑 【核心修改：白名单免密鉴权逻辑】 ---
    const currentBox = this.getBoxFromPath(url.pathname) || this.normalizeBox(url.searchParams.get("box") || "");
    
    // 如果设置了 ACCESS_PASSWORD，默认需要校验 Cookie
    const hasPassword = String(env.ACCESS_PASSWORD || "").trim().length > 0;
    let authed = hasPassword ? this.getCookie(request, ACCESS_COOKIE) === "1" : true;

    // 特殊放行：如果是直接访问具体的邮箱路径（如 /11）或者拉取该邮箱的 API，则直接免密放行
    if (currentBox) {
      authed = true;
    }

    // API 安全拦截：只有在既没有密码 Cookie，又没有邮箱白名单时，才拦截防止被刷
    if (url.pathname.startsWith("/api/")) {
      if (!authed) {
        return this.json({ error: "Unauthorized access denied." }, 401);
      }
    }

    // 附件下载接口
    if (url.pathname === "/api/attachment") {
      const box = this.normalizeBox(url.searchParams.get("box") || "");
      const id = String(url.searchParams.get("id") || "").replace(/[^a-z0-9-]/gi, "");
      const name = this.safeFilename(url.searchParams.get("name") || "");

      if (!box || !id || !name || !env.MAIL_BUCKET) {
        return new Response("Not Found", { status: 404 });
      }

      const nowSeconds = Math.floor(Date.now() / 1000);
      const mail = await env.DB.prepare(`
        SELECT r2_key AS r2Key
        FROM emails
        WHERE id = ? AND box = ? AND expires_at > ?
        LIMIT 1
      `).bind(id, box, nowSeconds).first();

      if (!mail) return new Response("Not Found", { status: 404 });

      const object = await env.MAIL_BUCKET.get(`emails/${box}/${id}/attachments/${name}`);
      if (!object) return new Response("Not Found", { status: 404 });

      return new Response(object.body, {
        headers: {
          "Content-Type": object.httpMetadata?.contentType || "application/octet-stream",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`
        }
      });
    }

    // 邮件列表接口
    if (url.pathname === "/api/list") {
      const box = this.normalizeBox(url.searchParams.get("box") || "");
      if (!box) {
        return this.json({ box, host, emails: [], fetchedAt: this.formatBeijingTime(new Date()) });
      }

      const nowSeconds = Math.floor(Date.now() / 1000);
      const { results } = await env.DB.prepare(`
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
        WHERE box = ? AND expires_at > ?
        ORDER BY created_at_ms DESC
        LIMIT 100
      `)
        .bind(box, nowSeconds)
        .all();

      await this.maybeCleanupExpiredEmails(env, nowSeconds);

      const emails = [];
      for (const row of results || []) {
        let mail = { ...row, attachments: [] };

        if (env.MAIL_BUCKET && row.r2Key) {
          const object = await env.MAIL_BUCKET.get(row.r2Key);
          if (object) {
            const stored = await object.json();
            mail = {
              ...mail,
              content: stored.content || "",
              htmlContent: stored.htmlContent || "",
              attachments: Array.isArray(stored.attachments) ? stored.attachments : []
            };
          }
        }

        emails.push(this.normalizeStoredEmail(mail));
      }

      const stats = await this.getMailStats(env);
      return this.json({ box, host, emails, fetchedAt: this.formatBeijingTime(new Date()), stats });
    }

    const box = this.getBoxFromPath(url.pathname);
    const stats = await this.getMailStats(env);

    // 从查询参数获取选中的域名，如果没有则使用主域名
    const selectedDomain = url.searchParams.get("domain") || host;

    return new Response(this.getHTML({
      box,
      host: selectedDomain,
      domains,
      missingDb: false,
      stats,
      authed: authed
    }), {
      headers: { "Content-Type": "text/html;charset=UTF-8" }
    });
  },

  async ensureSchema(env) {
    if (!schemaReadyPromise) {
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
          env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_emails_box_created ON emails(box, created_at_ms DESC)"),
          env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_emails_expires_at ON emails(expires_at)"),
          env.DB.prepare(`
            CREATE TABLE IF NOT EXISTS mail_stats_daily (
              day_key TEXT PRIMARY KEY,
              received_count INTEGER NOT NULL DEFAULT 0
            )
          `)
        ]);

        await this.ensureColumn(env, "content", "TEXT NOT NULL DEFAULT ''");
        await this.ensureColumn(env, "html_content", "TEXT NOT NULL DEFAULT ''");
        await this.ensureColumn(env, "r2_key", "TEXT NOT NULL DEFAULT ''");
        await this.ensureColumn(env, "expires_at", "INTEGER NOT NULL DEFAULT 0");
      })().catch((error) => {
        schemaReadyPromise = undefined;
        throw error;
      });
    }

    return schemaReadyPromise;
  },

  async ensureColumn(env, columnName, definition) {
    const tableInfo = await env.DB.prepare("PRAGMA table_info(emails)").all();
    const columns = Array.isArray(tableInfo.results) ? tableInfo.results : [];

    if (!columns.some((column) => column.name === columnName)) {
      await env.DB.prepare(`ALTER TABLE emails ADD COLUMN ${columnName} ${definition}`).run();
    }
  },

  async maybeCleanupExpiredEmails(env, nowSeconds) {
    if (Math.random() >= 0.02) return;

    const { results } = await env.DB.prepare(
      "SELECT id, box, r2_key AS r2Key FROM emails WHERE expires_at <= ? LIMIT 100"
    ).bind(nowSeconds).all();

    if (env.MAIL_BUCKET && results?.length) {
      const deletePromises = results.map(async (row) => {
        if (!row.r2Key) return;
        try {
          const object = await env.MAIL_BUCKET.get(row.r2Key);
          if (object) {
            const stored = await object.json();
            const files = stored.attachments || [];
            await Promise.all(files.map(file => file.key ? env.MAIL_BUCKET.delete(file.key) : Promise.resolve()));
          }
          await env.MAIL_BUCKET.delete(row.r2Key);
        } catch {}
      });
      await Promise.all(deletePromises);
    }

    await env.DB.prepare("DELETE FROM emails WHERE expires_at <= ?")
      .bind(nowSeconds)
      .run();
  },

  getStatsDayKey(timestampMs = Date.now()) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: STATS_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date(timestampMs));

    const map = Object.fromEntries(
      parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value])
    );

    return `${map.year}-${map.month}-${map.day}`;
  },

  async incrementMailStats(env, timestampMs) {
    const dayKey = this.getStatsDayKey(timestampMs);

    await env.DB.prepare(`
      INSERT INTO mail_stats_daily (day_key, received_count)
      VALUES (?, 1)
      ON CONFLICT(day_key) DO UPDATE SET received_count = received_count + 1
    `).bind(dayKey).run();
  },

  async getMailStats(env) {
    const todayKey = this.getStatsDayKey();
    const last30DaysKey = this.getStatsDayKey(Date.now() - 29 * 24 * 60 * 60 * 1000);

    const result = await env.DB.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN day_key = ? THEN received_count ELSE 0 END), 0) AS todayCount,
        COALESCE(SUM(CASE WHEN day_key >= ? THEN received_count ELSE 0 END), 0) AS last30DaysCount,
        COALESCE(SUM(received_count), 0) AS totalCount
      FROM mail_stats_daily
    `).bind(todayKey, last30DaysKey).first();

    const dbCountResult = await env.DB.prepare("SELECT COUNT(*) AS currentDbCount FROM emails").first();

    // 获取创建的邮箱数量（distinct box 数量）
    const mailboxCountResult = await env.DB.prepare("SELECT COUNT(DISTINCT box) AS mailboxCount FROM emails").first();

    // 获取 R2 存储使用量
    let storageUsed = 0;
    if (env.MAIL_BUCKET) {
      try {
        let cursor;
        do {
          const listResult = await env.MAIL_BUCKET.list({ cursor, limit: 1000 });
          for (const obj of listResult.objects) {
            storageUsed += obj.size || 0;
          }
          cursor = listResult.truncated ? listResult.cursor : undefined;
        } while (cursor);
      } catch {
        // 如果 R2 查询失败，使用估算值
        storageUsed = -1;
      }
    }

    return {
      todayCount: Number(result?.todayCount || 0),
      last30DaysCount: Number(result?.last30DaysCount || 0),
      totalCount: Number(result?.totalCount || 0),
      currentDbCount: Number(dbCountResult?.currentDbCount || 0),
      mailboxCount: Number(mailboxCountResult?.mailboxCount || 0),
      storageUsed: storageUsed
    };
  },

  json(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json;charset=UTF-8" }
    });
  },

  getCookie(request, name) {
    const cookie = request.headers.get("Cookie") || "";
    const target = `${name}=`;

    return cookie
      .split(";")
      .map((item) => item.trim())
      .find((item) => item.startsWith(target))
      ?.slice(target.length) || "";
  },

  parseMimePart(rawPart = "") {
    const { headerText, body } = this.splitHeadersAndBody(rawPart);
    const headers = this.parseHeaders(headerText);

    const contentType = this.getHeaderValue(headers, "content-type");
    const transferEncoding = this.getHeaderValue(headers, "content-transfer-encoding");
    const contentDisposition = this.getHeaderValue(headers, "content-disposition");

    const mimeType = contentType.split(";")[0].trim().toLowerCase();
    const boundary = this.getHeaderParameter(contentType, "boundary");
    const inferredBoundary = !contentType ? this.inferLeadingBoundary(body) : "";
    const effectiveBoundary = boundary || inferredBoundary;
    const charset = this.getHeaderParameter(contentType, "charset") || "utf-8";
    const dispositionType = contentDisposition.split(";")[0].trim().toLowerCase();

    if (mimeType === "message/rfc822") return this.parseMimePart(body);

    if ((mimeType.startsWith("multipart/") || (!mimeType && effectiveBoundary)) && effectiveBoundary) {
      let html = "";
      let text = "";
      let fallbackText = "";
      let attachments = [];

      for (const part of this.splitMultipartBody(body, effectiveBoundary)) {
        const parsed = this.parseMimePart(part);
        if (!text && parsed.text) text = parsed.text;
        if (!html && parsed.html) html = parsed.html;
        if (!fallbackText && parsed.fallbackText) fallbackText = parsed.fallbackText;
        if (parsed.attachments?.length) attachments = attachments.concat(parsed.attachments);
      }

      return { html, text, fallbackText, attachments };
    }

    const filename =
      this.decodeMimeWord(this.getHeaderParameter(contentDisposition, "filename") || "") ||
      this.decodeMimeWord(this.getHeaderParameter(contentType, "name") || "");

    const isAttachment =
      dispositionType === "attachment" ||
      Boolean(filename && mimeType && !mimeType.startsWith("text/"));

    if (isAttachment) {
      return {
        html: "",
        text: "",
        fallbackText: "",
        attachments: [{
          filename: filename || `attachment-${crypto.randomUUID()}`,
          contentType: mimeType || "application/octet-stream",
          bytes: this.decodeAttachmentBytes(body, transferEncoding)
        }]
      };
    }

    if (mimeType && !mimeType.startsWith("text/")) {
      return { html: "", text: "", fallbackText: "", attachments: [] };
    }

    const decoded = this.decodeBodyContent(body, transferEncoding, charset);

    if (mimeType === "text/html") {
      return { html: decoded, text: "", fallbackText: this.htmlToText(decoded), attachments: [] };
    }

    if (mimeType === "text/plain" || mimeType === "" || mimeType.startsWith("text/")) {
      return { html: "", text: decoded, fallbackText: decoded, attachments: [] };
    }

    return { html: "", text: "", fallbackText: "", attachments: [] };
  },

  splitHeadersAndBody(rawPart = "") {
    const source = String(rawPart || "");
    const separatorMatch = source.match(/\r?\n\r?\n/);

    if (!separatorMatch || separatorMatch.index === undefined) {
      return { headerText: "", body: source };
    }

    return {
      headerText: source.slice(0, separatorMatch.index),
      body: source.slice(separatorMatch.index + separatorMatch[0].length)
    };
  },

  parseHeaders(headerText = "") {
    const headers = {};
    const lines = String(headerText || "").split(/\r?\n/);
    let currentName = "";

    for (const line of lines) {
      if (/^[ \t]/.test(line) && currentName) {
        headers[currentName] += ` ${line.trim()}`;
        continue;
      }

      const separatorIndex = line.indexOf(":");
      if (separatorIndex <= 0) continue;

      currentName = line.slice(0, separatorIndex).trim().toLowerCase();
      headers[currentName] = line.slice(separatorIndex + 1).trim();
    }

    return headers;
  },

  getHeaderValue(headers, name) {
    return String(headers?.[String(name || "").toLowerCase()] || "");
  },

  inferLeadingBoundary(body = "") {
    const match = String(body || "").match(/^--([^\r\n]{1,120})\r?\n(?:[A-Za-z-]+:|\r?\n)/);
    return match ? match[1].trim() : "";
  },

  getHeaderParameter(headerValue, name) {
    const safeName = String(name || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = String(headerValue || "").match(new RegExp(`${safeName}\\*?=(?:"([^"]+)"|([^;]+))`, "i"));

    if (!match) return "";

    let value = (match[1] || match[2] || "").trim().replace(/^['"]|['"]$/g, "");
    const encodedPrefixIndex = value.indexOf("''");

    if (encodedPrefixIndex >= 0) {
      value = value.slice(encodedPrefixIndex + 2);
      try {
        value = decodeURIComponent(value);
      } catch {}
    }

    return value;
  },

  splitMultipartBody(body = "", boundary = "") {
    if (!boundary) return [];

    const parts = [];
    const marker = `--${boundary}`;
    const sections = String(body || "").split(marker);

    for (const section of sections.slice(1)) {
      if (/^\s*--\s*$/.test(section)) break;

      let normalized = section.replace(/^\r?\n/, "");
      normalized = normalized.replace(/\r?\n--\s*$/, "");
      normalized = normalized.replace(/\r?\n$/, "");

      if (!normalized.trim()) continue;
      parts.push(normalized);
    }

    return parts;
  },

  decodeBodyContent(body = "", transferEncoding = "", charset = "utf-8") {
    try {
      const normalizedEncoding = String(transferEncoding || "").trim().toLowerCase();
      let bytes;

      if (normalizedEncoding.includes("base64")) {
        const compact = String(body || "").replace(/\s/g, "");
        if (!compact) return "";
        const binary = atob(compact);
        bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0) & 0xff);
      } else if (normalizedEncoding.includes("quoted-printable")) {
        bytes = this.decodeQuotedPrintableToBytes(body);
      } else {
        bytes = this.binaryStringToBytes(body);
      }

      return this.decodeBytes(bytes, charset);
    } catch {
      return String(body || "");
    }
  },

  decodeAttachmentBytes(body = "", transferEncoding = "") {
    const encoding = String(transferEncoding || "").trim().toLowerCase();

    if (encoding.includes("base64")) {
      const binary = atob(String(body || "").replace(/\s/g, ""));
      return Uint8Array.from(binary, (char) => char.charCodeAt(0) & 0xff);
    }

    if (encoding.includes("quoted-printable")) {
      return this.decodeQuotedPrintableToBytes(body);
    }

    return this.binaryStringToBytes(body);
  },

  decodeQuotedPrintableToBytes(value = "") {
    const input = String(value || "").replace(/=\r?\n/g, "");
    const bytes = [];

    for (let index = 0; index < input.length; index += 1) {
      const char = input[index];
      const nextPair = input.slice(index + 1, index + 3);

      if (char === "=" && /^[0-9A-Fa-f]{2}$/.test(nextPair)) {
        bytes.push(parseInt(nextPair, 16));
        index += 2;
        continue;
      }

      bytes.push(input.charCodeAt(index) & 0xff);
    }

    return Uint8Array.from(bytes);
  },

  binaryStringToBytes(value = "") {
    return Uint8Array.from(String(value || ""), (char) => char.charCodeAt(0) & 0xff);
  },

  bytesToBinaryString(bytes = new Uint8Array()) {
    let result = "";
    const chunkSize = 0x8000;

    for (let index = 0; index < bytes.length; index += chunkSize) {
      const chunk = bytes.subarray(index, index + chunkSize);
      result += String.fromCharCode(...chunk);
    }

    return result;
  },

  decodeBytes(bytes, charset) {
    const candidates = [];
    const normalizedCharset = this.normalizeCharset(charset);

    if (normalizedCharset) candidates.push(normalizedCharset);
    if (normalizedCharset !== "utf-8") candidates.push("utf-8");

    for (const candidate of candidates) {
      try {
        return new TextDecoder(candidate).decode(bytes);
      } catch {}
    }

    return this.bytesToBinaryString(bytes);
  },

  normalizeCharset(charset = "") {
    const normalized = String(charset || "").trim().replace(/^['"]|['"]$/g, "").toLowerCase();

    if (!normalized) return "utf-8";
    if (normalized === "utf8") return "utf-8";
    if (normalized === "us-ascii" || normalized === "ascii") return "utf-8";
    if (normalized === "gb2312" || normalized === "gb_2312-80" || normalized === "x-gbk") return "gbk";

    return normalized;
  },

  universalDecode(data, encoding, charset) {
    try {
      let bytes;

      if (encoding === "base64") {
        const binary = atob(String(data || "").replace(/\s/g, ""));
        bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0) & 0xff);
      } else if (encoding === "qp") {
        bytes = this.decodeQuotedPrintableToBytes(String(data || "").replace(/_/g, " "));
      } else {
        bytes = this.binaryStringToBytes(data);
      }

      return this.decodeBytes(bytes, charset);
    } catch {
      return data;
    }
  },

  decodeMimeWord(str = "") {
    return String(str || "").replace(/=\?([^?]+)\?([QB])\?([^?]+)\?=/gi, (_match, charset, encoding, data) => {
      const normalizedEncoding = encoding.toLowerCase() === "b" ? "base64" : "qp";
      return this.universalDecode(data, normalizedEncoding, charset);
    });
  },

  normalizeSubject(subject = "") {
    const rawSubject = String(subject || "").trim();
    if (!rawSubject) return "(无主题)";

    const decodedSubject = this.decodeMimeWord(rawSubject).trim();
    const candidates = [decodedSubject, rawSubject];

    for (const candidate of candidates) {
      if (!candidate) continue;
      if (candidate === "(无主题)") return candidate;
      if (candidate.includes("鏃犱富棰")) continue;
      if (/^\((?:\?{2,}|[^\w\s]{2,})\)$/.test(candidate)) continue;
      return candidate;
    }

    return "(无主题)";
  },

  htmlToText(html = "") {
    return String(html || "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<[^>]*>/g, (tag) => tag.match(/br|p|div|tr|li|table|td|th|h[1-6]/i) ? "\n" : "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, "\"")
      .replace(/&#39;/gi, "'")
      .replace(/\n\s*\n/g, "\n")
      .trim();
  },

  normalizeStoredEmail(mail = {}) {
    const rawSubject = String(mail.subject || "");
    const existingHtml = String(mail.htmlContent || "");
    const existingText = String(mail.content || "");

    const parsed = existingHtml ? { html: "", text: "", fallbackText: "", attachments: [] } : this.parseMimePart(existingText);
    const htmlContent = this.sanitizeHtmlEmail(existingHtml || parsed.html || "")
      .trim()
      .substring(0, MAX_HTML_LENGTH);

    const textContent = (htmlContent ? this.htmlToText(htmlContent) : (parsed.text || parsed.fallbackText || existingText))
      .trim()
      .substring(0, MAX_TEXT_LENGTH);

    return {
      ...mail,
      subject: this.normalizeSubject(rawSubject),
      content: textContent,
      htmlContent,
      attachments: Array.isArray(mail.attachments) ? mail.attachments : []
    };
  },

  sanitizeHtmlEmail(html = "") {
    return String(html || "")
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, "")
      .replace(/\son[a-z]+\s*=\s*["'][^"']*["']/gi, "")
      .replace(/javascript:/gi, "");
  },

  safeFilename(name = "") {
    const decoded = this.decodeMimeWord(String(name || "attachment"));
    return decoded
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, "_")
      .replace(/^\.+/, "")
      .slice(0, 180) || "attachment";
  },

  normalizeBox(value = "") {
    let input = String(value || "").trim().replace(/^mailto:/i, "");

    try {
      input = decodeURIComponent(input);
    } catch {}

    const localPart = input.split(",")[0].split("@")[0] || "";
    return localPart.replace(/[^a-z0-9_-]/gi, "").toUpperCase();
  },

  getBoxFromPath(pathname) {
    const [firstSegment = ""] = pathname.split("/").filter(Boolean);
    return this.normalizeBox(firstSegment);
  },

  getBoxFromAddress(address = "") {
    return this.normalizeBox(address);
  },

  getMailHost(env, request) {
    const domains = parseMailDomains(env);
    return domains[0];
  },

  getMailDomains(env) {
    return parseMailDomains(env);
  },

  escapeHTML(value = "") {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  },

  // 格式化存储大小
  formatStorageSize(bytes) {
    if (bytes < 0) return "计算中...";
    if (bytes === 0) return "0 B";

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let unitIndex = 0;
    let size = bytes;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(2)} ${units[unitIndex]}`;
  },

  // 格式化为北京时间 (UTC+8)
  formatBeijingTime(date) {
    const d = date instanceof Date ? date : new Date(date);
    if (isNaN(d.getTime())) return "";
    const offset = 8 * 60; // UTC+8 in minutes
    const local = new Date(d.getTime() + offset * 60 * 1000);
    const year = local.getUTCFullYear();
    const month = String(local.getUTCMonth() + 1).padStart(2, '0');
    const day = String(local.getUTCDate()).padStart(2, '0');
    const hours = String(local.getUTCHours()).padStart(2, '0');
    const minutes = String(local.getUTCMinutes()).padStart(2, '0');
    const seconds = String(local.getUTCSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  },

  getHTML({ box = "", host = "", domains = [], missingDb = false, stats = EMPTY_STATS, authed = true, passwordError = false }) {
    const title = box ? `${box} 临时邮箱` : "临时邮箱";
    const escapedBox = this.escapeHTML(box);
    const escapedHost = this.escapeHTML(host);
    const fullAddress = box && host ? `${escapedBox}@${escapedHost}` : "";
    const domainsJson = JSON.stringify(domains);

    let notice = "随机生成一个邮箱名，或输入你自己的邮箱名，即可进入独立收件箱。";
    if (missingDb) notice = "当前还没有绑定 D1 数据库，请先完成 D1 配置后再访问。";
    else if (!authed) notice = "请输入访问密码后使用临时邮箱。";
    else if (box) notice = "收藏本页面下次可直接打开^o^";

    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <link href="https://fonts.googleapis.com/icon?family=Material+Icons" rel="stylesheet">
  <style>
    *{box-sizing:border-box}
    body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;background:#f6f7fb;color:#111827}
    a{color:inherit;text-decoration:none}
    .wrap{max-width:880px;margin:0 auto;padding:32px 16px}
    .header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px}
    .brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:22px}
    .brand .material-icons{color:#2563eb}
    .card{background:#fff;border-radius:22px;box-shadow:0 18px 50px rgba(15,23,42,.08);padding:24px;margin-bottom:18px}
    .title{font-size:30px;font-weight:900;margin:0 0 8px}
    .notice{color:#6b7280;margin:0 0 22px;line-height:1.7}
    .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
    .email{font-size:24px;font-weight:900;word-break:break-all;background:#f3f4f6;border-radius:16px;padding:18px;margin:14px 0}
    button,.btn{border:0;background:#2563eb;color:#fff;border-radius:14px;padding:12px 16px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
    button.secondary,.btn.secondary{background:#111827}
    input{border:1px solid #e5e7eb;border-radius:14px;padding:13px 14px;font-size:16px;flex:1;min-width:220px}
    .hint{font-size:13px;color:#6b7280;margin-top:10px}
    .mail{border:1px solid #e5e7eb;border-radius:16px;padding:16px;margin:12px 0}
    .mail-head{display:flex;justify-content:space-between;gap:12px;cursor:pointer}
    .subject{font-weight:800}
    .meta{font-size:13px;color:#6b7280;margin-top:6px}
    .body{display:none;margin-top:14px;padding-top:14px;border-top:1px solid #e5e7eb;line-height:1.7;white-space:pre-wrap;overflow-x:auto;word-break:break-word;max-width:100%}
    .body img,.body video{max-width:100%!important;height:auto!important}
    .body table{max-width:100%!important;table-layout:fixed!important;word-break:break-word;border-collapse:collapse}
    .body td,.body th,.body div,.body p{max-width:100%!important;word-break:break-word!important;overflow-wrap:break-word!important}
    .body *{min-width:0!important}
    .mail.open .body{display:block}
    .attachment-list{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
    .attachment-link{background:#111827;color:#fff;border-radius:12px;padding:9px 12px;font-size:13px;font-weight:700;display:inline-flex;align-items:center;gap:5px}
    .empty{text-align:center;color:#6b7280;padding:28px}
    .footer{text-align:center;color:#9ca3af;font-size:13px;margin:24px 0}
    .error{background:#fee2e2;color:#991b1b;border-radius:12px;padding:10px 12px;margin-bottom:14px}
    .toast{position:fixed;left:50%;top:32px;transform:translateX(-50%);background:#111827;color:#fff;padding:10px 16px;border-radius:12px;font-size:14px;font-weight:700;z-index:9999;box-shadow:0 10px 30px rgba(0,0,0,.2);display:none}
    @media(max-width:640px){
      .wrap{padding:18px 10px}
      .title{font-size:24px}
      .email{font-size:19px;padding:14px}
      .card{padding:16px;border-radius:16px}
      button,.btn{padding:14px 14px;font-size:15px;border-radius:12px}
      input,select{min-width:0;padding:12px;font-size:15px}
      #domainSelect{min-width:120px;flex:1}
      .mail{padding:12px}
      .mail-head{flex-direction:column;gap:6px}
      .brand{font-size:18px}
      .attachment-link{font-size:12px;padding:8px 10px}
      .body{padding:10px 0}
      .body table{font-size:14px}
    }
  </style>
</head>
<body>
  <div id="copyToast" class="toast"></div>

  <div class="wrap">
    <div class="header">
      <a class="brand" href="/">
        <span class="material-icons">mail</span>
        <span>临时邮箱</span>
      </a>
    </div>

    <div class="card">
      <h1 class="title">${box ? "当前收件箱" : "快速开始"}</h1>
      <p class="notice">${notice}</p>

      ${missingDb ? `
        <div class="error">缺少 D1 绑定。请在 Cloudflare Worker 的绑定设置里添加 DB，然后刷新页面。</div>
      ` : ""}

      ${!missingDb && !authed ? `
        ${passwordError ? `<div class="error">访问密码错误，请重新输入。</div>` : ""}
        <form action="/api/login" method="POST" class="row">
          <input type="password" name="password" placeholder="请输入访问密码" autocomplete="current-password" required>
          <button type="submit"><span class="material-icons">lock_open</span>进入</button>
        </form>
      ` : ""}

      ${!missingDb && authed && box ? `
        <div class="email" id="emailText">${fullAddress}</div>
        <div class="row">
          <button onclick="copyText('${fullAddress}')"><span class="material-icons">content_copy</span>复制邮箱</button>
          <button class="secondary" onclick="copyText(location.href)"><span class="material-icons">link</span>复制网址</button>
          <button class="secondary" onclick="loadInbox(true)"><span class="material-icons">refresh</span>刷新收件</button>
        </div>
        <div class="hint">
          <span id="refreshCountdown">30</span> 秒自动刷新收件
        </div>
        <div id="mailList" style="margin-top:18px"></div>
      ` : ""}

      ${!missingDb && authed && !box ? `
        <div class="email" id="randomEmail"></div>
        <div class="row">
          <button onclick="openRandom()"><span class="material-icons">auto_fix_high</span>随机生成邮箱</button>
          <button class="secondary" onclick="copyRandom()"><span class="material-icons">content_copy</span>复制</button>
        </div>
        <div class="row" style="margin-top:14px">
          <input id="customBox" placeholder="输入自定义名称">
          <select id="domainSelect" style="padding:12px;font-size:15px;border-radius:12px;border:1px solid #d0d5dd;min-width:140px">
            ${domains.map(d => `<option value="${this.escapeHTML(d)}" ${d === host ? 'selected' : ''}>@${this.escapeHTML(d)}</option>`).join('')}
          </select>
          <button onclick="openCustom()"><span class="material-icons">inbox</span>进入收件箱</button>
        </div>
        <div class="hint">可输入邮箱名前缀或完整邮箱地址，系统只使用 @ 前面的邮箱名。</div>
      ` : ""}
    </div>

    ${!missingDb && authed && !box ? `
    <div class="stats-info" style="text-align:center;color:#6b7280;font-size:13px;margin:16px 0;line-height:1.8">
      已创建 <strong style="color:#2563eb">${stats.mailboxCount}</strong> 个邮箱 ·
      共接收 <strong style="color:#2563eb">${stats.totalCount}</strong> 封邮件 ·
      已使用 <strong style="color:#2563eb">${this.formatStorageSize(stats.storageUsed)}</strong> 存储
    </div>
    ` : ""}
    <div class="footer">© 2026 愿你收到的每一封邮件，都带着期待与惊喜。</div>
  </div>

<script>
const BOX = ${JSON.stringify(box)};
const HOST = ${JSON.stringify(host)};
const DOMAINS = ${domainsJson};
let countdown = 30;
let isLoadingInbox = false;

function normalizeBox(value) {
  const local = String(value || '').trim().replace(/^mailto:/i, '').split(',')[0].split('@')[0] || '';
  return local.replace(/[^a-z0-9_-]/gi, '').toUpperCase();
}

function randomBox() {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

function getSelectedDomain() {
  const sel = document.getElementById('domainSelect');
  return sel ? sel.value : HOST;
}

function setRandom() {
  const el = document.getElementById('randomEmail');
  if (!el) return;
  el.textContent = randomBox() + '@' + getSelectedDomain();
}

function openRandom() {
  const text = document.getElementById('randomEmail')?.textContent || '';
  const box = normalizeBox(text);
  const domain = getSelectedDomain();
  if (box) location.href = '/' + box + '?domain=' + encodeURIComponent(domain);
}

function copyRandom() {
  const text = document.getElementById('randomEmail')?.textContent || '';
  copyText(text);
}

function openCustom() {
  const box = normalizeBox(document.getElementById('customBox')?.value || '');
  const domain = getSelectedDomain();
  if (box) location.href = '/' + box + '?domain=' + encodeURIComponent(domain);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('已复制');
  } catch {
    showToast('复制失败');
  }
}

function showToast(message) {
  const toast = document.getElementById('copyToast');
  if (!toast) return;

  toast.textContent = message;
  toast.style.display = 'block';

  clearTimeout(window.__copyToastTimer);
  window.__copyToastTimer = setTimeout(() => {
    toast.style.display = 'none';
  }, 1000);
}

function escapeHTML(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function updateCountdown() {
  const el = document.getElementById('refreshCountdown');
  if (el) el.textContent = countdown;
}

function renderAttachments(mail) {
  const files = Array.isArray(mail.attachments) ? mail.attachments : [];
  if (!files.length) return '';

  return \`
    <div class="meta" style="margin-top:12px">附件：</div>
    <div class="attachment-list">
      \${files.map((file) => \`
        <a class="attachment-link"
           onclick="event.stopPropagation()"
           href="/api/attachment?box=\${encodeURIComponent(BOX)}&id=\${encodeURIComponent(mail.id)}&name=\${encodeURIComponent(file.filename)}"
           target="_blank"
           rel="noopener">
          <span class="material-icons" style="font-size:16px">attach_file</span>
          \${escapeHTML(file.filename || '附件')}
        </a>
      \`).join('')}
    </div>
  \`;
}

async function loadInbox(manual = false) {
  if (!BOX || isLoadingInbox) return;

  const list = document.getElementById('mailList');
  const openedIds = new Set(
    Array.from(document.querySelectorAll('.mail.open'))
      .map((el) => el.dataset.mailId)
      .filter(Boolean)
  );

  isLoadingInbox = true;

  if (manual) {
    countdown = 30;
    updateCountdown();
  }

  if (!list.dataset.loaded) {
    list.innerHTML = '<div class="empty">正在刷新...</div>';
  }

  try {
    const res = await fetch('/api/list?box=' + encodeURIComponent(BOX));
    
    if (res.status === 401) {
      location.reload();
      return;
    }
    
    const data = await res.json();
    const emails = data.emails || [];

    if (!emails.length) {
      if (!list.dataset.loaded) {
        list.innerHTML = '<div class="empty">暂无邮件，稍后点击刷新收件。</div>';
      }
      return;
    }

    list.innerHTML = emails.map((mail, index) => {
      const isOpen = openedIds.has(mail.id) ? ' open' : '';
      return \`
        <div class="mail\${isOpen}" data-mail-id="\${escapeHTML(mail.id || String(index))}" onclick="this.classList.toggle('open')">
          <div class="mail-head">
            <div>
              <div class="subject">\${escapeHTML(mail.subject || '(无主题)')}</div>
              <div class="meta">来自：\${escapeHTML(mail.from || '')}</div>
            </div>
            <div class="meta">\${escapeHTML(mail.time || '')}</div>
          </div>
          <div class="body" id="body-\${index}">
            \${mail.htmlContent ? mail.htmlContent : escapeHTML(mail.content || '')}
            \${renderAttachments(mail)}
          </div>
        </div>
      \`;
    }).join('');

    list.dataset.loaded = '1';
  } catch {
    if (!list.dataset.loaded) {
      list.innerHTML = '<div class="empty">刷新失败，请稍后重试。</div>';
    }
  } finally {
    isLoadingInbox = false;
  }
}

setRandom();

// 域名下拉框切换时更新随机邮箱显示
const domainSelect = document.getElementById('domainSelect');
if (domainSelect) {
  domainSelect.addEventListener('change', () => setRandom());
}

if (BOX) {
  loadInbox();
  updateCountdown();

  setInterval(() => {
    countdown--;

    if (countdown <= 0) {
      countdown = 30;
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
