# eufy Web SDK 外部依赖

本次整理不包含主办方提供的预编译 SDK JavaScript。请从有权使用的赛事资料中取得 Web SDK UMD 1.1.0 对应文件，放入：

```text
public/sdk/index.js
public/sdk/i18n/en.js
public/sdk/i18n/zh-CN.js
```

这些文件被 Git 忽略。加载入口为 `src/eufy/sdk.ts`，依赖 `window.WebSDK`。缺少 SDK 时无法连接真实设备。

开流若无画面，先确认设备在线和凭证有效，再按官方 SDK 的浏览器兼容说明检查 Chrome 的 WebRTC 设置。SDK 包含某个模块不代表本项目已经完成该功能接入。
