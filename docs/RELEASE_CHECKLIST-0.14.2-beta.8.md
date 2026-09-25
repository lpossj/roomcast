# Roomcast 0.14.2-beta.8 Beta Release Checklist

本版是 `0.14.2-beta.7` 的缺陷修复版，只改三处手机网页端缺陷 + 设置界面。未在本表重复列出的项目沿用 `docs/RELEASE_CHECKLIST-0.14.2-beta.7.md` 的结论，但**本版改动过的路径必须重新验证**。

## 1. 源码和版本

- [x] package.json version = 0.14.2-beta.8
- [x] package-lock.json version = 0.14.2-beta.8（与 package.json 一致）
- [x] 新增 docs/RELEASE_NOTES-0.14.2-beta.8.md
- [x] CHANGELOG 增加 0.14.2-beta.8 条目
- [x] 工作区干净，`npm run package:source` 可用
- [ ] README 及其它 docs 的版本号引用全部更新（历史发布说明与检查表保持不变）

## 2. 构建和测试

- [x] 全量单元测试通过（154/154）
- [x] 干净检出（无 dist/）下的测试步骤通过
- [x] Vite build 通过
- [x] check:network / check:licenses / check:licenses --release 通过

## 3. 本版改动的实测验证（真实浏览器）

- [x] 访客加入后冻结其 JavaScript（模拟被挂起的手机页面）：房主 1.03 秒退出成功，提示"其他成员当前无法接管房间，房间已关闭"；修复前抛错并卡住
- [x] 房主退出时若仍有成员应答但交接失败，仍保留"可重试退出"提示（未做回归破坏）
- [x] 网页端页面隐藏 30 秒后自动退出房间，提示"页面在后台停留过久，已退出房间"
- [x] 4000×3000 照片暂存后为 2000×1500；待发送缩略图元素 52×52；页面横向/纵向均无可滚动溢出
- [x] GIF 仍按原文件发送（不被重新编码）
- [x] 不提供 `getDisplayMedia` 的手机浏览器：共享按钮不存在；设置分类为 通用 / 网络 / 关于
- [x] 桌面应用仍渲染共享按钮、音频与采集、本地服务分类（桌面路径未被裁剪）
- [x] "关于"面板显示版本号、作者、反馈与仓库链接、使用声明与许可说明

## 4. 打包

- [x] release/Roomcast-0.14.2-beta.8-Windows.exe 存在
- [x] release/Roomcast-0.14.2-beta.8-Windows.zip 存在
- [ ] release/Roomcast-0.14.2-beta.8-source.zip 存在（提交后生成）
- [ ] release/Roomcast-0.14.2-beta.8-loopback-capture.zip 存在（提交后生成）
- [ ] release/SHA256.txt 存在（提交后生成）
- [x] check-packaged-obs-step5d.cjs 通过（Step5D PASS，含便携版运行时 preflight）
- [x] check-portable-lifetime.cjs 通过
- [x] verify:release 通过（asar 版本 0.14.2-beta.8，含 `runtime/web-invite/cloudflared.exe` SHA256）

> `package:source` 要求工作区干净，因此源码包、资产包与 `SHA256.txt` 在发布提交之后生成。

## 5. 需要实机复核（本机无法证明）

- [ ] 桌面宽屏下不出现手机成员栏按钮与关闭按钮
- [ ] "分享房间"能拿到可用的 `https://*.trycloudflare.com` 网页观看链接
- [ ] 手机浏览器（iOS Safari / Android Chrome / 微信内置浏览器）：加入、观看、聊天
- [ ] 手机真实切后台 30 秒以上：房主端能立刻看到该成员离开，房主可正常退出
- [ ] 手机发送真实相机照片（多张、大图）后 UI 不出现黑屏或掉帧
- [ ] 手机返回前台后能重新加入并恢复画面
- [ ] 退出应用后 cloudflared 无残留进程

## 6. 发布产物

- [ ] 明确签名状态；未签名时在发布帖注明
- [ ] 生成并核对 SHA-256
- [ ] 上传 EXE / ZIP / 源码 ZIP / loopback ZIP / OBS 源码 / SHA256

## 7. 发布措辞

推荐：

```text
Roomcast 0.14.2-beta.8 公开测试版（Beta）发布。
修复手机网页切后台会把电脑房主锁在房间里、以及手机发送大图后 UI 黑屏两个问题。
Windows 10/11 x64 桌面应用；电脑与手机浏览器可用网页观看链接加入，手机浏览器只能观看和聊天。
当前版本未签名，请核对 SHA256。
仅用于合法、知情同意的屏幕共享和聊天。
```

不要写：

```text
手机网页可以共享手机屏幕。
当前版本为正式稳定版。
```
