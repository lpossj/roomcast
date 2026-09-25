# Roomcast 发布流程

当前发布线：0.14.x 公开测试版（Beta）。本文面向维护者，说明如何从源码构建、验证和发布。

## 版本定位

- 0.x 版本是公开测试版，允许在 minor 版本中调整行为，但不承诺完整跨版本兼容。
- 每次发布一个 tag：vMAJOR.MINOR.PATCH，例如 v0.14.2-beta.1。
- GitHub Releases 是主发布渠道；Gitee 可以作为镜像，但必须使用同一份构建产物和 SHA256。
- Beta 发布使用 GitHub 的 prerelease 标记，不宣称正式版或稳定版。

## 发布前检查

在干净源码目录运行：

```powershell
npm ci
npm run fetch:runtime
npm run setup
npm run check
```

npm run check 会依次执行许可证检查、单元测试、Vite 构建和网络架构自检。

注意 `check` 的顺序是"先测试、后构建"，所以单元测试**不得依赖 `dist/` 等构建产物**（`dist/` 被 gitignore，干净检出上不存在）。测试需要构建产物时请自建临时 fixture，否则 CI 与 Release workflow 会在测试步骤失败。

如果 npm run fetch:runtime 需要的 loopback 组件 ZIP 还没有发布，可以：

```powershell
$env:ROOMCAST_LOOPBACK_ARCHIVE = "C:\path\to\roomcast-loopback-capture.zip"
npm run fetch:runtime
```

或设置 ROOMCAST_LOOPBACK_ARCHIVE_URL 指向稳定下载地址。

## 首次引导：发布 loopback 组件资产

仓库不包含第三方预编译的 loopback_capture_addon.node。首次发布前需要：

1. 在已有运行环境中执行 npm run package:runtime，生成 release/Roomcast-0.14.2-beta.1-loopback-capture.zip。
2. 新建一个已发布的 runtime 资产 Release（例如 tag 为 runtime-2026.09，标题为 Roomcast Runtime Assets），把这个 ZIP 上传为公开资产。不要只放在 draft release，否则 CI 无法匿名下载。
3. 在 GitHub 仓库 Variables 中设置 ROOMCAST_LOOPBACK_ARCHIVE_URL 为该 runtime 资产的稳定下载地址。
4. 后续 CI 发布和源码构建都通过该地址下载并校验 SHA256。

如果暂时使用网盘，也可以把直链配置到该变量，但稳定性由维护者负责。

## 本地构建与打包

```powershell
npm run prepare:release   # fetch:runtime + fetch:web-invite + prepare:obs:release
npm run release:build
npm run package:source
npm run package:runtime
node scripts/generate-checksums.mjs --strict
npm run verify:release
```

`npm run fetch:web-invite` 会下载并校验内置 cloudflared（固定版本 + 官方 SHA256）；`electron-builder` 的 `beforePack` 也会自动执行一次，本地无需手动重复。

产物：

- release/Roomcast-<version>-Windows.exe
- release/Roomcast-<version>-Windows.zip
- release/Roomcast-<version>-source.zip
- release/Roomcast-<version>-loopback-capture.zip
- release/SHA256.txt
- runtime/obs-source/OBS-Studio-32.1.2-Sources.tar.gz

发布前应在干净 Windows 10/11 x64 机器上完成当前版本对应的 `docs/RELEASE_CHECKLIST-<version>.md` 验收项。若该版本还没有检查表，先按 `docs/RELEASE_CHECKLIST-0.14.2-beta.7.md` 复制一份再执行，不要沿用上一版结论。

## 构建机卫生

electron-builder 的 portable / NSIS 目标会在 `%TEMP%` 下使用一个 `ns<random>.tmp` 工作目录，里面是完整的应用归档（`app-64.7z`，约 0.5–1.2 GB）。构建成功时它会自行清理，但构建被中断时会留下残骸，反复打包会静默占满磁盘。

```powershell
npm run clean:build-scratch         # 只列出可回收的目录
npm run clean:build-scratch:apply   # 实际删除
```

清理器有四重护栏：目录必须位于临时目录根下、名字匹配 `ns*.tmp`、内部存在 `app-64.7z` 或 `7z-out/`、最近 60 分钟内没有写入（默认值，可用 `--min-age-minutes` 调整），并且**把目录改名成功**才算判定为废弃。

最后一条是必须的：Roomcast 便携版的运行时解压目录**和打包暂存目录形状相同**（同样是 `ns*.tmp`，同样含 `app-64.7z` 和 `app\resources\app.asar`），只靠名称与内容无法区分。Windows 不允许重命名装有正在运行的 exe/DLL、或正被某进程作为工作目录的目录，所以改名探测能可靠识别"打包中"与"便携版正在运行"两种情况；探测失败就原样保留。因此该清理器不会误删正在运行的应用数据目录。

`beforePack` 会在每次打包前自动执行一次。

## GitHub Actions

- .github/workflows/ci.yml：main 分支和 PR 的 Windows 检查。
- .github/workflows/release.yml：推送 v* tag 或在 Actions 中手动触发，构建 Beta Release。
- Release workflow 需要仓库变量 ROOMCAST_LOOPBACK_ARCHIVE_URL，指向 loopback 组件 ZIP 的稳定地址。
- Release workflow 会自动执行 npm ci、npm run check、npm run fetch:runtime、npm run prepare:obs:release、许可证发布检查、构建打包、源码包、loopback 资产包、SHA256、verify:release，最后创建 GitHub prerelease 并上传资产。

## 发布文案

Beta 发布说明应包含：

- 明确的 Beta 定位；
- 核心变更；
- 已知限制；
- 未签名状态和 SHA256；
- 第三方组件和公网服务说明；
- 升级与回滚方式；
- 问题与安全报告渠道。

可使用 docs/RELEASE_NOTES-TEMPLATE.md 起草新版本说明，并保存为 docs/RELEASE_NOTES-<version>.md。

## 回滚

发布后如果发现严重问题：

- 不覆盖或删除已发布的二进制资产。
- 在 Release 中注明问题影响范围。
- 发布新的 patch 或 beta 版本修复。
- 必要时把 GitHub Release 标记为 prerelease 或撤回 latest 指针，但保留原资产和校验值。

## 提交与打 tag

发布源码包和 tag 前必须先提交所有发布改动，并确保工作区干净。推荐流程：

```powershell
git add -A
git commit -m "Release Roomcast <version> Beta"
git tag v<version>
git push origin main v<version>
```

`npm run package:source` 会检查工作区是否干净，避免把未提交内容错误地排除在源码包之外。
