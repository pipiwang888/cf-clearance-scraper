# 安全与依赖说明

## 不应提交到 GitHub 的文件

以下文件只允许保留在本地，禁止提交到公开仓库：

- `.env`
- `.env.bak*`
- `*.bak` / `*.bak.*`
- `tmp_recaptcha_audio.*`
- `tools/` 下的本地 FFmpeg 二进制和压缩包
- `.cache/`、模型缓存、浏览器缓存
- `node_modules/`
- `captcha-solvers/hcaptcha/venv/`
- `service.log`、`service.err.log`

## 环境变量

请从 `.env.example` 复制到 `.env` 后再填写真实值。

推荐配置：

```env
# API 认证，建议生产环境启用
AUTH_TOKEN=replace_with_a_strong_random_token

# hCaptcha / Gemini
GEMINI_API_KEY=replace_with_your_key
IMAGE_CLASSIFIER_MODEL=gemini-flash-latest
SPATIAL_POINT_REASONER_MODEL=gemini-flash-latest
SPATIAL_PATH_REASONER_MODEL=gemini-flash-latest
CHALLENGE_CLASSIFIER_MODEL=gemini-flash-latest

# reCAPTCHA audio / Whisper
FFMPEG_PATH=E:\cf-clearance-scraper\tools\ffmpeg\bin\ffmpeg.exe
TRANSFORMERS_CACHE=E:\cf-clearance-scraper\.cache\transformers
HF_HOME=E:\cf-clearance-scraper\.cache\huggingface
HF_ENDPOINT=https://hf-mirror.com
WHISPER_MODEL=Xenova/whisper-tiny.en
RECAPTCHA_DISABLE_MOCK_TRANSCRIPTION=true
```

## 关键依赖

Node.js 依赖来自 `package.json` / `package-lock.json`：

- `express`：HTTP API 服务
- `puppeteer-real-browser`：真实浏览器上下文
- `axios`：音频文件下载
- `@xenova/transformers`：本地 Whisper ASR
- `@ffmpeg/ffmpeg` / `@ffmpeg/util`：可选 WebAssembly FFmpeg
- 系统 FFmpeg：推荐通过 `FFMPEG_PATH` 指向本地二进制
- hCaptcha Python venv：`captcha-solvers/hcaptcha/venv/`，不提交到仓库

## 安全建议

1. 生产环境必须设置 `AUTH_TOKEN`，避免接口裸露。
2. 不要在日志或 issue 中粘贴完整 token、API key、Cookie、代理账号密码。
3. `GEMINI_API_KEY`、代理配置、浏览器 profile 都只放在 `.env` 或本地密钥管理中。
4. `RECAPTCHA_DISABLE_MOCK_TRANSCRIPTION=true` 可避免 Whisper 不可用时提交假答案。
5. 如果开启公网访问，建议放在反向代理后面并限制来源 IP / 速率。
6. 定期运行：

```powershell
npm audit
npm outdated
```

7. 更新依赖后先用本地测试页面验证 hCaptcha、reCAPTCHA v2、reCAPTCHA v3 三类流程。

## 日志策略

服务端响应日志只打印 token 长度和截断预览，例如：

```text
📤 返回响应: status=200, mode=recaptchav2, tokenLength=2404
📦 返回内容: { "token": "03AFc...xxxx", "tokenLength": 2404 }
```

HTTP 响应体仍会返回完整 token 给调用方。

