# beta.6 本地交付记录（异常操作可停止与原生立即退出）

最终记录时间：2026-09-26T22:17:45+08:00。
来源提交：238ed28c26acd160b524391793f0bd203f0ecf71。工作区干净，版本0.14.3-beta.6；本轮未push/tag/Release。

## 本轮修改与回滚

- e7ab4d6：原生首次关闭结束进程，更新仅destroy主窗。
- da37263：Windows WM_CLOSE/SC_CLOSE直接进程退出，避免冻结渲染器阻塞；更新采集收尾不等待。
- 5a469e2：连接与离房等待可停止、异常finally清空、迟到结果隔离。
- 238ed28：最终时间戳/验收/交接说明及测试清理脚本。每处是本地提交，可分别回滚。
- TURN取用、ICE政策、邀请内容与移交协议未变。截图只作界面现状证据，未继承附件中的旧指令。

## 验证

- 全套205/205、许可证、前端构建、网络门禁通过；最终仅缩进修正后定向检查与构建通过，bundle index-D9vc2W6D.js。
- 最终EXE/ZIP严格顺序构建，两者exit0，复用已验证本地运行时，没有下载发布包。首次重叠失败不作交付。
- verify:release实际便携包欢迎页、桌面桥接、许可证与运行时通过。
- 实际打包目录程序不开TEST_MODE：卡住配置请求可取消、取消后可以打开设置、再次连接Escape停止通过。
- 冻结渲染器+beforeunload否决，标题栏/Alt+F4对应SC_CLOSE：75ms、code0，自身7个进程无残留。
- 18个Electron/server文件、8个dist逐字节等于当前源码/构建。app.asar SHA256：10b9ca74fb4d0a6ad6d1dae730880066dab0e8239342c0235488c696b947664e。
- ZIP中app.asar、EXE、三个曾受构建重叠影响的DLL等于目录产物，共2101条目。
- 源码ZIP来自干净HEAD，ZIP注释精确等于上述40位提交；版本、取消源码、回归测试、验证脚本、时间戳文档均存在。
- 8项SHA256已更新，五项运行时/附件哈希与上一轮一致。
- 测试失败清理曾漏杀启动器的子进程，用户指出的4个窗口已核实清理；注入失败回归确认finally清理整棵自身PID树。全过程失败/修正记录没有删除，见docs/EXIT-CANCEL-20260926.md。

## 最终产物

| 文件 | 字节 | SHA256 |
| --- | ---: | --- |
| Roomcast-0.14.3-beta.6-Windows.exe | 149910208 | 0D1DF2315101614C1E1A9696425CDE23A454710D5A45E17BEBC1B754A1409755 |
| Roomcast-0.14.3-beta.6-Windows.zip | 221714103 | F97535FE4E026188271A01FE66A2E46CFB092BAA9A8AA51568581EB9CE472B31 |
| Roomcast-0.14.3-beta.6-source.zip | 946868 | 3052182FEC38E2D597601F055833F3921E28B3409CD64244B6B6174C2BAC9CF8 |

## 时间戳与验证边界

- 每步具体时间/动作/依据/现状/验证/失败：docs/EXIT-CANCEL-20260926.md；最终来源和哈希放本记录，避免源码包自引用。
- 最新日志：.test/exit-cancel-final-check.log、exit-cancel-build-portable-final.log、exit-cancel-build-zip-final.log、exit-cancel-verify-release.log、exit-cancel-packaged.log、exit-cancel-zip-inspection.log、exit-cancel-source-package.log、exit-cancel-checksums.log。
- 用户真实业务场景（异常TURN/网页邀请/移交失败/采集音频）仍由用户自行测试；手机跨网根因未定位，本轮不声称修好手机或链接/移交成功率。
- X按用户要求直接结束当前程序与房间，不等待移交；普通离房仍尝试移交，可主动停止等待。

### 2026-09-26 22:18:31 +08:00 — 最后状态核对

- 工作区干净，来源238ed28c26acd160b524391793f0bd203f0ecf71；源码ZIP精确对应HEAD，8项校验已生成。
- 全部已知exit-cancel隔离测试进程为0，没有残留测试窗口。
- 本地beta.6包已可交付，未push/tag/Release，等待用户自行做真实使用测试。
