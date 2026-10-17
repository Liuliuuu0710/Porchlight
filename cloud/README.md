# 留灯网页与云端

此目录来自 2026-10-16 交接包，不是当前线上镜像。

- `src/home`：用户主页及计划、记忆、对话、今天。
- `src/pages/ConsolePage.tsx`：采集与调试台。
- `src/frame-source/eufy.ts`：eufy 取帧及断流重连。
- `server/main.ts`：HTTP、认证、SSE、模型及设备接口代理。
- `server/engine.ts`：判断、事件、提醒、日报等云端业务。
- `src/ai`、`src/events`、`src/memory`：共用逻辑及测试。

运行：Node.js 22.6+，`npm ci`，填写 `.env` 后 `npm run dev`。测试：`npm test`；构建：`npm run build`。

完整步骤见 [运行与交接](../docs/development.md)，API 见 [交接版 API](../docs/api-handover.md)。SDK 需另行放入 `public/sdk/`。
