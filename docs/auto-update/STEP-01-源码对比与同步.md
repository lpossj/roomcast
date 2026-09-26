# STEP-01 源码对比与同步记录

> 时间：创建于 2026-09-26 15:09（取自文件系统）；本步的完整时间线见 [TIMELINE-全程时间戳记录.md](TIMELINE-全程时间戳记录.md)。

- 日期：2026-02（本次会话）
- 目标：把「最新源码」与本机源码逐文件对比，把差异同步到本机源码，达到内容一致。
- 本步只做同步，不改任何功能代码。

## 1. 对比对象

| 角色 | 路径 | package.json version |
| --- | --- | --- |
| 最新源码（A） | `C:\Users\Administrator\Documents\ChatGPT\屏幕共享` | `0.14.3-beta.2` |
| 本机源码（B） | `C:\Users\Administrator\Documents\Deepseek\roomcast-source` | `0.14.3-beta.2` |

比较方法：递归枚举两侧全部文件，排除 `node_modules`、`.git`、`dist`、`release`、
`test-results`、`backup-*`、`.test`、`runtime`，对每个相对路径计算 SHA256 后比较。
版本号相同，因此不能只看 `package.json`，必须按文件内容比对。

## 2. 对比结果（同步前）

- A 侧纳入对比文件：201 个。
- B 侧纳入对比文件：241 个（多出的 40 个全部位于 `backup-release-0.14.0-backup-20260920-092635\`
  与运行日志，不是源码）。
- 只在 A 侧存在的文件：0 个（即最新源码没有新增文件）。
- 两侧都存在且内容不同的文件：3 个，全部是文档：

| 文件 | A 侧 | B 侧 |
| --- | --- | --- |
| `docs/RELEASE_CHECKLIST-0.14.3-beta.2.md` | 1370 字节 | 1144 字节 |
| `docs/RELEASE_NOTES-0.14.3-beta.2.md` | 1727 字节 | 1347 字节 |
| `docs/WEB_ENTRY_REVIEW-0.14.3-beta.2.md` | 3511 字节 | 3152 字节 |

差异内容都是对同一版本的**记录性补充**，不涉及任何可执行代码：

1. `RELEASE_CHECKLIST` 第 11 行：B 侧写「未推送源码主分支或创建 Windows 发行版」，
   A 侧更正为「源码主分支已推送；在迁移后的"屏幕共享"目录重新打包的 Windows EXE 启动、
   版本及资源校验通过，ZIP 全部 2010 个文件与 win-unpacked 的 SHA256 一致」。
2. `RELEASE_NOTES` 增加「网页代码信任边界 / 邀请片段残留 / 本版未包含后续加固」的
   诚实边界说明段落。
3. `WEB_ENTRY_REVIEW` 相应补充「会话存储不可用时地址栏不清理」和「gh-pages 分支尚未设置保护」
   两条尚未保证项。

即：**代码层面本机源码已与最新源码完全一致**，需要同步的只有这 3 个文档。

## 3. 本步改动

从 A 侧覆盖复制 3 个文档到 B 侧（`Copy-Item -Force`）：

- `docs/RELEASE_CHECKLIST-0.14.3-beta.2.md`
- `docs/RELEASE_NOTES-0.14.3-beta.2.md`
- `docs/WEB_ENTRY_REVIEW-0.14.3-beta.2.md`

未改动 `package.json`、`electron/`、`src/`、`server/`、`tests/` 中的任何文件。

## 4. 同步后复核

复用同一脚本再次比对（新增排除本次新建的 `docs\auto-update\`）：

- 两侧内容不同的文件：**0 个**。
- 只在 B 侧存在的源码文件：0 个；仅剩 38 个历史备份/日志文件
  （`backup-release-0.14.0-backup-20260920-092635\*`、`run-failed.log`、`theme-preferences.json`），
  这些是上一次发布的本地备份与运行产物，不属于源码，保持原样未删除。

## 5. 审查结论

- 结论：源码同步完成，代码零差异，仅文档更新，功能行为不受影响。
- 风险：无（纯 Markdown 覆盖）。
- 遗留：本机源码 git 工作区现在有 3 个文档改动待提交；本次任务未要求提交，暂不执行 `git commit`。

## 6. 复核用命令（可重复执行）

```powershell
$a='C:\Users\Administrator\Documents\ChatGPT\屏幕共享'; $b='C:\Users\Administrator\Documents\Deepseek\roomcast-source'
$ex='\\(node_modules|\.git|dist|release|test-results|backup-|\.test|runtime|docs\\auto-update)\\'
function Snap($root){ Get-ChildItem -LiteralPath $root -Recurse -File -Force |
  Where-Object { $_.FullName -notmatch $ex } |
  ForEach-Object { [pscustomobject]@{ Rel=$_.FullName.Substring($root.Length+1); Hash=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash } } }
$sa=Snap $a; $sb=Snap $b; $ha=@{}; $sa|%{$ha[$_.Rel]=$_.Hash}; $hb=@{}; $sb|%{$hb[$_.Rel]=$_.Hash}
($ha.Keys | Where-Object { $hb.ContainsKey($_) -and $hb[$_] -ne $ha[$_] }).Count   # 期望 0
```
