# 留灯云端 Homi 接口说明（iPhone / 手表开发用）

> 依据：`cloud/server/main.ts`（路由、实时推送、操作）、`cloud/server/engine.ts`（云端 Homi 的全部逻辑）。代码是最终依据；这份文档和代码对不上时以代码为准，并顺手改这份文档。
> 真实数据样例在 `samples/`。安卓 App 的实现（`reference/android/…/data/CloudRepository.kt`、`Gateway.kt`）是同一套接口的现成客户端，可以一对一参照。

## 0. 总体

- **云端统一运行 Homi**：看图判断、提醒、合并成事件、整理、日报、计划与记忆都在云端。iPhone、手表、网页、安卓 App 都只是**界面**：收云端推来的状态，把用户的操作发回云端。
- **采集端**：连着 eufy 摄像头的那个**网页**（Chrome）负责取画面、切片段、上传。同一时间只有一个采集端。iPhone / 手表 App **不采集**，只看。
- 地址：线上 `https://your-homi.example.com`；本机开发 `http://127.0.0.1:8787`（本机不要密码，见 `cloud/README.md`）
- 时间一律是**毫秒时间戳**（UTC 毫秒），显示时按设备时区（中国是 Asia/Shanghai）。
- 所有文字是中文。

## 1. 登录（访问密码 → 通行证）

| 请求 | 说明 |
|---|---|
| `GET /auth` | 返回 `{"required": true/false, "valid": true/false}`。`required=false`（本机开发）时不用登录，直接当已登录。带着通行证来问时，`valid` 表示云端还认不认这张通行证 |
| `POST /auth`，body `{"password":"…"}` | 成功 `200 {"token":"<64 位十六进制>","expiresAt":<毫秒>}`，同时下发会话 Cookie `pl_pass`。密码错 `401 {"error":"密码不对"}`；同一 IP 一分钟超过 10 次 `429` |

- 之后**所有请求带请求头** `x-porchlight-auth: <token>`（Cookie 也行，但 App 用请求头更简单）。
- 通行证在这次打开期间一直有效（服务器最多保留 30 天；服务器重启不失效）。
- **产品规则**：每次打开 App 输一次密码；token 只放内存，**不存钥匙串**，也不写进代码。
- 任何请求返回 `401` 且 body 里 `error.type == "porchlight_auth"`：通行证不认了 → 清掉 token，弹出密码框，输完后重试 / 重连。

## 2. 实时推送：`GET /api/stream`（Server-Sent Events）

- 请求头：`Accept: text/event-stream`、`x-porchlight-auth`。
- 每条消息是一行 `data: <JSON>`，空行结束。JSON 里的 `type` 决定含义。
- **心跳**：云端每 15 秒发一条 `{"type":"ping"}`。**45 秒没收到任何消息就断开重连**（中间代理可能把连接“挂住”，表面连着、其实不通）。
- 被拒（401）：按第 1 节重新登录后再连。其他错误：等 3 秒重连。
- 每次连上，云端先发 `welcome`，再发一份完整的 `snapshot`。之后只发变化。

| type | 字段 | 怎么处理 |
|---|---|---|
| `welcome` | `clientId` | 这条连接的编号（App 一般用不到，发操作时可以带上） |
| `snapshot` | `segments`、`analyses`、`keyFrames`、`fallWatches`、`state` | **整份替换**本地数据（样例：`samples/snapshot.json`） |
| `segments` | `set`（新增或替换的片段）、`del`（删除的片段 id）、`mergeQueue` | 按 id 合并进片段列表 |
| `record` | `key`（`analyses` / `keyFrames` / `fallWatches`）、`diff: {set: {id: 值}, del: [id]}` | 按 id 合并进对应的表 |
| `shared` | `state` | **整份替换** `state`（事件、提醒、日报、计划和记忆……都在这里，见第 3 节） |
| `frame` | `jpeg`（base64 的 JPEG，宽 480，约每秒一张；`null` = 采集端停了，没有画面）、`samples`、`mask`（调试台用，App 可以忽略） | 「此刻」的实时画面 |
| `ping` | — | 只用来续命，忽略 |
| `capture-stop`、`viewers`、`grab` | — | 只发给采集端（网页），App 收不到 |

## 3. `state`（`snapshot.state` / `shared.state`）

App 主要用这些（完整类型见 `cloud/src/...`，括号里是文件）：

