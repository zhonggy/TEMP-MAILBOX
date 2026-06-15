# Temp Mail Inbox

一个基于 **Cloudflare Workers** 的无服务器临时邮箱系统。无需自建服务器，部署即可使用。

## 功能特性

- 随机生成邮箱名 / 自定义邮箱名
- 支持多域名后缀（下拉框选择）
- HTML 邮件渲染（自动缩放适配移动端）
- 附件上传与下载
- 30 秒自动刷新收件箱
- 首页访问密码保护，收件箱免密访问
- 邮件 1 年自动过期清理
- 每日收件统计

## 技术架构

| 组件 | 用途 |
|------|------|
| Cloudflare Workers | 运行环境，处理邮件接收与 Web 请求 |
| Cloudflare D1 | SQLite 数据库，存储邮件索引和统计数据 |
| Cloudflare R2 | 对象存储，存储完整邮件 JSON 和附件 |

---

## 部署教程

### 前置条件

- 一个 Cloudflare 账号（[注册](https://dash.cloudflare.com/sign-up)）
- 一个域名（已托管在 Cloudflare 上，或准备接入 Cloudflare）
- 本地安装 Node.js（v16+）

### 第一步：安装 Wrangler CLI

Wrangler 是 Cloudflare 官方的命令行部署工具。

```bash
npm install -g wrangler
```

安装完成后登录：

```bash
wrangler login
```

浏览器会弹出授权页面，点击 **Allow** 即可。

---

### 第二步：创建 D1 数据库

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 左侧菜单点击 **Workers & Pages** → **D1**
3. 点击 **Create database**
4. 数据库名称填写 `mail_bucket`（可自定义）
5. 位置选择 **Automatic**（或离你最近的区域）
6. 点击 **Create**

创建完成后，进入数据库详情页，复制 **Database ID**（类似 `a1b2c3d4-e5f6-7890-abcd-ef1234567890`）。

#### 初始化数据库表（可选）

Worker 首次运行时会自动建表。如果你想手动初始化：

1. 在 D1 数据库详情页，点击 **Console** 标签
2. 粘贴 `D1.sql` 中的内容
3. 点击 **Execute**

---

### 第三步：创建 R2 存储桶

1. 左侧菜单点击 **R2 Object Storage**
2. 如果是首次使用，需要点击 **Subscribe to R2**（R2 有免费额度）
3. 点击 **Create bucket**
4. 桶名称填写 `mail-storage`（可自定义）
5. 位置选择 **Automatic**
6. 点击 **Create bucket**

> R2 免费额度：每月 10 GB 存储 + 1000 万次 Class A 操作 + 1000 万次 Class B 操作，个人使用完全够用。

---

### 第四步：创建 Worker

#### 方式一：通过命令行创建（推荐）

1. 克隆本项目到本地：

```bash
git clone https://github.com/zhonggy/TEMP-MAILBOX.git
cd TEMP-MAILBOX
```

2. 编辑 `wrangler.toml`，填入你的配置：

```toml
name = "temp-mail"
main = "worker.js"
compatibility_date = "2025-05-20"

# D1 数据库绑定
[[d1_databases]]
binding = "DB"
database_name = "mail_bucket"
database_id = "你的D1数据库ID"      # ← 替换为第二步复制的 ID

# R2 存储桶绑定
[[r2_buckets]]
binding = "MAIL_BUCKET"
bucket_name = "mail-storage"

# 环境变量
[vars]
# 多个域名用英文逗号分隔，第一个为主域名
MAIL_DOMAINS = "domain1.com,domain2.com,domain3.com"
ACCESS_PASSWORD = "你的访问密码"       # ← 设置一个访问密码
```

3. 部署：

```bash
wrangler deploy
```

部署成功后会显示类似：

```
Published temp-mail (x.x.x)
  https://temp-mail.xxx.workers.dev
```

记下这个 Workers 地址。

#### 方式二：通过网页控制台创建

如果不习惯命令行，也可以：

1. 左侧菜单点击 **Workers & Pages**
2. 点击 **Create application** → **Create Worker**
3. 起个名字（如 `temp-mail`），点击 **Deploy**
4. 部署完成后点击 **Edit code**
5. 将 `worker.js` 的全部内容粘贴覆盖默认代码
6. 点击 **Save and deploy**

然后回到 Worker 设置页面，手动添加绑定：

- **Settings** → **Variables** → **D1 Database Bindings**：Variable name 填 `DB`，选择你的 D1 数据库
- **Settings** → **Variables** → **R2 Bucket Bindings**：Variable name 填 `MAIL_BUCKET`，选择你的 R2 桶
- **Settings** → **Variables** → **Environment Variables**：
  - `MAIL_DOMAINS` = `domain1.com,domain2.com,domain3.com`（多个域名用逗号分隔）
  - `ACCESS_PASSWORD` = `你的访问密码`

---

### 第五步：绑定自定义域名（可选）

默认 Worker 会有一个 `xxx.workers.dev` 的域名。如果你想用自己的域名：

1. 确保你的域名已经接入 Cloudflare（在 **Websites** 中能看到）
2. 进入你的 Worker 页面
3. 点击 **Settings** → **Domains & Routes**
4. 点击 **Add** → **Custom domain**
5. 输入你想用的域名（如 `mail.your-domain.com`）
6. 点击 **Add domain**

Cloudflare 会自动配置 DNS 记录和 SSL 证书，几分钟后即可通过自定义域名访问。

---

### 第六步：配置邮件路由

这是最关键的一步，让邮件能发送到你的 Worker。

1. 左侧菜单点击你的域名
2. 点击 **Email** → **Email Routing**
3. 如果没有开启，点击 **Get started** 开启 Email Routing
4. 切换到 **Routing Rules** 标签
5. 在 **Catch-all address** 部分，点击 **Edit**
6. Action 选择 **Send to a Worker**
7. 目的地选择你刚创建的 Worker（如 `temp-mail`）
8. 点击 **Save**

这样所有发往 `*@your-domain.com` 的邮件都会被转发到你的 Worker 处理。

> ⚠️ **注意**：Email Routing 要求域名的 MX 记录指向 Cloudflare。开启时 Cloudflare 会自动添加，如果之前有自定义 MX 记录可能会冲突。

---

### 第七步：验证部署

1. 打开你的 Worker 域名（如 `https://temp-mail.your-domain.com` 或 `https://temp-mail.xxx.workers.dev`）
2. 如果设置了密码，输入访问密码
3. 点击 **随机生成邮箱** 或输入自定义名称
4. 进入收件箱
5. 用另一个邮箱发送一封测试邮件到生成的地址
6. 等待 30 秒自动刷新，或点击 **刷新收件** 按钮

如果能收到邮件，说明部署成功！

---

## 文件说明

本项目使用 `worker.js` 作为主程序文件，支持多域名后缀选择、北京时间显示等功能。

---

## 常见问题

### Q: 收不到邮件怎么办？

1. 确认 Email Routing 已开启，且 **Catch-all** 指向了你的 Worker
2. 确认域名的 MX 记录已正确指向 Cloudflare（在 **DNS** 中查看）
3. 在 Worker 日志中查看是否有错误（**Workers & Pages** → 你的 Worker → **Logs** → **Live**）

### Q: 页面打不开 / 显示 500 错误？

1. 检查 D1 数据库绑定是否正确（Variable name 必须是 `DB`）
2. 检查 R2 存储桶绑定是否正确（Variable name 必须是 `MAIL_BUCKET`）
3. 查看 Worker 实时日志排查具体错误

### Q: 怎么查看 Worker 日志？

```bash
wrangler tail
```

或者在 Cloudflare Dashboard 中：**Workers & Pages** → 你的 Worker → **Logs** → **Start live log**。

### Q: 怎么更新部署？

修改代码后重新执行：

```bash
wrangler deploy
```

### Q: 邮件能保存多久？

默认 1 年后自动过期清理。可在 `worker.js` 中修改 `MAIL_TTL_SECONDS` 常量调整。

### Q: 如何配置多个域名后缀？

在 `wrangler.toml` 的 `[vars]` 中，将 `MAIL_DOMAINS` 设置为逗号分隔的多个域名：

```toml
MAIL_DOMAINS = "domain1.com,domain2.com,domain3.com"
```

第一个域名为主域名。同时需要在 Cloudflare 中为每个域名配置 Email Routing 的 catch-all 规则，将邮件转发到 Worker。

### Q: R2 会不会产生费用？

R2 免费额度对个人使用绰绰有余（每月 10GB 存储 + 1000万次操作）。只有超出免费额度才会收费。

### Q: 可以不配置 R2 吗？

可以。如果不绑定 R2，邮件内容会直接存在 D1 数据库中（R2 绑定 Variable name 留空即可）。D1 有 5GB 免费存储，但对于大量邮件场景建议使用 R2。

---

## API 接口

| 路径 | 方法 | 说明 |
|------|------|------|
| `/` | GET | 首页，可输入邮箱名或随机生成 |
| `/BOX_NAME` | GET | 收件箱页面 |
| `/api/list?box=XXX` | GET | 获取邮件列表 |
| `/api/attachment?box=&id=&name=` | GET | 下载附件 |
| `/api/login` | POST | 密码登录 |

---

## License

[MIT](LICENSE)
