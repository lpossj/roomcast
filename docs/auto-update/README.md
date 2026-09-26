# Roomcast 全自动更新改造 · 分步记录

> 时间：创建于 2026-09-26 15:17（取自文件系统）；本步的完整时间线见 [TIMELINE-全程时间戳记录.md](TIMELINE-全程时间戳记录.md)。

本目录按步骤记录本次「源码同步 + 启动更新弹窗 + 自动下载替换重启」的全部改动与复核结果。
每一步一个文档，包含：目标、改动、依据、验证方式与结果、审查结论与遗留风险。

| 步骤 | 文档 | 内容 |
| --- | --- | --- |
| 1 | [STEP-01-源码对比与同步.md](STEP-01-源码对比与同步.md) | 与最新源码逐文件 SHA256 对比；结论：代码零差异，仅 3 个文档需同步 |
| 2 | [STEP-02-全自动更新设计.md](STEP-02-全自动更新设计.md) | 目标流程、安装目标探测、ZIP 解压选型、覆盖策略、安全边界、失败路径、改动清单 |
| 3 | [STEP-03-下载与校验改造.md](STEP-03-下载与校验改造.md) | 流式下载 + 进度回调 + `.part` 暂存；安装资产选择 |
| 4 | [STEP-04-自动替换模块.md](STEP-04-自动替换模块.md) | 新增 `electron/update-install.mjs`：目标校验、纯 Node 解压、替换脚本、临时目录清理 |
| 5 | [STEP-05-主进程与更新窗口.md](STEP-05-主进程与更新窗口.md) | 更新进度窗口、IPC 与发送方校验、偏好键补全、启动清理 |
| 6 | [STEP-06-界面更新弹窗.md](STEP-06-界面更新弹窗.md) | 启动二级弹窗（版本/更新内容/不再弹出/立即更新/可关闭）、设置面板增强、样式 |
| 7 | [STEP-07-测试与验证.md](STEP-07-测试与验证.md) | 全量测试（182 项 / 179 通过）、构建、真实执行替换脚本、本机无法验证项 |
| 8 | [STEP-08-审查与失败模式分析.md](STEP-08-审查与失败模式分析.md) | 独立审查 13 项问题的处理结果、自查问题、20 条发散失败模式与是否接受 |
| 9 | [STEP-09-限流降级修复.md](STEP-09-限流降级修复.md) | 真机报「GitHub 接口请求过于频繁」的根因与修复：改用固定站点版本清单降级，校验标准不降级 |
| 10 | [STEP-10-目标校验误判修复.md](STEP-10-目标校验误判修复.md) | 真机报「缺少 resources/app.asar」的取证与修复：以实际加载的 asar 定位目录、报错自诊断、修掉下载残留泄漏 |
| 11 | [STEP-11-自驱动端到端检查.md](STEP-11-自驱动端到端检查.md) | 自驱动脚本 `check-auto-update.cjs`；它抓出并修掉 2 个真问题，并更正了"沙箱限制"的误判 |
| 12 | [STEP-12-发布0.14.3-beta.3.md](STEP-12-发布0.14.3-beta.3.md) | 提交与发布操作的时间戳记录（版本号三处、git 代理坑、发布工作流与遗留的 `version.json`） |
| — | [FULL-REVIEW-代码全量审查.md](FULL-REVIEW-代码全量审查.md) | **全量代码审查**：20 项发现（3 阻塞 / 5 主要 / 9 次要 / 6 项接受风险）与最终验证证据 |
| — | [TIMELINE-全程时间戳记录.md](TIMELINE-全程时间戳记录.md) | **带时间戳的全程记录**：每一步做了什么、发现什么、改了什么（含三处精确时间的真机取证） |
| — | [端到端实测说明.md](端到端实测说明.md) | 怎么重建 beta.1 测试包、怎么一条命令跑完端到端验证、失败怎么取证 |
| — | [CLEANUP-工作区清理与文件审查.md](CLEANUP-工作区清理与文件审查.md) | 工作区清理前后（释放 510MB）、仓库文件审查、清理后的功能验证 |

## 一句话流程

```
启动 4s 后自动检查（GitHub 接口 → 限流时改用固定站点版本清单）
→ 有新版本且未勾选"不再弹出" → 弹窗（版本 / 更新内容 / 立即更新 / 稍后 / ✕）
→ 立即更新：建更新进度窗口 → 优雅关闭正在运行的程序 → 下载(进度) → SHA256 校验
→ 解压到 %TEMP% → 退出后由 apply.cmd 覆盖程序目录 → 自动重新打开
```

## 主要改动文件

新增：`electron/update-install.mjs`、`electron/updater-preload.cjs`、`public/updater.html`、
`public/updater.js`、`tests/update-install.test.mjs`、`scripts/check-update-apply.cjs`、
`scripts/check-auto-update.cjs`、本目录文档。

修改：`electron/main.cjs`、`electron/preload.cjs`、`electron/update-check.mjs`、
`src/App.jsx`、`src/preferences.js`、`src/styles.css`、`tests/update-check.test.mjs`、
`docs/RELEASE_*.md`（STEP-01 同步）。

未改动：`server/`、`src/useRoom.js`、`src/ScreenPlayer.jsx`、P2P/VDO/TURN、采集与音频、房间协议、
`scripts/` 下的发布脚本。