| 字段 | 说明 |
|---|---|
| `events: HomiEvent[]` | **事件**：一件事 = 用户事后会单独问的一件事（`src/events/grouping.ts`）。字段：`id`、`startedAt`、`endedAt`、`summary`（一句话）、`verdict`（`record` 记录 / `notice` 留意 / `alert` 提醒 / `null` 没能分析）、`category`（分类 id）、`keyFrames: [{segmentId, index, note}]`（关键图）、`left`（留下的变化，可能为 null）、`segmentIds`、`busy`（正在合并）、`decisions`（合并依据，调试用） |
| `alerts: Alert[]` | **提醒条**（`src/components/AlertBanner.tsx`）。只有 4 种 `kind`：`expect`（期待的事发生了，如“外卖到了”，带 `planId`、`planText`）、`fall`（有人摔倒后仍在地上，紧急，带 `evidence`、`round`）、`question`（Homi 的紧急提问）、`system`（系统提醒）。公共字段：`id`、`segmentId`、`message`、`imageUrl`、`at` |
| `report: {data, running, error}` | **日报**（`src/events/report.ts` 的 `DailyReport`）：`data.headline` 一句话总结；`data.groups: [{categoryId, line, count, from, to, eventIds}]`——**`categoryId` 是大类 id**（见第 6 节）；`data.alerts`、`data.notices`、`data.openChanges`、`data.questions`。`running` 不为 null 时表示正在写 |
| `consolidation` | 统一整理：`running`、`at`、`note`、`openChanges: [{eventId, text}]`（还没结束的变化）、`leftChanges: {eventId: text}` |
| `homeCtx` | **计划和记忆**（`src/memory/types.ts`）：`plans: Plan[]`（`id`、`kind`：`relax` 放宽 / `rule` 规定 / `expect` 期待、`text`、`cues`、`start`、`end`、`enabled`、`matchedAt`）；`memories: Memory[]`（`id`、`text`、`enabled`、`rule?: "fall-alert"`）；`categories`（分类清单，见第 6 节） |
| `doneKeys: string[]` | 用户已处理过的待确认项（见第 5 节） |
| `alertLog` | 今天的提醒记录（日报用） |
| `live: {name} \| null` | 采集端开着时是画面来源名（如“eufy 摄像头”）；`null` = 现在没有画面进来 |
| `storage.note` | 一句状态说明 |
| 其他 | `liveEventIds`、`mergeQueue`、`lastTimerReportAt`、`feedbackLog`、`settings`（第一层参数和忽略区域）——App 一般用不到 |

`analyses[片段 id]`：片段的看图判断（`src/ai/pipeline.ts` 的 `Analysis`）。`final`（或还没确定时的 `shown`）是 `Judgment`（`src/ai/judge.ts`）：`change`、`verdict`、`message`（给用户的一句话）、`question`、`questionUrgent`、`category`、`fall`……

## 4. 截图：`GET /api/images/<片段 id>/<序号>.jpg`

- 要带 `x-porchlight-auth`。原图（没有涂黑，给用户看的）。内容不会变，可以按地址缓存。
- 片段（`segments` 里）有 `before`、`middle[]`、`after`，每张截图有 `url`（就是上面的路径）、`t`、`width`、`height`。
- **事件的关键图** `{segmentId, index}` → 找到这个片段，把截图排成 `[before, ...middle, after]`，取第 `index` 张的 `url`（0 = 变化前，最后一张 = 变化后）。较早的片段只留关键图（`keyFramesOnly`），中间帧会少，直接按上面的顺序取就行。
- 提醒的 `imageUrl` 也是这个路径。

## 5. 待确认（客户端自己算，不是云端字段）

和网页、安卓一致（`src/core/useHomi.ts` 的 `pending`，安卓 `CloudRepository.kt`）：
1. `consolidation.openChanges` → `key = "open-<eventId>"`，“还没结束”
2. 今天 `verdict == "notice"` 的事件 → `key = "notice-<eventId>"`，“值得看一眼”
3. 日报里有 `report.data.questions` 就用它；否则今天的片段里 `analyses[id].final.question` 不为空且 `questionUrgent == false` 的（最多 3 个，去重）→ `key = "q-<片段 id>"`，“Homi 想问”

去掉 `doneKeys` 里有的，按时间排。

## 6. 分类（比赛现场：13 小类 → 5 大类）

`homeCtx.categories` 是当前清单：`{id, icon, name, desc, group}`。事件卡显示小类（`event.category`），**日报按大类分组**（`report.data.groups[].categoryId` 是大类 id）。

