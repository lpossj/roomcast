# Roomcast 0.14.2-beta.7 Beta Release Checklist

本版把"电脑／手机网页观看入口"完整交付，并修掉 beta.6 遗留的发布阻断与界面问题。已勾选项表示本轮已实际执行并通过；未勾选项表示尚未执行或未完成，不得当作已通过。

## 1. 源码和版本

- [x] package.json version = 0.14.2-beta.7
- [x] package-lock.json version = 0.14.2-beta.7（与 package.json 一致）
- [x] 新增 docs/RELEASE_NOTES-0.14.2-beta.7.md
- [x] CHANGELOG 增加 0.14.2-beta.7 条目
- [x] docs/STATUS.md 已更新（网页入口的已验收/未验证项，以及"不引入本地数据库"的决定）
- [x] 使用说明 / 使用教程 / EXE使用与异地开房 / RELEASE_NOTES-TEMPLATE 中过期的"观看者必须安装 Roomcast"表述已更新
- [x] PRIVACY / SECURITY / NOTICE 已补充 cloudflared 与 Quick Tunnel 网页入口的披露
- [x] 工作区干净，`npm run package:source` 可用
- [ ] README / 其它 docs 的版本号引用全部更新
  - 说明：`docs/AZURE-TRUSTED-SIGNING.md`、`docs/FREE-CODE-SIGNING.md`、`docs/LOOPBACK-CAPTURE-COMPLIANCE.md` 仍含 beta.1 示例；`docs/RELEASE_NOTES-0.14.2-beta.1`–`beta.6` 与 `docs/RELEASE_CHECKLIST-0.14.2-beta.1`–`beta.6` 是历史记录，应保持不变。

## 2. 构建和测试

```powershell
npm ci
npm run fetch:runtime
npm run setup
npm run check
```

- [x] 全量单元测试通过（154/154）
- [x] **干净检出（无 dist/）下的测试步骤通过**（`check` 顺序是先测试后构建，测试不得依赖 `dist/`）
- [x] Vite build 通过
- [x] check:network 通过
- [x] check:licenses 通过
- [x] 新增 `tests/browser-room-runtime.test.mjs` 与 `tests/build-scratch.test.mjs`
- [x] 真实 Chrome 验证桌面/手机成员控件显示范围与共享按钮降级
- [x] OBS 相关检查脚本通过：check-obs-bundle-resolution / check-obs-graceful-shutdown / check-obs-managed-termination

## 3. 打包

```powershell
npm run prepare:release
npm run release:build
npm run package:source
npm run package:runtime
node scripts/generate-checksums.mjs --strict
npm run verify:release
```

- [x] release/Roomcast-0.14.2-beta.7-Windows.exe 存在（142.9 MB）
- [x] release/Roomcast-0.14.2-beta.7-Windows.zip 存在（211.4 MB）
- [ ] release/Roomcast-0.14.2-beta.7-source.zip 存在
- [ ] release/Roomcast-0.14.2-beta.7-loopback-capture.zip 存在
- [ ] release/SHA256.txt 存在
- [x] check-packaged-obs-step5d.cjs 通过（Step5D PASS，含便携版运行时 preflight 与中文字路径）
- [x] check-portable-lifetime.cjs 通过（第二次启动不会删除运行中实例的 OBS 资源）
- [x] verify:release 通过（欢迎界面、asar 版本、四个运行时组件哈希，含 `runtime/web-invite/cloudflared.exe`）
- [ ] 源码 ZIP 内容与 package.json 版本一致，且包含 `src/browser-room-service.js`、`src/browser-node-crypto.js`、`electron/web-invite.cjs`、`scripts/fetch-web-invite.mjs`、`scripts/clean-build-scratch.mjs`

> 顺序说明：`package:source` 要求工作区干净，因此源码包、loopback 资产包与 `SHA256.txt` 在本版发布提交之后生成；`release:build` 与全部打包后验证在提交之前完成。

## 4. 包内容检查

- [ ] resources/LICENSE 存在
- [ ] resources/NOTICE 存在
- [ ] resources/THIRD-PARTY-NOTICES.txt 存在
- [ ] resources/ACCEPTABLE_USE.md / PRIVACY.md / SECURITY.md / TRADEMARKS.md 存在
- [ ] resources/runtime/obs-bundle 存在且无 config/
- [ ] resources/runtime/obs-source 存在
- [ ] resources/runtime/loopback-capture 存在
- [ ] resources/runtime/web-invite/cloudflared.exe 存在且 SHA256 = 214f5d74f66941d147d054f6cc9d821c60ff6a9b2d5355f6c854c6bee217c548
- [ ] 没有 MediaMTX 残留；媒体路径不引用 trycloudflare / cloudflared
- [ ] 包内 `electron/obs-fixed-fps.cjs` 已包含 `removeOwnedInput`

