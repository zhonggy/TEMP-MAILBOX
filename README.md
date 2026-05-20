# Temp Mail Inbox

一个基于 Cloudflare Workers 的临时邮箱系统。

支持：

- 随机邮箱
- 自定义邮箱
- HTML 邮件
- 附件下载
- R2 存储
- D1 索引
- 自动刷新
- 首页访问密码
- 收件箱免密码
- 无闪屏刷新
- 邮件自动清理

---

# Preview

## 首页

- 随机生成邮箱
- 自定义邮箱
- 访问密码保护

## 收件箱

- 自动刷新
- HTML 邮件显示
- 附件下载
- 一键复制邮箱
- 一键复制网址

---

# Features

## Mail

- Plain Text Mail
- HTML Mail
- Attachment Support
- Chinese Subject Decode
- Chinese Attachment Filename Decode

## Storage

- D1 for Index
- R2 for Mail Body
- R2 for Attachments
- Auto Expiration Cleanup

## UI

- Auto Refresh
- Countdown Refresh
- No Flash Refresh
- Keep Expanded Mail State
- Toast Copy Notification

---

# Tech Stack

- Cloudflare Workers
- Cloudflare Email Routing
- Cloudflare D1
- Cloudflare R2

---

# Deploy

## 1. Create D1

Create a D1 database:

```bash
wrangler d1 create mail_bucket
