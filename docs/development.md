# 开发、配置与验收

## 1. 网页与后端

环境建议 Node.js 22.6+。`npm test` 使用实验性 TypeScript strip-types，因此 Node 20 不足以执行现有测试命令。

```sh
cd cloud
npm ci
cp .env.example .env
npm run dev
```

将模型 Key 仅写入本机 `.env`。eufy 参数保存为 `eufy.local.json`（字段见 `src/eufy/config.ts`），不提交。SDK 来自主办方授权资料。缺少真实凭证时只能验证界面和非设备逻辑。

```sh
npm test
npm run build
```

构建产物为 `dist/` 和 `build/server.mjs`。生产服务运行 `node build/server.mjs`，配合 HTTPS 反向代理。使用运行环境注入 AI_API_KEY、SHARE_PASSWORD、DATA_DIR、EUFY_CONFIG_FILE、HOST 和 PORT；实际可用变量见 server/main.ts。生产访问密码不要留空。仅在可信反向代理后按实际拓扑配置 TRUST_PROXY。数据目录应持久化并做备份，不放入 Git。

本仓库不自动创建 AWS 资源、不自动修改现有线上服务。

## 2. iPhone 和 Apple Watch

1. 使用兼容设备系统的 Xcode 打开 `apple/Liudeng.xcodeproj`。原开发工具为 Xcode 26.6 RC；最低部署目标应以工程配置为准。
2. Signing & Capabilities 选择自己的 Team；需要时修改 Bundle ID。
3. 在 `Liudengphone/PhoneCloud.swift` 和 `Liudeng Watch App/CloudModel.swift` 将 `https://your-homi.example.com` 改为自己的 HTTPS 云端地址。
4. 手机选择 Liudengphone Scheme，手表选择 Liudeng Watch App Scheme，运行到对应真机。
5. 手机与手表开启开发者模式并保持解锁。普通 App 使用不要求一直插线，但首次安装与调试需要可用的设备连接。

## 3. 三端验收

- 开启一个 Chrome 采集页，确认网页画面时间更新和 `/healthz` 的 capturing=true。
- 手机、手表打开 App，确认画面及时间持续变化，不只核对安装成功。
- 断网后应显示断开或旧画面；恢复网络后前台自动同步。
- 将 App 切后台再返回，确认没有重复连接任务；不要把 watchOS 锁屏后台限制误判为持续采集能力。
- 服务器需要密码时必须要求登录；错误密码不得进入。
- 手表安装中文名称版本后，再验证 Siri 中文“打开留灯”。

## 4. 交互稿

HTML 可离线打开；双机原型面向 iPhone 13 mini / OPPO Find X8，原生 App 则调整为 16 Pro Max。交互稿的本机演示数据与云端状态互相独立，清除浏览器演示数据不等于删除云端数据。
