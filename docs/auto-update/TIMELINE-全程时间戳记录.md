# 自动更新改造 · 全程时间戳记录

> 时间：创建于 2026-09-26 16:25；**本文档随每一步持续追加**（最近一次追加见文末）。

- 时间：2026-09-26（本机时间，UTC+8）
- 说明：带 **精确时间** 的条目来自可核验的痕迹——各步文档的文件系统创建时间、
  打包目录创建时间、`%TEMP%\roomcast-update-<时间戳>` 目录名、`apply.log` 内容、文件 mtime、
  进程启动时间。个别确实无痕迹的条目保留"顺序"而不编造时间。

---

## 阶段 0 · 源码对比与同步（时间 = 各步文档的文件系统创建时间）

| 时间 | 事件 | 内容 | 证据 |
| --- | --- | --- | --- |
| **15:09** | 对比两侧源码 | 逐文件 SHA256：`ChatGPT\屏幕共享`(A) 201 个文件 vs `roomcast-source`(B) 241 个文件 | `STEP-01`（创建于 15:09） |
| 15:09 | 结论 | **代码零差异**；只有 3 个文档不同（`RELEASE_CHECKLIST/RELEASE_NOTES/WEB_ENTRY_REVIEW-0.14.3-beta.2.md`） | 同上 |
| 15:09 | 同步 | 覆盖复制这 3 个文档；再次比对：差异 0 | 同上 |
| **15:10** | 设计 | 流程、安装目标判定、ZIP 解压选型、覆盖策略、安全边界、失败路径 | `STEP-02`（创建于 15:10） |

## 阶段 1 · 实现（时间 = 各步文档的文件系统创建时间）

| 时间 | 事件 | 内容 |
| --- | --- | --- |
| **15:11** | 下载与校验 | `update-check.mjs`：流式下载 + 进度回调 + `.part` 暂存 + `selectInstallAsset`（`STEP-03`） |
| **15:12** | 替换模块 | 新增 `update-install.mjs`：目标判定 / 纯 Node ZIP 解压 / `apply.cmd` 生成 / 暂存清理（`STEP-04`） |
| **15:17** | 主进程 + 界面 | 更新进度窗口、IPC、偏好键补全（`STEP-05`）；启动二级弹窗与设置面板（`STEP-06`）；索引 `README.md` |
| — | 测试与构建 | `tests/update-install.test.mjs`（13 项）、`tests/update-check.test.mjs`（+3 项）；`vite build` 通过，`dist/updater.html|js` 生成 |
| — | 首轮全量 | 180 项 / 177 通过 / 3 项沙箱限制（阶段 4 末尾：188/188 全绿） |

## 阶段 2 · 独立审查与修复（时间 = 各步文档的文件系统创建时间）

| 时间 | 事件 | 内容 |
| --- | --- | --- |
| **15:28** | 测试与验证 | `STEP-07`：全量测试、构建、真实执行替换脚本（robocopy `/E` 覆盖、保留多余文件、自动重启、清理 payload） |
| **15:28** | 对抗式审查 | `STEP-08`：独立视角通读全部改动 → 13 项问题（2 阻塞 / 3 主要 / 8 次要）+ 20 条发散失败模式 |
| — | 逐条修复 | 便携版等启动器 PID、弹窗 ✕ 不再复现、"等首行日志"守卫、失败标记、超时取消更新、ZIP 边界、ADS、`!`/`%` 路径、死代码 |
| — | 实测发现 | **脚本删除自己的工作目录 → cmd 解释器丢失后续行 → 最后的重启步骤从未执行**（静态审查看不出）→ 已修 + 加回归断言 |
| **15:39** | 限流降级 | `STEP-09`：真机报「GitHub 接口请求过于频繁」→ 改用固定站点版本清单 + tag 源码取说明，校验标准不降级 |
| **15:46** | 目标校验误判 | `STEP-10`：真机报「缺少 resources/app.asar」→ 取证、以实际加载的 asar 定位、报错自诊断、修下载残留泄漏 |
| **16:06** | 自驱动检查 | `STEP-11`：新增 `scripts/check-auto-update.cjs`，抓出 `requireOwner`（销毁窗口后 IPC 失效）与"脚本没跑起来仍退出"两个真问题 |

## 阶段 3 · 真机暴露的问题（精确时间戳）

