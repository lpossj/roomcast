# Roomcast 发布流程

当前本地Windows成品及线上电脑/手机网页版本0.14.4-beta.9，Windows beta.9尚未上传GitHub；网页已部署到既有Pages项目roomcast的生产main。package.json决定版本，Git tag为v<version>，公开版本的客户端文件和标签保持固定。不要用旧验收报告冒充本次结果。

## 构建

在Windows x64运行：

```powershell
npm ci
npm run setup
npm run prepare:release
npm run release:build
npm run package:source
node scripts/generate-checksums.mjs --strict --published-only
```

自动化测试、CI 和发布验收脚本已按维护者要求删除。发布由维护者人工验收，实际注册、手机、公网及校园网表现不能由历史记录推定。构建和打包命令仍可使用；当前修改不执行验收或发布。

loopback组件取自独立runtime-2026.09 Release中的稳定资产，下载时保留固定SHA完整性校验；可用ROOMCAST_LOOPBACK_ARCHIVE或ROOMCAST_LOOPBACK_ARCHIVE_URL覆盖取得路径。详见[运行时组件](LOOPBACK-CAPTURE-COMPLIANCE.md)。OBS运行时及对应源码由prepare:obs:release准备。EasyTier完整修改后源码由beforePack复制为同版本独立附件，客户端保留许可证与SOURCE-NOTICE.txt；本地缓存sources.zip及摘要清单仍保留，不删裁依赖源码。

## 发布附件

- Roomcast-<version>.exe：便携运行。
- Roomcast-<version>.zip：目录版。
- Roomcast-<version>-source.zip：从对应发布提交的 HEAD 生成的项目源码归档，正式上传并纳入 SHA256 校验。
- Roomcast-<version>-EasyTier-sources.zip：完整对应源码，含修改、依赖、锁文件和构建说明，不是客户端。
- SHA256.txt：列两份Windows文件、Roomcast项目源码、EasyTier对应源码及OBS源码的摘要。
- OBS-Studio-32.1.2-Sources.tar.gz：对应第三方源码交付。

Roomcast项目源码先提交到对应发布commit，再运行package:source从固定HEAD生成同版本source.zip，随客户端上传并用SHA256.txt校验；GitHub自动生成的Source code ZIP/tar.gz仍可作为补充入口。无需上传WebViewer ZIP、BUILDINFO或每版重复loopback ZIP；package:runtime可保存本地运行时归档。默认checksums仍可核对完整本地运行时，公开附件清单使用--published-only。

EasyTier源码附件必须与对应客户端一起交付，公开下载时在同一Release提供免费源码入口，并在二进制分发期间维持访问；不能用上游未修改源码或GitHub自动生成的Roomcast源码包替代。离线交付同时提供该附件。SOURCE-NOTICE.txt记录准确文件名、核心版本、commit与SHA256。仅生成本地附件不代表已上传Release；自定义输出目录使用checksums的--release-dir指定目录。

## 网页部署

默认https://roomcast-2dy.pages.dev/，桌面/网页可创建房间，浏览器按能力提供采集。运行npm run package:web生成白名单静态目录，部署index/assets/404/version/_headers，禁止上传桌面API、updater、server/electron。无需Quick Tunnel或网站账号。检查线上版本、资源、邀请、权限门控及实际入口；不重复下载Windows包。

## GitHub Actions与手工上传

CI工作流已删除；Release workflow只在v*标签或明确手工dispatch时构建并上传上述六项，不再执行发布验收门禁。配置ROOMCAST_LOOPBACK_ARCHIVE_URL稳定运行时地址。维护者人工验收后授权发布；用户选择直接上传时，复用同代码已验收成品。

更新已有公开Release需要明确授权并先保存原清单。默认不覆盖EXE/ZIP，不移动已公开tag。beta.7按本轮明确要求采用同版本修订：保存旧包和摘要，先上传临时修订附件并核对服务器digest，再替换同名EXE/ZIP/SHA；固定tag保留首发基线，在Release说明记录实际修订commit及源码链接。已安装同号版本不会自动发现，必须明确提示重新下载覆盖。

## 构建机与记录

npm run clean:build-scratch先盘点，:apply才清理；清理器校验目录形状、年龄、占用、既存claim，保护运行中的便携目录。公开说明写变更、验证边界、未签名、升级方式和安全报告渠道；本地工作记录单独保留，不作为发布附件。
