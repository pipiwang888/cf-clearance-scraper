# 更新改动记录

## 2026-05-20 - Captcha solver stabilization

### hCaptcha
- 更新 hCaptcha 求解流程，兼容 `hcaptcha-challenger` 新版本行为。
- 支持可视化浏览器调试，便于观察挑战页面和交互过程。
- 增强 Gemini 模型配置，支持 `gemini-flash-latest` / Gemini Flash 系列模型。

### reCAPTCHA v2
- 将缺失的 Python reCAPTCHA v2 路径替换为内置 JavaScript solver。
- 增强真实浏览器流程：自动点击 checkbox、切换音频挑战、下载音频并提交答案。
- 修复 detached frame 问题：每轮挑战重新获取有效 bframe，避免复用失效 frame。
- 修复音频下载：使用浏览器会话 Cookie、Referer、User-Agent 等请求头下载 `audio.mp3`。
- 支持系统 FFmpeg，并可通过 `FFMPEG_PATH` 指定路径。
- 修复 Node.js 环境下 Whisper 无 `AudioContext` 的问题：将 WAV PCM 解析为 `Float32Array` 后传入 Transformers.js。
- 禁用 mock transcription 后，Whisper 不可用会直接报错，避免提交假答案。
- 改进成功判定：提交答案后轮询 token、anchor 状态和 audio frame 状态，避免网页已成功但程序继续重试。
- 成功响应返回兼容字段：`token`、`response`、`gRecaptchaResponse`、`g-recaptcha-response`。
- 服务端增加安全日志：打印 token 长度和截断预览，不在日志输出完整 token。

### reCAPTCHA v3
- 修复监听时机：在导航前注册响应监听，避免漏掉 token 请求。
- 增加页面就绪等待和广告 iframe 过滤。
- 当目标页没有主动加载脚本时，支持注入 reCAPTCHA API script。
- 返回字段与 v2 对齐，便于客户端统一读取。

### Cloudflare / 广告页面处理
- 在查找 reCAPTCHA 前等待 Cloudflare 验证页面结束。
- 增加广告 iframe 清理逻辑，减少广告弹窗和无关 iframe 干扰。

### API / 监控
- 统一 `/captcha` 和兼容接口的 reCAPTCHA 返回结构。
- 监控数据继续记录 requestId、mode、token、responseTime。
- 响应发送前打印安全摘要，方便排查客户端未读取 body 的问题。