| 时间 | 事件 | 证据 / 结果 |
| --- | --- | --- |
| 15:09:30 | 探测 `tar.exe` 能否用于解压 | 沙箱拒绝执行 → 改为纯 Node 解压方案（`tar-probe/`） |
| 15:15:19 | 沙箱内全量测试工作流 | `run-all-tests.mjs`（当时 `node --test` 被沙箱拦） |
| 15:22–15:23 | 链式/派生进程探测、`apply.cmd` 编排验证 | `spawn-probe.mjs`、`apply-e2e-prep.mjs`、`apply-e2e/` |
| **15:38:29** | 打包出 beta.1 测试包（当时命名 `-fallback`） | 目录 CreateTime |
| **15:41:00** | 你启动该测试包 | 进程 StartTime |
| **15:41:15 / 15:41:16** | 更新工作目录创建；211MB ZIP 落盘（下载成功） | `%TEMP%\roomcast-update-1790408475271` |
| **15:41:16 之后** | 报「程序目录缺少 resources/app.asar」→ 更新中止 | 你的第 2 张截图 |
| 15:42:12 | 我从测试包 asar 里反编译运行代码，确认与源码一致 | `inspect-asar-updater.cjs` |
| 15:43:49 | 用测试包**真实路径**在 Node 复跑目标校验 → **通过** | 说明"输入/文件系统层面"异常，静态等价复现不了 |
| 15:45:22 | 写 asar 版本核对工具 | `verify-asar.cjs` |
| **15:51:36** | 端到端脚本首次运行 | 进度状态读不到 → 定位 **主窗口销毁后 `requireOwner` 抛错**，更新窗口 IPC 全失效 |
| **16:01:00** | 第二次运行（修 requireOwner 后） | 走到 `restarting`，但**没有 apply.log** → 脚本一行未执行 |
| **16:05:08** | 链式派生探测 | 当时**误判**为"沙箱掐掉两层派生"（阶段 4 证明真因是引号） |
| **16:09:31** | 引号实验：5 种写法对比 | **A（当前写法，`/d /s /c "<路径>"`）一行都不执行**；B/C/E（`/d /c` + 裸路径，含空格）全部成功 → 修 `startApplyScript` |
| **16:10:07** | 重建测试模板（含 requireOwner 修复） | — |
| **16:10:14 / 16:10:17** | 第三次运行 | `16:10:39 update start` / `16:10:42 files replaced, restarting` → 脚本真正执行了 |
| **16:15:41 / 16:15:45** | 你运行的端到端脚本（引号已修） | `16:15:57` 副本 `app.asar` 被覆盖；`16:15:59 / 16:16:02` apply.log；`16:19:31` 运行中的 beta.2 继续写 `resources` |
| 16:19 之后 | 取证：副本 `app.asar` SHA256 `BA9A84D3…D2B1` **与发布版完全一致**；beta.2 正从副本目录运行（7 进程） | **证明替换 + 重启真的成功**，失败的是脚本的"读取" |
| **16:20:48** | 本地复现 `@electron/asar` 按路径缓存归档头（`disk.js:50/152`） | 复现同样的"垃圾 JSON"错误；`uncache` 后读到正确版本 → 修脚本读取 |
| **16:21:12** | 端到端脚本最终运行 | **一次通过**：`0.14.3-beta.1 → 0.14.3-beta.2（下载 → SHA256 校验 → 解压 → 退出 → 覆盖 → 自动重启）` |

## 阶段 4 · 全量审查与清理（收尾）

| 时间 | 事件 | 内容 |
| --- | --- | --- |
| **16:23** | 全量代码审查 | 逐文件通读 + 定向实验 + 线上数据核对 → `FULL-REVIEW-代码全量审查.md`（20 项结论，含 6 项接受风险） |
| 16:23 | 修正错误结论 | `STEP-11` 原写"沙箱掐掉两层派生" → 更正为**引号转义 bug**（真因），并记录 asar 缓存陷阱 |
| 16:25 | 时间戳记录 + 清理报告 | `TIMELINE`（本文）、`CLEANUP-工作区清理与文件审查.md`、`端到端实测说明.md` |
| 16:25 | 清理工作区 | 删除我的一次性文件与测试包 → **释放 510 MB**；其它会话资料与你的发布产物未动 |
| **16:27** | 全量测试 | `npm test` → **188 / 188 通过，0 失败**（原先 3 项"沙箱限制"用例现也通过——确属环境限制） |

## 阶段 5 · 提交与发布 0.14.3-beta.3（详见 `STEP-12-发布0.14.3-beta.3.md`）

