# Roomcast 0.14.2-beta.6 Beta Release Checklist

本版是 0.14.2-beta.5 的缺陷修复与文档补齐版，主要修掉"桌面端出现手机控件"和"网页共享按钮不符合浏览器实际能力"两处问题。已勾选项表示本轮已实际执行并通过；未勾选项表示尚未执行或未完成，不得当作已通过。

## 1. 源码和版本

- [x] package.json version = 0.14.2-beta.6
- [x] package-lock.json version = 0.14.2-beta.6（与 package.json 一致）
- [x] 新增 docs/RELEASE_NOTES-0.14.2-beta.6.md
- [x] CHANGELOG 补齐 0.14.2-beta.3 / beta.4 / beta.5 / beta.6 条目
- [x] docs/STATUS.md 已更新（移除"当前没有浏览器免安装观看入口"，新增网页入口的已验收项与未验证项）
- [x] 使用说明 / 使用教程 / EXE使用与异地开房 / RELEASE_NOTES-TEMPLATE 中指向 beta.2 与"观看者必须安装 Roomcast"的表述已更新
- [x] PRIVACY / SECURITY / NOTICE 已补充 cloudflared 与 Quick Tunnel 网页入口的披露
- [x] beta.3–beta.6 的全部改动已提交，工作区干净（`npm run package:source` 的前提）
- [ ] README / 其它 docs 的版本号引用全部更新
  - 说明：`docs/AZURE-TRUSTED-SIGNING.md`、`docs/FREE-CODE-SIGNING.md`、`docs/LOOPBACK-CAPTURE-COMPLIANCE.md` 仍含 beta.1 示例；`docs/RELEASE_NOTES-0.14.2-beta.1`–`beta.3` 与 `docs/RELEASE_CHECKLIST-0.14.2-beta.1`–`beta.2` 是历史记录，应保持不变。

## 2. 构建和测试

```powershell
npm ci
npm run fetch:runtime
npm run setup
npm run check
```

- [x] 全量单元测试通过（150/150）
- [x] Vite build 通过
- [x] check:network 通过
- [x] check:licenses 通过
- [x] **干净检出（无 dist/）下测试步骤通过**：本版修掉了 `tests/web-invite.test.mjs` 对 `dist/` 的依赖；`check` 顺序是"先测试、后构建"，此前干净检出必然失败
- [x] 新增 `tests/browser-room-runtime.test.mjs`：覆盖 vite `browser-room-crypto` 转换必须命中、浏览器房间服务走通共用 room 规则、浏览器加密垫片与 Node `crypto` 逐字节一致（含 scrypt 密码房）
- [x] 真实 Chrome 验证两处修复：桌面宽度下手机成员栏按钮与关闭按钮 `display: none`（Electron 端根本不渲染）；手机宽度下正常显示；去掉 `getDisplayMedia` 后共享按钮为"仅支持观看"且禁用
- [x] 无 Electron 桥（`window.roomcast === undefined`）时页面可正常启动、无 pageerror

## 3. 打包

```powershell
npm run prepare:release
npm run release:build
npm run package:source
npm run package:runtime
node scripts/generate-checksums.mjs --strict
npm run verify:release
```

- [ ] release/Roomcast-0.14.2-beta.6-Windows.exe 存在
- [ ] release/Roomcast-0.14.2-beta.6-Windows.zip 存在
- [ ] release/Roomcast-0.14.2-beta.6-source.zip 存在
- [ ] release/Roomcast-0.14.2-beta.6-loopback-capture.zip 存在
- [ ] release/SHA256.txt 存在
- [ ] check-packaged-obs-step5d.cjs 通过
- [ ] verify:release 通过（本版已把 `runtime/web-invite/cloudflared.exe` 加入哈希校验清单）
- [ ] 源码 ZIP 内容与 package.json 版本一致，且包含 `src/browser-room-service.js`、`src/browser-node-crypto.js`、`electron/web-invite.cjs`、`scripts/fetch-web-invite.mjs`

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
- [ ] resources/runtime/web-invite/cloudflared.exe 存在且 SHA256 = 214f5d74f66941d147d054f6cc9d821c60ff6a9b2d5355f6c854c6bee217c548
- [ ] 没有 MediaMTX 残留，媒体路径不引用 trycloudflare / cloudflared
- [ ] 包内 `electron/obs-fixed-fps.cjs` 已包含 `removeOwnedInput`（确认包里就是最终源码）

## 5. 干净 Windows 机器验收

beta.2 已完成一轮干净环境验收；本版改了浏览器/网页入口、UI 显示范围和邀请链接字段，因此**不能直接沿用 beta.2 的结论**。

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
- [ ] 离开房间后临时网页入口关闭，地址失效；退出应用后 cloudflared 无残留进程
- [ ] 配置 `PEER_SERVER_URL` 时，非房主成员重新分享的邀请仍带 `signal`

## 6. 手机与弱网专项（本版新增，需实机）

- [ ] iOS Safari：加入、观看、聊天；切后台再回前台能恢复画面
- [ ] Android Chrome：同上
- [ ] 微信内置浏览器：同上（若不可用，记录实际表现）
- [ ] 锁屏 / 长时间切后台后，房主端成员状态能正确更新
- [ ] 网页房主保持页面运行 30 分钟以上不异常断开

## 7. 安全与合规

- [ ] 无 .env、TURN Worker access key、长期密钥进入仓库
- [ ] 无旧 .git、backup、PartyLink、临时补丁进入公开源码包
- [x] runtime/、node_modules/、dist/、release/ 不进入公开源码仓库（.gitignore 已覆盖）
- [x] loopback capture 已按第三方 MIT 预编译组件披露
- [x] cloudflared 已在 THIRD-PARTY-NOTICES.txt、NOTICE 中披露，并在 fetch/check-licenses 中固定 SHA256
- [ ] OBS 对应源码归档存在并随 Release 上传
- [ ] License / NOTICE / PRIVACY / SECURITY / TRADEMARKS 齐全
- [ ] PRIVACY 已说明 PeerJS / VDO.Ninja / TURN / Cloudflare Quick Tunnel 公网服务
- [ ] 发布说明写明：网页入口地址等同于入房凭据，只发给预期成员

> 说明：`.env` / 密钥 / backup 等条目需要在正常环境下用 `git ls-files` 与 `npm run check` 复核后再勾选。

## 8. 发布产物

- [ ] 明确本次签名状态；已签名时验证 Get-AuthenticodeSignature 为 Valid
- [ ] 未签名时在发布帖注明未签名，不得勾选或宣称签名有效
- [ ] 生成并核对 SHA-256 校验值
- [ ] Release notes 已发布，定位为 Beta
- [ ] 上传 EXE / ZIP / 源码 ZIP / loopback ZIP / OBS 源码 / SHA256
- [ ] SECURITY.md 及发布帖填写实际私密联系渠道
- [ ] 源码 ZIP 按 git archive 生成，不包含本机 theme-preferences.json

## 9. 发布措辞

推荐：

```text
Roomcast 0.14.2-beta.6 公开测试版（Beta）发布。
Windows 10/11 x64 桌面应用；电脑与手机浏览器可用网页链接观看，手机浏览器只能观看和聊天。
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
