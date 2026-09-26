# daemon 两个 flaky 测试文件的修复

> 对应：分支 `fix/daemon-flaky-tests`；PR #271 期间发现的全量测试 flaky 问题

## 要解决的问题

daemon 全量测试（`pnpm test`，`node --test --test-timeout=30000`）中，有两个测试文件**每次都恰好挂满 30 秒**被测试运行器强杀，被判为 flaky（时好时坏的测试）：

- `test/core/skills/prefill.test.js`
- `test/core/weixin/state-machine.test.js`

单独跑、并行跑都必现 30 秒挂起，不是偶发的负载问题，而是两个确定的 bug（都在测试代码里，产品代码无改动）。

## 根因与修复

### 1. prefill：mock 回调同步触发，留下 30 秒悬挂定时器

`prefillFromContent`（`src/core/skills/prefill.ts`）的执行顺序是：先调用 `runManager.createRun(...)`，**之后**才给超时定时器赋值（`timer = setTimeout(..., 30_000)`）。

测试里的 mock `createRun` **同步**调用了 `onTurnComplete` 回调，导致内部的 `settle()` 赶在定时器赋值之前执行——`clearTimeout` 看到 `timer` 还是 `null`，清不掉。随后定时器赋值完成，一个 30 秒的定时器从此无人清理，把测试进程恰好挂到 `--test-timeout=30000` 边界。

真实 `RunManager` 的 `onTurnComplete` 由流事件驱动，**永远**在 `createRun` 返回之后异步触发，同步回调是 mock 不真实。

**修复**：mock 改用 `queueMicrotask` 异步触发回调，与真实行为一致。定时器在 `settle` 前已赋值，能被正常清理。

### 2. weixin state-machine：QR 登录循环真实请求微信服务器

`beginLogin()`（`src/core/weixin/service.ts:210`）在后台启动 QR 登录循环，循环里的 `fetchQrCode()` / `pollQrStatus()`（`src/core/weixin/client.ts:380,386`）**不带超时参数**，走 undici 默认约 30 秒的 headersTimeout。测试只 mock 了 `getUpdates` / `healthCheck`，漏了这两个——于是测试进程里有一个对 `https://ilinkai.weixin.qq.com` 的真实请求挂到约 30 秒。

**修复**：在集成测试的 `beforeEach` 里把 `fetchQrCode` / `pollQrStatus` 桩成即时返回的「永不过期、永不确认」（`{ qrcode: 'mock-qrcode' }` / `{ status: 'wait' }`），登录循环空转不写凭证，`afterEach` 的 `stop()` 正常收尾；`afterEach` 同时恢复原始方法。

## 验证

- 修复前：两个文件单独跑各约 31~32 秒（测试本体仅 0.3~1.3 秒，其余全是挂起）。
- 修复后：两个文件合计 **1.65 秒，28/28 通过，0 取消**；全量套件从 31.3 秒降到 16.6 秒。

## 顺带查明：本机另有两个失败，与本次修复无关

修复后全量跑还剩 2 个失败，逐一查证均为**本机环境特有的既有问题**（main 上同样失败，CI 全绿）：

| 失败 | 原因 | 为什么 CI 绿 |
|---|---|---|
| `minimal-path-detection`（2 个子测试） | 断言「minimal PATH 下也能探测到 claude」，但本机 claude 装在自定义 npm 前缀 `D:\nodejs\node_global`，不在代码的 well-known 目录清单里 | CI 机器没装 claude，测试按设计跳过 |
| `market-routes`（1 个挂起 + 2 个连带取消） | 测试 mock 靠 `AbortSignal.timeout` 的 abort 事件收尾；本机 Node 22.15.1 下该定时器不保持事件循环，循环提前排空，测试被判「promise 未 resolve 但事件循环已结束」 | 仓库 `engines` 要求 Node >= 24，CI 用 Node 24，行为不同 |

两者都不属于本次 flaky 修复的范围（一个是测试对安装位置的假设，一个是本机 Node 版本低于仓库要求），如需处理应另开议题。