| 时间 | 事件 | 结果 |
| --- | --- | --- |
| 16:31 | 版本号 → `0.14.3-beta.3` | `package.json` + `package-lock.json` **两处**；README 链接、STATUS、CHANGELOG、发布说明与验收清单同步 |
| 16:31 | 给 `docs/auto-update/` 全部 16 份文档补时间戳表头 | 时间取自文件系统创建时间 |
| 16:31 | 测试门禁 | 首次失败：漏改 `package-lock.json` 版本 → 修好后 188/188 |
| **16:32:12** | 提交 `a3788f9` + 注释标签 `v0.14.3-beta.3` | 40 文件，+3610 / −40 |
| **16:32:20** | 推送标签 | 成功 → 触发 **Release 工作流 `36230079046`** |
| **16:32:22** | Release 工作流启动 | `Build beta release` 运行中（发布页预计 30–60 分钟后出现） |
| 16:32:41 | `main` 补推送前的变基 | 远端多出 `12bd388`；变基**无冲突** → `main` = `ae2c6ba`，与 tag 提交**树完全等价** |
| 16:32:5x | 推送 `main` | 成功 `12bd388..ae2c6ba` → 触发 **CI 工作流 `36230100244`** |
| **16:47:30** | **Release 工作流完成** | `completed / success`；发布页 `v0.14.3-beta.3` 转正式预发布（`isDraft:false`、`isPrerelease:true`） |
| 16:48 | 发布资产与校验交叉核对 | 6 个资产；发布页 `SHA256.txt` 每个哈希与 GitHub 记录的 `digest` **逐个一致** → 自动更新的 SHA256 校验会通过 |

## 阶段 6 · 网页包停用与网页端改为"只加入"（详见 `STEP-13` / `STEP-14`）

| 时间 | 事件 | 结果 |
| --- | --- | --- |
| 16:34 | 发布记录提交 `143e45d` 并推送 | CI（main）**success** |
| **16:37** | 用户决定：不再打包/发布网页包 | 删除 `scripts/package-web-viewer.mjs` + `npm run package:web`；`RELEASING.md` 写明站点冻结的后果 |
| 16:38 | 提交 `3f173ce` 并推送 | 188/188 测试 + 构建通过 |
| **16:39** | 用户澄清网页端定位：只用邀请链接加入观看；电脑浏览器可共享；**不要网页建房** | 确认需改代码 + **必须重新发布站点** |
| 16:41 | 改 `src/App.jsx`（8 处收口到 `canHostRoom`） | 空屏入口、图标栏 ×2、侧栏、分享按钮、入口弹窗切换、`handleEnter` 硬校验、删除旧提示 |
| 16:41 | 构建 + 全量测试 | 构建通过；`npm test` **188/188** |
| 16:42 | 提交 `1e89172 Make the web client join-only instead of a second host` 并推送 | `3f173ce..1e89172 main` |
| **16:42:32** | **重新发布站点**（gh-pages `fcf7221 → d8b710d`） | 当前 `dist/` 覆盖式合并：保留历史哈希资源，新增 3 个新哈希资源；**不上传桌面的 `updater.*`** |
| 16:43 | 线上核对 | `https://lpossj.github.io/roomcast/version.json` = `{"version":"0.14.3-beta.3",…}`（HTTP 200）→ **STEP-12 的限流降级滞后问题一并解决** |
| 16:43 | beta.3 Release 工作流仍在跑 | 已过 `Package loopback runtime asset`，剩 SHA256 / Playwright / 三项打包验证 / 发布 |
| **16:47:30** | beta.3 Release 完成 | `completed / success`；发布页转正式预发布 |
| 16:48 | 发布资产与 `SHA256.txt` 交叉核对 | 6 个资产哈希与 GitHub 摘要**逐个一致** → 自动更新校验必过 |
| 16:49 | 发布页正文更正 | 补记 16:42 的站点调整（原文写"网页入口未改动"）→ `gh release edit` 同步 |
| **16:51** | 为人工观看生成 `0.14.3-beta.2` 目录版测试包 | 用当前源码 + 临时降版本号打包；附 `启动测试.cmd`（独立数据目录，不与正式版抢锁）与 `怎么测.txt`；源码版本号已还原、git 干净 |

## 阶段 7 · 用户实测反馈 → 修复并发布 0.14.3-beta.4（详见 `STEP-15`）

