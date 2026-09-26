# STEP-13 停用网页包（WebViewer）的打包与发布

> 时间：创建于 2026-09-26 16:37；本步的完整时间线见 [TIMELINE-全程时间戳记录.md](TIMELINE-全程时间戳记录.md)。

- 触发：用户指令「webviewer 删了，平时也用不到，平时不以网页版为房主建房间」
- 决策：采用**方案 A —— 只停掉网页包的打包与发布**，保留固定站点与"观看者用浏览器打开邀请"的能力。
- 发布安排：**不进 0.14.3-beta.3**（该版本此刻正在构建），随下一个版本发布。

## 1. 为什么不是"彻底删掉网页入口"

项目里的"网页版"有两个完全不同的用途，删错会把邀请链接弄坏：

| 用途 | 依赖 | 本步处理 |
| --- | --- | --- |
| **观看者**用浏览器打开邀请（0.14.3-beta.2 的核心功能） | `electron/web-invite.cjs` 默认入口 `https://lpossj.github.io/roomcast/`；`src/App.jsx` 的「电脑／手机网页观看链接」 | **保留**（朋友无需装 Roomcast 即可观看） |
| 网页版**当房主建房** / 网页端再次分享 | 同一个站点 | 保留站点即可；维护者不使用该路径 |
| 桌面端**限流降级**读站点 `version.json` | `electron/update-check.mjs` | **保留**（只是不再随版本更新，见下） |
| 网页包的**打包与发布** | `scripts/package-web-viewer.mjs` + `npm run package:web` | **本步删除** |

## 2. 改动内容

| 时间 | 改动 | 位置 |
| --- | --- | --- |
| 16:37 | 删除网页包打包脚本 | `scripts/package-web-viewer.mjs`（原产物为 `release/Roomcast-<版本>-WebViewer` + `version.json`） |
| 16:37 | 移除 npm 脚本 `package:web` | `package.json` |
| 16:37 | 新增「网页入口站点（自 0.14.3-beta.3 起不再随版本发布）」一节，写明后果 | `docs/RELEASING.md` |

**未改动**（有意保留）：站点本身、`electron/web-invite.cjs` 的默认入口、分享弹窗的网页观看链接、
`electron/update-check.mjs` 的 `version.json` 降级路径、以及断言"固定入口必须配置完整 HTTPS 路径"的
`scripts/check-network-architecture.mjs`。

删除前已确认引用面：`package-web-viewer` / `package:web` **只被它自己与 `package.json` 引用**；
`docs/RELEASING.md` 与 `.github/workflows/release.yml` **从来没有**这一步（网页包一直是本地手工发布）。

## 3. 后果（必须知道）

1. 固定站点保持 beta.3 之前已发布的内容；**新版本的界面改动不会出现在网页端**，观看链接仍然可用。
2. 站点的 `version.json` 不再更新 → 桌面端在 GitHub 接口被限流时读到的降级版本号会停留旧值。
   这是**安全方向**：只会"检查不到更新"，不会误装、不会报错。
3. 若将来要恢复网页发布：重新加回打包脚本（把 `dist/` 复制到站点目录并写 `version.json`），
   或直接手工把当前 `dist/` 部署到 gh-pages。

## 4. 验证

- `npm test` → **188 / 188 通过**（无任何代码或测试引用被删脚本）。
- 全仓库引用扫描：删除后仅 `package.json` 一处残留引用，已同步移除，现为 0。
- 既有产物（`release/Roomcast-0.14.2-beta.3-WebViewer*`、`release/Roomcast-0.14.3-beta.2-WebViewer*`，约 0.5MB）
  属于 `release/` 下 gitignored 的历史产物，**未删除**；如需彻底清理可自行删除。
