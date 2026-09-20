# Roomcast 0.14.1 Beta Release Checklist

## 1. 源码和版本

- [ ] package.json version = 0.14.1
- [ ] package-lock.json version = 0.14.1
- [ ] README / docs 版本号 = 0.14.1
- [ ] 发布说明定位为公开测试版（Beta）
- [ ] 没有残留 0.14.1-rc 源码引用

## 2. 构建和测试

```powershell
npm ci
npm run fetch:runtime
npm run setup
npm run check
```

- [ ] 全量测试通过
- [ ] Vite build 通过
- [ ] check:network 通过
- [ ] check:licenses 通过

## 3. 打包

```powershell
npm run prepare:obs:release
npm run release:build
npm run package:source
npm run package:runtime
node scripts/generate-checksums.mjs --strict
npm run verify:release
```

- [ ] release/Roomcast-0.14.1-Windows.exe 存在
- [ ] release/Roomcast-0.14.1-Windows.zip 存在
- [ ] release/Roomcast-0.14.1-source.zip 存在
- [ ] release/Roomcast-0.14.1-loopback-capture.zip 存在
- [ ] release/SHA256.txt 存在
- [ ] check-packaged-obs-step5d.cjs 通过
- [ ] verify:release 通过
- [ ] packaged OBS verifier 通过

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

## 5. 干净 Windows 机器验收

本轮已在干净 Windows 10/11 x64 环境完成以下验收：

- [x] 无系统安装 OBS 时可启动
- [x] Virtual Camera 首次注册 UAC 正常
- [x] OBS 固定 FPS 采集正常
- [x] 原生采集正常
- [x] 系统声音捕获正常
- [x] 麦克风 / 聊天 / 图片正常
- [x] P2P 优先、VDO 3 秒延迟正常
- [x] TURN 只在 direct race exhausted 后使用
- [x] 本机服务只监听 127.0.0.1
- [x] 退出后无 OBS / Electron / Roomcast 残留

## 6. 安全与合规

- [ ] 无 .env、TURN Worker access key、长期密钥进入仓库
- [ ] 无旧 .git、backup、PartyLink、临时补丁进入公开仓库
- [ ] runtime/、node_modules/、dist/、release/ 不进入公开源码仓库
- [ ] loopback capture 已按第三方 MIT 预编译组件披露
- [ ] OBS 对应源码归档存在并随 Release 上传
- [ ] License / NOTICE / PRIVACY / SECURITY / TRADEMARKS 齐全
- [ ] PRIVACY 已说明 PeerJS / VDO.Ninja / TURN 公网服务

## 7. 发布产物

- [ ] 明确本次签名状态；已签名时验证 Get-AuthenticodeSignature 为 Valid
- [ ] 未签名时在发布帖注明未签名，不得勾选或宣称签名有效
- [ ] 生成并核对 SHA-256 校验值
- [ ] Release notes 已发布，定位为 Beta
- [ ] 上传 EXE / ZIP / 源码 ZIP / loopback ZIP / OBS 源码 / SHA256
- [ ] SECURITY.md 及发布帖填写实际私密联系渠道
- [ ] 源码 ZIP 按 git archive 生成，不包含本机 theme-preferences.json
- [ ] 干净源码环境运行 npm run fetch:runtime + npm run setup 成功

## 8. 发布措辞

推荐：

```text
Roomcast 0.14.1 公开测试版（Beta）发布。
Windows 10/11 x64。
主体源码 Apache-2.0；Windows 系统音频 loopback 组件为第三方 MIT 预编译组件；OBS runtime 为 GPL，并随包提供对应源码。
当前版本未签名，请核对 SHA256。
仅用于合法、知情同意的屏幕共享和聊天。
```

不要写：

```text
所有组件 100% 开源。
当前版本为正式稳定版。
```