| 时间 | 事件 | 结果 |
| --- | --- | --- |
| **16:53–16:54** | **用户亲眼看完整自动更新** | 下载 → 校验 → 解压 → 关闭 → 覆盖（`app.asar` 变为发布版 beta.3）→ 自动重启；`apply.log` 记录 `16:53:57 update start` / `16:54:00 files replaced, restarting` |
| 16:55 | 用户反馈两条 | ①「下载便携版 EXE / 下载 ZIP」按钮可删；②更新后冒出**三个 cmd 窗口**，正常使用不应出现 |
| 17:2x | 定位窗口根因（对照实验） | Win32 统计可见 `ConsoleWindowClass`：基线 2 → `detached:true` 时 **3** → 仅 `windowsHide` 时 **2**（零新增） |
| 17:2x | 修复 | `startApplyScript` 去掉 `detached`；`UpdateSection` 删除 EXE/ZIP 按钮与相关状态；删除 `downloadUpdate`/`revealUpdate`（渲染层 + preload + 两个 IPC） |
| 17:2x | 门禁 | 构建通过；`npm test` **188/188**；死代码扫描干净 |
| 17:2x | 版本号 → `0.14.3-beta.4` | `package.json` + `package-lock.json`（两处）+ README 链接；新增发布说明与验收清单、CHANGELOG 条目 |
| **17:15:40** | **beta.4 发布成功** | Release 工作流 `36231452452` `completed/success`；发布页转正式预发布，6 个资产齐全 |
| 17:2x | **真实更新验证（第一轮）** | beta.3（含修复）→ 期望更新到 beta.4，但 app 报 `available:false` → **暴露新缺陷** |
| 17:2x | 定位 | 同一代理下 API 额度 `remaining=0`（403）→ 退回固定站点清单 → 清单停在 beta.3（站点已冻结）→ 检查不到 beta.4 |
| 17:2x | 修复 | 降级链改为"**发布订阅 `releases.atom` 优先**"（同源、含测试版、零额度），站点清单仅作最后备选；新增 3 项单测 |
| 17:2x | 门禁 | 构建通过；`npm test` **191/191**（188 + 3 新增） |
| 17:2x | 版本号 → `0.14.3-beta.5` | 发布说明/验收清单/CHANGELOG/STEP-16 同步；提交 + tag + 推送触发下一次 Release |

## 阶段 8 · 修掉"脚本活不下来"，并改为**只本地提交、不再发版**（详见 `STEP-17`）