## 5. 干净 Windows 机器验收

- [ ] 无系统安装 OBS 时可启动
- [ ] OBS 来源首次枚举成功
- [ ] OBS → 原生 → OBS 切换后仍能开始共享
- [ ] 正常停止采集；退出后无 OBS / Electron / Roomcast 残留
- [ ] 原生采集正常
- [ ] 虚拟摄像头首次注册（需要 UAC 时单独确认，不擅自改全局注册）
- [ ] 两端首次入房（真实 NAT / 跨机）可一次成功
- [ ] 系统声音 / 麦克风 / 聊天 / 图片正常
- [ ] 本机服务只监听 127.0.0.1
- [ ] 桌面宽屏下不出现手机成员栏按钮与关闭按钮（截图确认）
- [ ] "分享房间"能拿到可用的 `https://*.trycloudflare.com` 网页观看链接
- [ ] 电脑浏览器打开网页链接可加入房间；支持 `getDisplayMedia` 时可发起共享
- [ ] 手机浏览器打开网页链接可加入、观看、聊天；共享按钮显示"仅支持观看"
- [ ] 离开房间后临时网页入口关闭、地址失效；退出应用后 cloudflared 无残留进程
- [ ] 配置 `PEER_SERVER_URL` 时，非房主成员重新分享的邀请仍带 `signal`

## 6. 手机与弱网专项（需实机）

- [ ] iOS Safari：加入、观看、聊天；切后台再回前台能恢复画面
- [ ] Android Chrome：同上
- [ ] 微信内置浏览器：同上（若不可用，记录实际表现）
- [ ] 锁屏 / 长时间切后台后，房主端成员状态能正确更新
- [ ] 网页房主保持页面运行 30 分钟以上不异常断开

## 7. 构建机卫生

- [x] `npm run clean:build-scratch` 能列出被中断打包遗留的 `%TEMP%\ns*.tmp` 目录
- [x] `npm run clean:build-scratch:apply` 能回收空间，且不会删除仍在进行的打包
- [x] 单元测试覆盖"被占用目录必须保留"（用一个把工作目录设在候选目录内的子进程验证改名探测）
- [x] `beforePack` 在打包前自动执行一次清理

## 8. 安全与合规

- [ ] 无 .env、TURN Worker access key、长期密钥进入仓库
- [ ] 无旧 .git、backup、PartyLink、临时补丁进入公开源码包
- [x] runtime/、node_modules/、dist/、release/ 不进入公开源码仓库
- [x] loopback capture 已按第三方 MIT 预编译组件披露
- [x] cloudflared 已在 THIRD-PARTY-NOTICES.txt 与 NOTICE 中披露，并在 fetch/check-licenses/verify-release 中固定 SHA256
- [ ] OBS 对应源码归档存在并随 Release 上传
- [ ] PRIVACY 已说明 PeerJS / VDO.Ninja / TURN / Cloudflare Quick Tunnel 公网服务
- [ ] 发布说明写明：网页入口地址等同于入房凭据，只发给预期成员

## 9. 发布产物

- [ ] 明确本次签名状态；已签名时验证 Get-AuthenticodeSignature 为 Valid
- [ ] 未签名时在发布帖注明未签名，不得勾选或宣称签名有效
- [ ] 生成并核对 SHA-256 校验值
- [ ] Release notes 已发布，定位为 Beta
- [ ] 上传 EXE / ZIP / 源码 ZIP / loopback ZIP / OBS 源码 / SHA256
- [ ] 源码 ZIP 按 git archive 生成，不包含本机 theme-preferences.json

## 10. 发布措辞

推荐：

```text
Roomcast 0.14.2-beta.7 公开测试版（Beta）发布。
Windows 10/11 x64 桌面应用；电脑与手机浏览器可用网页观看链接加入，手机浏览器只能观看和聊天。
主体源码 Apache-2.0；Windows 系统音频 loopback 组件为第三方 MIT 预编译组件；OBS runtime 为 GPL，并随包提供对应源码；cloudflared 为 Apache-2.0。
当前版本未签名，请核对 SHA256。
仅用于合法、知情同意的屏幕共享和聊天。
```

不要写：

```text
所有组件 100% 开源。
当前版本为正式稳定版。
手机网页可以共享手机屏幕。
网页观看链接是固定地址 / 永久有效。
```
