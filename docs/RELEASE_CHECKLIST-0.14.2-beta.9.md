# Roomcast 0.14.2-beta.9 Beta Release Checklist

本版新增桌面端更新机制。未在本表列出的项目沿用 `docs/RELEASE_CHECKLIST-0.14.2-beta.8.md` 的结论。

## 1. 源码和版本

- [x] package.json / package-lock.json version = 0.14.2-beta.9
- [x] 新增 docs/RELEASE_NOTES-0.14.2-beta.9.md
- [x] CHANGELOG 增加 0.14.2-beta.9 条目
- [x] PRIVACY / SECURITY 补充更新检查的边界（GitHub 公开接口、无标识、手动兜底、不静默替换）
- [x] 工作区干净，`npm run package:source` 可用

## 2. 构建和测试

- [x] 全量单元测试通过（161/161，含 7 个更新机制用例）
- [x] Vite build 通过
- [x] `npm run check`（licenses / test / build / network）通过

## 3. 更新机制的实测验证

- [x] 版本比较：`0.14.2-beta.9 < 0.14.2`、`beta.2 < beta.10`、`1.0.0-rc.1 > 1.0.0-beta.2`、非法版本抛错
- [x] 发布选择：忽略 draft、忽略非语义化 tag（`runtime-2026.09`）、同一或更旧版本不提示、正式版用户不收到 prerelease
- [x] 对真实仓库实测：当前 `0.14.2-beta.1` → 提示 `0.14.2-beta.2` 并列出 EXE/ZIP 与校验文件；当前 `0.14.2-beta.2` → 不提示；`0.14.1` → 不提示
- [x] 校验值解析兼容 `hash  name` 与 `hash *name` 两种格式
- [x] 下载校验：校验通过才写盘；篡改后的内容必须失败且**不覆盖**已存在文件；发布页无校验值时下载但标注未校验
- [x] 超时映射：检查超时与下载超时都返回明确文案并指向"打开发布页"
- [x] 限流（403/429）与其他 HTTP 错误分别给出可区分的提示
- [ ] 打包后端到端：设置 → 关于 → 检查更新 → 下载（需真实网络，见下）

## 4. 打包

- [ ] release/Roomcast-0.14.2-beta.9-Windows.exe 存在
- [ ] release/Roomcast-0.14.2-beta.9-Windows.zip 存在
- [ ] release/Roomcast-0.14.2-beta.9-source.zip 存在（提交后生成）
- [ ] release/Roomcast-0.14.2-beta.9-loopback-capture.zip 存在（提交后生成）
- [ ] release/SHA256.txt 存在（提交后生成）
- [ ] check-packaged-obs-step5d.cjs 通过
- [ ] check-portable-lifetime.cjs 通过
- [ ] verify:release 通过

## 5. 需要实机/真实网络复核

- [ ] 干净机器上：启动后 4 秒发起检查，设置按钮出现提示点；"设置 → 关于"能看到"软件更新"
- [ ] 关闭"启动时自动检查更新"后重启，确认不再发起请求
- [ ] 使用代理或断网环境：确认出现"检查超时…可以用打开发布页"的提示，"打开发布页（手动下载）"能在系统浏览器打开 release 页面
- [ ] 下载过程中断网：确认提示明确、文件未落盘、按钮可重试
- [ ] 正常网络下载完整安装包：确认保存到下载目录、提示"SHA256 校验通过"、"打开文件位置"可用
- [ ] 手动替换便携版 EXE 后版本号更新

## 6. 发布流程提醒

- [ ] 正式版发布时**不得**使用 `--prerelease`，否则正式版用户永远收不到该版本
- [ ] tag 保持 `v<semver>`，产物名保持 `Roomcast-<version>-Windows.exe|zip`，`SHA256.txt` 必须作为 Release 资产上传（更新校验依赖它）

## 7. 发布措辞

```text
Roomcast 0.14.2-beta.9 公开测试版（Beta）发布。
新增更新检查：设置 → 关于 可检查新版本并下载安装包（下载后会校验 SHA256）。
本版不会自动替换正在运行的程序；下载超时可改用"打开发布页"手动下载。
Windows 10/11 x64；手机浏览器可用网页观看链接加入，只能观看和聊天。
当前版本未签名，请核对 SHA256。
仅用于合法、知情同意的屏幕共享和聊天。
```
