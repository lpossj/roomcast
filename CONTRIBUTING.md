# Contributing

## 开发前

请先阅读：

- `README.md`
- `SECURITY.md`
- `PRIVACY.md`
- `ACCEPTABLE_USE.md`
- `CODE_OF_CONDUCT.md`

## 环境

```powershell
npm ci
npm run fetch:runtime   # 如果本地还没有 loopback 组件
npm run build
```

自动化测试和验收门禁已按维护者要求移除。修改说明应写清影响范围及未验收项；功能与发布验收由维护者手工完成。

## 提交要求

- 保持最小修改范围，不要顺手重构无关模块；
- 不提交 secrets、`.env`、`node_modules`、`runtime/` 大二进制、`dist/` 或 `release/`；
- 不提交旧 `.git`、backup、PartyLink 解包或私人物料；
- 网络/安全相关修改必须说明影响范围和人工验收情况；
- 安全漏洞不要提交公开 issue，按 `SECURITY.md` 私下报告；
- 除非有明确授权，不要修改 `runtime/loopback-capture` 或 `runtime/obs-bundle` 的行为。

## 许可证

提交到本仓库的 Roomcast 自身代码按 Apache-2.0 授权。第三方组件仍按各自许可证处理，详见 `THIRD-PARTY-NOTICES.txt`。
