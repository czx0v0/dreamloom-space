# 部署包说明（deploy/app）

这是发布到 workbuddy.host 的最小运行包：`server/` + `shared/` + `config/` + `web/` + 精简 `package.json`。
不含 `.env`、不含 `node_modules`、不含源码构建工具。

> **为什么前端产物叫 `web/` 而不是 `dist/`**：发布工具会把 `dist/` 当构建产物剔除，
> 服务端就会报「前端还没构建」。服务端已支持 `dist/` 与 `web/` 二选一，部署包里用 `web/`。

## 两种 Key 模式

### A. BYOK（默认，当前线上就是这种）

用户打开链接 → 设置 → 填自己的 Key（DeepSeek / 百炼），只存浏览器 `localStorage`。
服务端不持有任何 Key，谁用谁付，链接被转发也不会烧你的额度。

### B. 站点共享 Key（体验模式）

想让"点开就能写"，就把 Key 放进部署目录的 `.env`：

```bash
cd deploy/app
cat > .env <<'EOF'
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_API_KEY=sk-你的key
LLM_MODEL=deepseek-chat
# 共享额度的日上限（字符，输入+输出合计）；默认 100 万 ≈ 180 幕
DAILY_CHAR_BUDGET=200000
EOF
```

然后重新发布同一目录。服务端启动时会读它（`.env.local` 优先于 `.env`）。

**必须知道的代价：**

1. **链接即额度**：`?sharecode=` 泄露出去，别人就能用你的 Key。现有护栏只有令牌桶（叙事 8 rpm/IP）、
   并发 2、每日字符熔断；它防脚本刷，不防"人肉慢慢用"。
2. **不可热更新**：Key 在沙箱里，换 Key 要重新发布。泄露后先用供应商后台**吊销旧 Key**，再重发。
3. **额度会被一局吃光**：一局 25 幕约 14 万字符。体验模式建议把 `DAILY_CHAR_BUDGET` 压到 20 万以内，
   并在文案里写明"体验额度用完请自备 Key"。
4. **不要提交到公开仓库**：`.env` 已在 `.gitignore` 里，部署目录也不要提交。

想要"有默认体验、又不暴露 Key"，正解是接平台侧免密钥的模型调用（WorkBuddy 云服务），
由平台做鉴权与计量；那需要单独接一层，不是往 `.env` 里塞 Key。

## 更新线上版本

```bash
npm run build
rm -rf deploy/app/web deploy/app/server deploy/app/shared deploy/app/config
cp -r dist deploy/app/web
cp -r server shared config deploy/app/
# 重新发布同一目录即可，链接不变
```

## 本地自测部署包

```bash
cd deploy/app
PORT=3100 node server/index.js   # 打开 http://localhost:3100
```

## 站点 Key（体验期）

`deploy/app/secrets.json` 里放的是站点自己的 Key，服务端启动时读进 `process.env`（已有环境变量优先）：

```json
{
  "LLM_BASE_URL": "https://api.deepseek.com/v1",
  "LLM_MODEL": "deepseek-chat",
  "LLM_API_KEY": "sk-…",
  "DAILY_CHAR_BUDGET": "200000"
}
```

为什么是 `secrets.json` 而不是 `.env`：部分部署平台上传时会跳过 `.env*` 这类点文件，
线上就变成"没有 Key"。JSON 不受这条规则影响。**这个文件不进 git**（已在 `.gitignore`）。

护栏：`DAILY_CHAR_BUDGET` 收紧到 20 万字符（约一局半）、8 rpm/IP、并发 2。
链接被转发后人肉慢慢用是防不住的，所以额度要按"随时准备被用光"来设。

**切回纯 BYOK**：删掉 `LLM_API_KEY` 这一行再发布，前端会自动退回「去设置填一个 Key」的引导。

**生图/语音**：站点 Key 是 DeepSeek，只做文本。要让所有人免配置出图，再加：

```json
  "IMAGE_BASE_URL": "https://dashscope.aliyuncs.com/api/v1",
  "TTS_BASE_URL": "https://dashscope.aliyuncs.com/api/v1",
  "IMAGE_API_KEY": "sk-…",
  "TTS_API_KEY": "sk-…"
```

+ `IMAGE_API_KEY` / `TTS_API_KEY`（可选，两把可以不同）。不填则沿用 `LLM_API_KEY`。
这也是「文本用 DeepSeek、图用百炼」在站点侧的做法：三个 Key 各写各的，互不影响。