| 时间 | 事件 | 结果 |
| --- | --- | --- |
| **17:38:40.73** | beta.4 → beta.5 真实更新暴露新缺陷 | `apply.log` **只有 91 字节一行** `update start`；`download/`、`payload/` 仍在，`app.asar` 仍是 beta.4，无残留 cmd 进程 → **替换脚本被连带终止** |
| 17:4x | 定位 | `detached:true` → `DETACHED_PROCESS`：Windows 因此忽略 `CREATE_NO_WINDOW`（多窗口），但它也是子进程脱离 Chromium job object 的唯一手段 → **窗口与存活二选一** |
| 17:4x | 修复 | 改为**两级隐藏启动器**：`detached` 的隐藏 `powershell.exe` → `Start-Process … -WindowStyle Hidden` 派生 `cmd.exe` 跑脚本；兜底退回 `cmd-detached` |
| 17:4x | 验证 | 可见控制台计数 = **基线 2（零新增）**；标记文件 `ran` → `late` 证明**启动器退出后脚本仍在跑** |
| 17:4x | 单测 | 重写为 `the apply script is launched detached through a hidden launcher`（spawn 目标/参数/选项、带空格路径引号、PID 缺失兜底） |
| 17:4x | 测试债 | 真机归档用例不再依赖已被清理的 `release\Roomcast-0.14.3-beta.1-Windows\`：改为 3 项必做断言 + 两次读取一致性，参照目录仅在存在时逐字节比对 |
| **17:44–17:45** | 反例记录 | 仓库根 `NOTICE`(2437B) ≠ 包内 `NOTICE`(2441B)，不能当参照物；包内 `version` 文件是 Electron 版本(44.3.0)而非 app 版本 |
| **17:46:14** | 门禁 | `node tests/update-install.test.mjs` **17/17**；`npm test` **191/191** |
| **17:47** | 用户叫停发版 | 「你又要 release 一次？我更新 release 被你整乱了」→ 决定 **只在本地 commit**，不打 tag、不 push、不建 Release；核实线上 tag `v0.14.3-beta.1…beta.5` 与远端一一对应、无重复无错位 |
| **17:47** | 登记结论 | **beta.4**：能更新但闪 3 个窗口；**beta.5**：无窗口但替换静默失败 → 从这两版出发无法验证成功更新（执行更新的就是旧代码本身） |

## 阶段 9 · 同号重发 beta.5（覆盖原发布，不新增版本；详见 `STEP-18`）

| 时间 | 事件 | 结果 |
| --- | --- | --- |
| **17:47** | 用户决定 | 「继续发。能不能就 beta5 的 release 修改，而不是再发 beta6」→ 采纳**同号重发** |
| 17:48 | 文档提交 | `dc6dd2e Republish 0.14.3-beta.5 with the launcher fix instead of a new version`（发布说明/CHANGELOG/验收清单同步） |
| 17:48 | 推送 `main` | `c296af8..dc6dd2e` |
| 17:48 | **强推标签** | `git tag -f v0.14.3-beta.5 dc6dd2e` → `+ 820da6c...dc6dd2e (forced update)`；理由：更新界面显示的说明取自标签源码，标签必须与产物同源 |
| 17:48 | 留证基线 | 覆盖前 `SHA256.txt` 存到 `_before/SHA256.txt`（`.exe` `A5E738D5…`、`.zip` `FCA965F2…`） |
| **17:49:02** | **`Release` 运行 `36233912626` 启动** | 同一标签重复构建 → `gh release upload --clobber` 覆盖 6 个资产（不会新建 Release）；`CI` 运行 `36233910226` 同时启动 |
| **18:03:13** | **覆盖构建成功** | `completed / success`、`headSha = dc6dd2e`、用时 **14 分 11 秒**；`CI` 亦 `success` |
| 18:03 | 资产核对 | 新 `SHA256.txt`：`.exe` `0C9A3213…`、`.zip` `AFE89F3F…`、`source.zip` `0EC8AFEE…` **全部与基线不同**；`loopback-capture.zip`、`OBS-…tar.gz`、`addon.node`、`LICENSE`、`cloudflared.exe` **逐字节未变**；6 个资产 `updatedAt` = 10:03 UTC |
| 18:04 | 内容物核对 | 标签源码含 `Start-Process … -WindowStyle Hidden` + `cmd-detached` 兜底；**发布资产 `source.zip` 内的 `electron/update-install.mjs` 同样含修复**（26 017 字节） |
| 18:04 | 发布页正文 | `gh release edit --notes-file docs/RELEASE_NOTES-0.14.3-beta.5.md --prerelease` 同步完成（`draft=false`） |
| 18:04 | 未做（如实登记） | 未下载 221 MB 的 `Windows.zip` 逐字节确认 `app.asar`；改用"同源构建 + `source.zip` 核对 + `verify:release` + 用户真机验收" |

> 坑：**同号重发的唯一真代价**——已运行 beta.5 的机器同版本不触发更新，需手动替换；
> 从 beta.4 更新过来的机器会先由旧代码（可用的 beta.4 脚本）完成一次替换，之后即为修复版。

> 坑：**本机 git 必须显式走代理**（系统代理 `127.0.0.1:7890`，git 不会自动使用），
> 否则 `fetch/push` 表现为"连不上 github.com:443"；也正是它让首次 `main` 推送因本地
> `origin/main` 陈旧而被拒。

---

## 三个"最贵"的教训（都是静态阅读看不出来的）

1. **Electron 的 asar 垫片**：应用从 asar 运行时，`<程序目录>\resources\app.asar` 会被 `fs.stat` 报告为
   **虚拟目录**，`isFile()` 永远为 false → 目录版目标校验必然失败。（真机截图 + 诊断信息锁定）
2. **Node 给 `cmd.exe` 传参的引号**：`/s` + 自己加引号会被 Node 转义成 `\"`，cmd.exe 不认识 →
   脚本一行都不执行，程序却已退出。（5 种写法对照实验锁定）
3. **`@electron/asar` 按路径缓存归档头**：文件被替换后仍用旧头解析 → 永远读到垃圾。
   这是**测试脚本**的坑，不是产品缺陷，但正是它让"看起来失败"了三次。（离屏复现锁定）

> 附带结论：`node --test` 与子进程派生在本会话早期被沙箱拦（EPERM / `STATUS_DLL_INIT_FAILED`），
> 文件策略放开后 `npm test` 直接可用，188 项全绿——早期那 3 项失败确属环境限制。
