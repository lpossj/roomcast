# Roomcast 0.14.2-beta.2 Beta Release Checklist

本版是 0.14.2-beta.1 的缺陷修复版。已勾选项表示本轮已实际执行并通过；未勾选项表示尚未执行或未完成，不得当作已通过。

## 1. 源码和版本

- [x] package.json version = 0.14.2-beta.2
- [x] package-lock.json version = 0.14.2-beta.2
- [x] 新增 docs/RELEASE_NOTES-0.14.2-beta.2.md
- [x] CHANGELOG 增加 0.14.2-beta.2 条目
- [ ] README / 其它 docs 的版本号引用全部更新
  - 说明：`docs/使用教程与注意事项.md`、`docs/AZURE-TRUSTED-SIGNING.md`、`docs/FREE-CODE-SIGNING.md`、`docs/LOOPBACK-CAPTURE-COMPLIANCE.md`、`docs/RELEASING.md` 仍含 beta.1 示例；`docs/RELEASE_NOTES-0.14.2-beta.1.md` 与 `docs/RELEASE_CHECKLIST-0.14.2-beta.1.md` 为历史记录，应保持不变。
- [x] `scripts/fetch-runtime.mjs` 的 `DEFAULT_LOOPBACK_ARCHIVE_URL` 保持指向已发布的 `runtime-2026.09` 资产（loopback 组件版本与主版本 tag 解耦，不得随主版本号改动）
- [x] 发布说明定位为公开测试版（Beta）

## 2. 构建和测试

```powershell
npm ci
npm run fetch:runtime
npm run setup
npm run check
```

- [x] 全量单元测试通过（143/143）
- [x] Vite build 通过
- [x] check:network 通过
- [x] check:licenses 通过
- [x] OBS 相关检查脚本通过：check-obs-graceful-shutdown / check-obs-managed-termination / check-obs-bundle-resolution
- [x] 新增回归测试能在修复前代码上失败（已用独立复现验证）

## 3. 打包

```powershell
npm run prepare:obs:release
npm run release:build
npm run package:source
npm run package:runtime
node scripts/generate-checksums.mjs --strict
npm run verify:release
```

- [ ] release/Roomcast-0.14.2-beta.2-Windows.exe 存在
- [ ] release/Roomcast-0.14.2-beta.2-Windows.zip 存在
- [ ] release/Roomcast-0.14.2-beta.2-source.zip 存在
- [ ] release/Roomcast-0.14.2-beta.2-loopback-capture.zip 存在
- [ ] release/SHA256.txt 存在
- [ ] check-packaged-obs-step5d.cjs 通过
- [ ] verify:release 通过

## 4. 包内容检查

- [ ] resources/LICENSE 存在
- [ ] resources/NOTICE 存在
- [ ] resources/THIRD-PARTY-NOTICES.txt 存在
- [ ] resources/ACCEPTABLE_USE.md 存在
- [ ] resources/PRIVACY.md 存在
- [ ] resources/SECURITY.md 存在
- [ ] resources/TRADEMARKS.md 存在
- [ ] resources/runtime/obs-bundle 存在且无 config/
- [ ] resources/runtime/obs-source 存在
- [ ] resources/runtime/loopback-capture 存在
- [ ] 没有 Quick Tunnel / MediaMTX 残留
- [ ] 包内 `electron/obs-fixed-fps.cjs` 已包含 `removeOwnedInput`（确认包里就是最终源码）

## 5. 干净 Windows 机器验收

beta.1 已完成一轮干净环境验收；本版修改了 OBS 清理、准备流程、P2P 等待窗口和来源选择，因此**不能直接沿用 beta.1 的结论**。

- [ ] 无系统安装 OBS 时可启动
- [ ] OBS 来源首次枚举成功
- [ ] OBS → 原生 → OBS 切换后仍能开始共享
- [ ] 开始采集、共享期间打开修改页面、修改参数、重启采集
- [ ] 正常停止采集；退出后无 OBS / Electron / Roomcast 残留
- [ ] 原生采集正常
- [ ] 虚拟摄像头首次注册（需要 UAC 时单独确认，不擅自改全局注册）
- [ ] 两端首次入房（真实 NAT / 跨机）可一次成功
- [ ] 系统声音 / 麦克风 / 聊天 / 图片正常
- [ ] 本机服务只监听 127.0.0.1

## 6. 安全与合规

- [ ] 无 .env、TURN Worker access key、长期密钥进入仓库
- [ ] 无旧 .git、backup、PartyLink、临时补丁进入公开源码包
- [x] runtime/、node_modules/、dist/、release/ 不进入公开源码仓库（.gitignore 已覆盖；本轮补齐 `release-*/`，因为 `release-reviewed/` 此前未被忽略，会让 `package:source` 的工作区干净检查失败）
- [x] loopback capture 已按第三方 MIT 预编译组件披露
- [ ] OBS 对应源码归档存在并随 Release 上传
- [ ] License / NOTICE / PRIVACY / SECURITY / TRADEMARKS 齐全
- [ ] PRIVACY 已说明 PeerJS / VDO.Ninja / TURN 公网服务

> 说明：`.env` / 密钥 / backup / 文档齐全等条目本轮没有完成可复核的检查，因此不勾选。本机 DSH 文件沙箱会让 Node 内的 `spawnSync('git', …)` 失败（EPERM），所以任何通过子进程调用 git 的自动检查在本环境都不可信；这些条目需在正常环境下用 `git ls-files` 与 `npm run check` 复核后再勾选。

## 7. 发布产物

- [ ] 明确本次签名状态；已签名时验证 Get-AuthenticodeSignature 为 Valid
- [ ] 未签名时在发布帖注明未签名，不得勾选或宣称签名有效
- [ ] 生成并核对 SHA-256 校验值
- [ ] Release notes 已发布，定位为 Beta
- [ ] 上传 EXE / ZIP / 源码 ZIP / loopback ZIP / OBS 源码 / SHA256
- [ ] SECURITY.md 及发布帖填写实际私密联系渠道
- [ ] 源码 ZIP 按 git archive 生成，不包含本机 theme-preferences.json

## 8. 发布措辞

推荐：

```text
Roomcast 0.14.2-beta.2 公开测试版（Beta）发布。
Windows 10/11 x64。
主体源码 Apache-2.0；Windows 系统音频 loopback 组件为第三方 MIT 预编译组件；OBS runtime 为 GPL，并随包提供对应源码。
当前版本未签名，请核对 SHA256。
仅用于合法、知情同意的屏幕共享和聊天。
```

不要写：

```text
所有组件 100% 开源。
当前版本为正式稳定版。
OBS 偶发清理问题已彻底修复。
```
