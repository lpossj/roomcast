# STEP-12 发布 0.14.3-beta.3（提交与推送）

> 时间：创建于 2026-09-26 16:34；本步的完整时间线见 [TIMELINE-全程时间戳记录.md](TIMELINE-全程时间戳记录.md)。

- 触发：用户指令「提交，commit 和 release 的 push，版本号 0.14.3-beta.3」
- 本步只做版本号、发布文档、提交与推送，不改功能代码。

## 1. 逐步操作与时间戳

| 时间（UTC+8） | 操作 | 结果 / 证据 |
| --- | --- | --- |
| 16:29–16:31 | 版本号 → `0.14.3-beta.3` | `package.json` + **`package-lock.json` 两处**（`version` 与 `packages[""].version`） |
| 16:31 | `README.md` 发布说明链接改指 `docs/RELEASE_NOTES-0.14.3-beta.3.md` | 版本一致性测试要求 |
| 16:31 | `docs/STATUS.md` 增补 beta.3 已验收/未覆盖边界 | 与检查表口径一致 |
| 16:31 | 新增 `docs/RELEASE_NOTES-0.14.3-beta.3.md` | **这份正文就是发布页 body，也是更新弹窗里用户看到的"更新内容"** |
| 16:31 | 新增 `docs/RELEASE_CHECKLIST-0.14.3-beta.3.md` | 含 4 项明确未覆盖项 |
| 16:31 | `CHANGELOG.md` 增加 0.14.3-beta.3 条目 | — |
| 16:31 | 给 `docs/auto-update/` 全部 **16 份文档**补时间戳表头 | 时间取自文件系统创建时间（STEP-01 15:09 … STEP-11 16:06，FULL-REVIEW 16:23，TIMELINE 16:25） |
| 16:31 | `npm test` | 首次 **失败**：`version.test.mjs` 断言 `package-lock.json` 版本应等于 `package.json`（我只改了后者）→ 修好两处后 **188/188 通过** |
| **16:32:12** | 提交 `a3788f9`「Add fully automatic desktop update and release 0.14.3-beta.3」 | 40 个文件，+3610 / −40 |
| **16:32:12** | 打注释标签 `v0.14.3-beta.3` | tagger `lpossj`，tag 对象 `2baa462` |
| **16:32:20** | 推送标签 | 成功 → **触发 Release 工作流 `36230079046`** |
| **16:32:22** | Release 工作流启动 | `Build beta release` 作业运行中 |
| 16:32:2x | 推送 `main` **被拒** | 远端有我没有的提交（之前 `git fetch` 因**未配代理**失败，本地 `origin/main` 陈旧） |
| 16:32:3x | 用 `git -c http.proxy=http://127.0.0.1:7890` 拉取 | 远端多出 `12bd388 Clarify beta release validation…` |
| 16:32:41 | `pull --rebase origin main` | **无冲突**（该提交改的正是我在 STEP-01 同步的那 3 个文档，内容已一致）→ `main` = `ae2c6ba` |
| 16:32:4x | 校验 tag 提交与 main 的树差异 | **diff 为空** → 发布内容与主线完全等价 |
| **16:32:5x** | 推送 `main` | 成功 `12bd388..ae2c6ba` → 触发 CI 工作流 `36230100244` |
| 16:33+ | 发布页 | `v0.14.3-beta.3` 尚不存在（工作流最后一步先建草稿再转正式，预计 30–60 分钟） |

## 2. 关键坑与结论

1. **版本号有三处**：`package.json`、`package-lock.json` 的 `version` 与 `packages[""].version`。
   仓库自带测试会强制三者一致 —— 这正是它的价值（我漏第二处时立刻被拦住）。
2. **本机 git 需要显式代理**：系统代理是 `127.0.0.1:7890`（已启用），但 git 不会自动使用 Windows 系统代理，
   必须 `-c http.proxy=… -c https.proxy=…`；否则表现为"连不上 github.com:443 超时"。
3. **推送顺序**：标签先推（尽快触发构建），主线后被拒 → 变基后补推。发布 tag 指向 `a3788f9`，
   主线为 `ae2c6ba`，两者**树完全一致**（因为变基只把同一批改动搬到了你已有的 `12bd388` 之上）。
4. **`version.json` 需另行发布**（见下）。

## 3. 遗留：网页站点 `version.json` 未随本次发布更新

- 限流降级依赖 `https://lpossj.github.io/roomcast/version.json`；它由网页包（gh-pages）发布产生。
- **Release 工作流只把 `Roomcast-<版本>-WebViewer.zip` 作为资产上传，不会自动部署 gh-pages**，
  因此该文件目前仍是 `0.14.3-beta.2`。
- 影响：GitHub 接口被限流时，用户只会被提示到 beta.2（**安全方向**：不会误装、不会报错），但会滞后。
- 处理方式（任选）：把 `WebViewer.zip` 解出后推到 gh-pages 分支；或等接口恢复正常后由 API 路径提示 beta.3。