| 大类 id | 名字 | 小类 id |
|---|---|---|
| `work` | 💻 工作中 | `coding` 埋头开发、`discuss` 团队讨论、`debug` 调试设备 |
| `social` | 🙋 交流展示 | `visit` 有人来交流、`demo` 演示讲解、`photo` 拍照录像 |
| `rest` | ☕ 休息生活 | `break` 吃喝休息 |
| `items` | 📦 物品 | `supply` 物资送达、`object` 物品被拿走 / 留下、`setup` 布置收拾 |
| `attention` | ⚠️ 需要留意 | `fall` 有人摔倒、`camera` 画面异常 |
| `other` | ❔ 其他 | `other` 其他 |

不认识的 id 一律显示成“其他”。大类表在 `src/memory/categories.ts` 的 `CATEGORY_GROUPS`（`state` 里没有，App 自己带一份）。

## 7. 操作：`POST /api/cmd`

body：`{"name": "<操作>", "args": [...], "clientId": "<可选>"}`，带 `x-porchlight-auth`。返回 `{"value": …}`；出错 `400/500 {"error": …}`。操作的结果通过实时推送回来（不用等返回值刷新界面）。

| name | args | 用途（App 里的按钮） |
|---|---|---|
| `dismissAlert` | `[alertId]` | 提醒条“知道了” |
| `markFalseAlarm` | `[fallAlert 对象]` | 摔倒提醒“是误报” |
| `endPlan` | `[expectAlert 对象]` | 期待提醒“结束这个计划” |
| `markDone` | `[key]` | 待确认项处理完（key 见第 5 节） |
| `saveDraft` | `[片段 id, draft, note]` | 回答 Homi 的问题 / 反馈后，把确认过的计划或记忆草稿存进去。`draft`：`{intent, text, targetId, start, end, planKind?, cues?}`（`src/memory/apply.ts`；`intent`：`memory_add` / `memory_update` / `plan_add` / `plan_update` / `none`；`start`、`end` 是本地时间 `YYYY-MM-DDTHH:mm`）。返回 `{ok, label} \| {ok:false, error}` |
| `setHomeCtx` | `[整份 homeCtx]` | 改计划和记忆（开关、改文字、删除）：在最新的 `homeCtx` 上改好，**整份**发回 |
| `recordVote` | `[片段 id, "agree" \| "disagree" \| null]` | 对一次判断点“符合 / 不符合” |
| `generateReport` | `[]` | “写今天的日报” |
| `consolidate` | `[]` | “整理一下” |
| `grabSnapshot` | `[]` | “现在看一眼”：云端向采集端要一张当前画面，返回 `{t, url, width, height}` 或 `null`（没开画面 / 15 秒没要到） |
| `stop` | `[]` | 叫采集端停下 |
| `applySetup` | `[{fallAlert: true/false}]` | 首次设置（摔倒提醒开关） |
| `deleteAll` | `[]` | 删除所有记录（计划、记忆保留）。App 里一般不放 |
| `hello`、`captureStart`、`captureStop`、`setConfig`、`setZones`、`runAnalysis` | — | 网页采集端 / 调试台用，App 不用 |

## 8. 和 Homi 对话：`POST /ai-api/chat/completions`

- 云端把请求加上 AI Key 转发到主办方 AI 网关（OpenAI 兼容格式）。**App 里不要有 Key。**
- 安卓 App 的做法（`reference/android/…/data/Gateway.kt` 的 `chat`、`Assistant.kt` 的提示词；网页同款在 `cloud/src/ai/assistant.ts`）：
  - 模型 `hackathon/v_model/deepseek-v4-pro`，`reasoning_effort: "low"`；15 秒没回再同时发 `hackathon/v_model/glm-5.2`（`thinking: {type: "disabled"}`），用先回来的
  - 提示词里带上今天的事件、计划和记忆，模型判断意图：回答（附证据事件）/ 布置计划或记忆（出草稿，用户确认后用 `saveDraft` 或 `setHomeCtx` 生效）/ 看一眼（`grabSnapshot` 后再问看图模型）
- 请求失败 401 `porchlight_auth`：同第 1 节。

## 9. 其他接口（App 用不到，了解即可）

`/api/capture/segment`、`/api/capture/frame`、`/api/capture/grab`（采集端上传，只收当前采集端的）、`/openapi-api/*`（转发 eufy 接口给网页采集端）、`/api/eufy-config`（网页采集端取 eufy 参数）、`/healthz`（健康检查：`{"ok":true,"clients":n,"capturing":bool}`，不要密码）。
