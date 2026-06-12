# Temp Mail Inbox

一个基于 **Cloudflare Workers** 的无服务器临时邮箱系统。无需自建服务器，部署即可使用。

## 功能特性

- 随机生成邮箱名 / 自定义邮箱名
- HTML 邮件渲染（自动缩放适配移动端）
- 附件上传与下载
- 30 秒自动刷新收件箱
- 首页访问密码保护，收件箱免密访问
- 邮件 7 天自动过期清理
- 每日收件统计

## 技术架构

| 组件 | 用途 |
|------|------|
| Cloudflare Workers | 运行环境，处理邮件接收与 Web 请求 |
| Cloudflare D1 | SQLite 数据库，存储邮件索引和统计数据 |
| Cloudflare R2 | 对象存储，存储完整邮件 JSON 和附件 |

## 版本说明

| 文件 | 版本 | 说明 |
|------|------|------|
| `worker.js` | V1 | 基础版，10 秒刷新，邮件保留 1 天 |
| `workers2.js` | V2 | 新增免密码白名单逻辑，30 秒刷新，邮件保留 10 年 |
| `workers3.js` | V3 | V2 + 移动端适配 + HTML 邮件缩放 + bug 修复，邮件保留 7 天 |

> 推荐使用 **V3（workers3.js）**

## 部署步骤

### 1. 创建 Cloudflare 资源

在 Cloudflare 控制台中创建：

- **D1 数据库**：用于存储邮件索引和统计数据
- **R2 存储桶**：用于存储完整邮件内容和附件

### 2. 配置 wrangler.toml

编辑 `wrangler.toml`，填入你的实际配置：

```toml
name = "email"
main = "workers3.js"
compatibility_date = "2025-05-20"

[[d1_databases]]
binding = "DB"
database_name = "mail_bucket"
database_id = "你的D1_ID"

[[r2_buckets]]
binding = "MAIL_BUCKET"
bucket_name = "mail-storage"

[vars]
MAIL_DOMAIN = "your-domain.com"
ACCESS_PASSWORD = "你的访问密码"
```

### 3. 初始化数据库（可选）

Worker 启动时会自动建表，也可以手动在 D1 控制台执行 `D1.sql` 中的建表语句。

### 4. 部署

```bash
npx wrangler deploy
```

### 5. 配置邮件路由

在 Cloudflare 控制台的 **Email Routing** 中，将域名的邮件路由指向该 Worker。

## 邮件域名

默认邮件域名为 `1239999.xyz`，可通过 `wrangler.toml` 中的 `MAIL_DOMAIN` 变量修改。

## API 接口

| 路径 | 方法 | 说明 |
|------|------|------|
| `/` | GET | 首页，可输入邮箱名或随机生成 |
| `/BOX_NAME` | GET | 收件箱页面 |
| `/api/list?box=XXX` | GET | 获取邮件列表 |
| `/api/attachment?box=&id=&name=` | GET | 下载附件 |
| `/api/login` | POST | 密码登录 |

## License

MIT
