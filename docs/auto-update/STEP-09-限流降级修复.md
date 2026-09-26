# STEP-09 修复：GitHub 接口限流导致检查更新失败

> 时间：创建于 2026-09-26 15:39（取自文件系统）；本步的完整时间线见 [TIMELINE-全程时间戳记录.md](TIMELINE-全程时间戳记录.md)。

- 触发原因：真机实测时界面报
  「GitHub 接口请求过于频繁，请稍后再试，或直接用"打开发布页"手动下载。」
- 本步只改 `electron/update-check.mjs`（+ 界面文案）与其单测，并重打测试包。

## 1. 根因

`check()` 直接从 `https://api.github.com/repos/lpossj/roomcast/releases` 读发布列表。
GitHub **未认证**接口的额度是 **每小时每 IP 60 次**，超限返回 403（或 429）。
本机复现与核实：

- 本机当前额度：`GET https://api.github.com/rate_limit` → `limit: 60, remaining: 53`，说明额度机制确实存在；
- 反复启动程序测试（每次启动 = 1 次请求）或与其他程序/共用出口 IP 叠加，很容易把 60 次用光；
- 一旦 403，旧实现直接抛错：**不弹更新窗、也没有任何降级**，用户只能手动下载。

也就是说，这不是"网络不好"，而是自动更新链路依赖了一个**会被人为耗尽**的接口。

## 2. 修复方案：不依赖 API 的降级路径

项目本来就为固定网页入口发布了静态版本清单，且发布流程的资产命名是固定的：

| 用途 | 地址 | 是否吃 API 额度 |
| --- | --- | --- |
| 版本清单（新增降级源） | `https://lpossj.github.io/roomcast/version.json` | ❌ 不吃 |
| 更新说明（新增降级源） | `https://raw.githubusercontent.com/lpossj/roomcast/v<版本>/docs/RELEASE_NOTES-<版本>.md` | ❌ 不吃 |
| 安装包直链 | `https://github.com/lpossj/roomcast/releases/download/v<版本>/Roomcast-<版本>-Windows.exe` / `.zip` | ❌ 不吃 |
| SHA256 清单 | `.../download/v<版本>/SHA256.txt` | ❌ 不吃 |

实现（`createUpdateChecker` 内新增 `checkViaManifest()`）：

- `check()` 先用原来的 API；API 抛错时改走清单降级；**两者都失败才把原始 API 错误抛给界面**（错误原因不被掩盖）。
- 保持既有规则不变：
  - 稳定版安装不会被推送到测试版；
  - 清单版本不高于当前版本 → 视为「已是最新」；
  - **自动安装仍然必须有 SHA256.txt 且校验一致**（降级路径同样要求，安全标准不降级）。
- 结果带 `viaManifest: true`，界面如实标注「GitHub 接口受限，已改用固定站点版本清单」，
  不会假装是正常结果。
- 更新说明读不到时带 `notesUnavailable: true`，界面显示
  「更新内容暂时读不到（GitHub 接口受限）」而不是谎称"本版没有说明"。

## 3. 已核对线上真实数据（不是假设）

| 核对项 | 实测结果 |
| --- | --- |
| 版本清单 | `GET https://lpossj.github.io/roomcast/version.json` → `{"version":"0.14.3-beta.2","peerAuthProtocol":2}` ✅ |
| 资产命名 | `Roomcast-0.14.3-beta.2-Windows.exe`、`-Windows.zip`、`SHA256.txt` 均存在于该 tag ✅ |
| 资产直链形态 | `https://github.com/lpossj/roomcast/releases/download/v0.14.3-beta.2/<资产名>` ✅ |
| 说明文件路径 | `docs/RELEASE_NOTES-0.14.3-beta.2.md` 在对应源码 tag 下存在 ✅ |
| 当前发布为预发布 | `"prerelease": true`，因此降级路径同样执行"稳定版不推送测试版"的规则 ✅ |

## 4. 单测（新增 2 项，共 12 项）

| 用例 | 覆盖 |
| --- | --- |
| `a rate-limited GitHub API falls back to the published version manifest` | 403 时改用清单；资产名/直链/校验地址正确；说明从 tag 源码读取并去掉一级标题；`selectInstallAsset` 仍能从中选出 ZIP；**先 API 后清单**的调用顺序 |
| `the manifest fallback keeps the prerelease rule, the no-update result and honest errors` | 稳定版不推测试版；清单不高于当前版本 → 已是最新；说明读不到 → `notesUnavailable`；清单也挂时**抛原始限流错误而不是"未知错误"** |

## 5. 验证结果

- 更新相关单测：`tests/update-check.test.mjs` 12/12 通过。
- 全量：**184 项 / 181 通过 / 3 项沙箱环境限制**（同 STEP-07 §1.1，与本次改动无关）。
- 重新打包测试包并用 asar 逐项核对：`update-check.mjs 含限流降级路径 = true`、
  `main.cjs 含自动更新流水线 = true`、`updater.js 含重新打开程序按钮 = true`、版本号 `0.14.3-beta.1`。

## 6. 残留与取舍

- 若 `raw.githubusercontent.com` 不可达（部分地区会被拦截），只影响**更新说明的显示**，
  更新本身仍可继续；界面已如实提示。
- 清单来自 gh-pages，若某次网页发布失败/滞后，清单可能落后于最新 release：
  此时表现为"检查不到更新"（安全方向），不会误装旧版本或错误降级。
- 未加"本地缓存上次检查结果"：清单降级已经不吃额度，再加缓存会让"手动检查更新"看起来不刷新，
  因此刻意不做。
