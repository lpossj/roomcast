# Roomcast 发布流程

当前Windows桌面版本0.14.4-beta.3；线上网页仍为0.14.4-beta.2。package.json决定版本，Git tag为v<version>，公开版本的客户端文件和标签保持固定。不要用旧验收报告冒充本次结果。

## 构建与检查

在Windows x64运行：

```powershell
npm ci
npm run setup
npm run prepare:release
npm run check:release
npm run release:build
node scripts/generate-checksums.mjs --strict --published-only
npm run check:obs-package
node scripts/check-portable-lifetime.cjs release/Roomcast-0.14.4-beta.3-Windows.exe
node scripts/check-capture-backend-switch.cjs
npm run verify:release
```

日常 `npm test` 运行249项快速回归，`npm run check` 增加许可、构建和网络门禁。发布 `npm run check:release` 使用完整260项回归，额外覆盖11项多人迁移、超时和恢复场景；先测试后构建，测试自行建立夹具。实际注册/手机/公网需要补充[当前状态](STATUS.md)列出的真机范围，不能由自动检查推定。

loopback组件取自独立runtime-2026.09 Release中的稳定资产，固定SHA验证；可用ROOMCAST_LOOPBACK_ARCHIVE或ROOMCAST_LOOPBACK_ARCHIVE_URL覆盖取得路径。详见[运行时组件](LOOPBACK-CAPTURE-COMPLIANCE.md)。OBS运行时及对应源码由prepare:obs:release验证；发布许可门禁必须保留。

## 发布附件

- Roomcast-<version>-Windows.exe：便携运行。
- Roomcast-<version>-Windows.zip：目录版。
- SHA256.txt：仅列两份Windows文件和OBS源码的摘要。
- OBS-Studio-32.1.2-Sources.tar.gz：对应第三方源码交付。

Roomcast源码用GitHub自动生成的Source code ZIP/tar.gz；无需另上传重复源码ZIP、WebViewer ZIP、BUILDINFO或每版重复loopback ZIP。本地可运行package:source、package:runtime保存开发归档；默认checksums仍可核对完整本地运行时，公开附件清单使用--published-only。

## 网页部署

默认https://roomcast-2dy.pages.dev/，桌面/网页可创建房间，浏览器按能力提供采集。运行npm run package:web生成白名单静态目录，部署index/assets/404/version/_headers，禁止上传桌面API、updater、server/electron。无需Quick Tunnel或网站账号。检查线上版本、资源、邀请、权限门控及实际入口；不重复下载Windows包。

## GitHub Actions与手工上传

CI负责Windows项目检查；Release workflow只在v*标签或明确手工dispatch时构建、执行门禁并上传上述四项。配置ROOMCAST_LOOPBACK_ARCHIVE_URL稳定运行时地址。用户选择直接上传时，复用同代码已验收成品；先草稿核对文件/摘要/标签，再公开prerelease。

更新已有公开Release的附件说明或删重复文件，需要明确授权并先保存原清单；不覆盖EXE/ZIP，不移动已公开tag。若保持同版本重包，已安装同号版本不会自动发现，必须明确提示手动下载。

## 构建机与记录

npm run clean:build-scratch先盘点，:apply才清理；清理器校验目录形状、年龄、占用、既存claim，保护运行中的便携目录。公开说明写变更、验证边界、未签名、升级方式和安全报告渠道；本地工作记录单独保留，不作为发布附件。
