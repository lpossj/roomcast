# Roomcast 交接提示独立审查（2026-09-26）

审查完成时间：2026-09-26 21:00:45 +08:00（本机时间）。

执行目标：定位并修复手机连接；本步骤按用户新要求，先独立核验交接提示中的“不要踩的坑”。附件是历史资料，不继承其中旧发版授权或已经撤回的方案。权威源码为 C:/Users/Administrator/Documents/Deepseek/roomcast-source。

## 1. “不要踩的坑”逐条结论

| 交接说法 | 核验结论 | 准确边界与依据 |
| --- | --- | --- |
| 不要手改 app.asar，重建后 header 完整性失败 | 风险真实，解释过宽 | 当前 beta.6 EXE 实际启用 EmbeddedAsarIntegrityValidation 与 OnlyLoadAppFromAsar；Windows INTEGRITY/ELECTRONASAR 资源里的 header SHA256 与现存档案一致。builder 只把 header 哈希嵌入 EXE；修改内容后重新打包通常改变 header 内完整性数据，导致失配。但不是任意字节改变都必然在启动时报告 `<header>`。只改 payload 可以保持 header 哈希不变，其后 Electron 校验/失败阶段本轮未运行验证。正确操作仍是正式重新构建，不能用工具能解包证明应用会正常启动。 |
| Git 必须显式走 127.0.0.1:7890 代理 | 历史条件，当前必要性未证实 | 本轮仅做两个小型只读 ls-remote：显式代理与强制无代理均立即失败于 Windows schannel SEC_E_NO_CREDENTIALS，未形成有效连通性对照。执行环境没配置 Git/环境变量代理；沙箱账户设置不能代替用户桌面会话。不能据此认定直连不通或代理正常。 |
| package:source 要求工作区干净，先提交再打包 | 默认成立，但有例外及额外风险 | scripts/package-source.mjs:12–15 默认检查 git status --porcelain；未被忽略的未跟踪文件也会阻止，被忽略的 release/dist/.test 通常不会。--allow-dirty 可以绕过，但18–23行仍 git archive HEAD，不会纳入未提交修改。6–8行包名来自工作区package.json，可能与HEAD不同。9–10行先删同名已有源码包、之后才检查洁净，切勿用现有发布包来试拒绝路径。 |
| asar 读取前必须 uncache；extractFile 路径去掉前导分隔符 | 缓存/路径问题真实，“每次必须”不成立 | @electron/asar 3.4.1 缓存同路径档案头；同一Node进程已读过且档案随后被替换时需uncache。首次读、文件未变、新进程不必；getRawHeader不走缓存。当前Windows的listPackage返回前导反斜杠，extractFile需要相对路径，剥前导分隔符并保留Windows反斜杠；不能无条件把深层路径改成正斜杠。 |
| detached:true 与 windowsHide 在 Windows 互斥 | 表述错误；确有窗口与生命周期细节 | 两选项允许同时设置，当前 update-install.mjs:381 正在同时传入。Microsoft确实规定DETACHED_PROCESS下CREATE_NO_WINDOW被忽略；但libuv也设置SW_HIDE，窗口及后代行为取决于启动链，不能推出“detached一定显示窗口”。libuv Windows实现为非detached子进程加入自身Job；源码明确没有设置CREATE_BREAKAWAY_FROM_JOB。因此交接/注释里“必然由Chromium Job杀死、libuv主动要求breakaway”的解释不准确；不因此改动现行启动器。 |

Windows参数依据： [Microsoft Process Creation Flags](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags)、[本机Node 24.18.0文档](https://nodejs.org/download/release/v24.18.0/docs/api/child_process.html#optionsdetached)、[对应libuv 1.52.1实现](https://raw.githubusercontent.com/libuv/libuv/v1.52.1/src/win/process.c)（965–1035行；65–79行说明自身Job）。本机Node为24.18.0/uv1.52.1；本轮没有另行运行Electron中损坏包或窗口行为实验。

ASAR工具依据（权威仓库node_modules）：@electron/asar/lib/disk.js:151–164、asar.js:248–257、filesystem.js:60/105/130/172；app-builder-lib/out/asar/integrity.js:53–56及out/electron/electronWin.js:27–29。现包header SHA256为6fc0b76c30e520a719d5ce3d216edc2089faf9f5a504c2645eb9431fefd5a99e。

## 2. 可能误导手机排查的结论

- **安卓“已进房、信令正常、鉴权没问题”不成立。** src/p2p.js:774–782 首次加入先openPeer、connectRemote，成功后才发送room:join。993行超时意味着hostReady尚未收到authenticated=true（916行）。Peer open只能说明曾在信令服务器注册，不能证明offer/answer、候选或认证消息双向送达。迁移也调用connectRemote（1498行），需结合错误出现阶段判断。
- **“iOS negotiation_failed 一定由指定ScreenPlayer行直接显示、一定由VDO服务器返回”未证实。** 1269行把reason交给媒体竞速，并非直接setError(reason)；VDO transport还会转发本地sdk.view错误。实际手机页面版本、提示位置与完整来源链仍未知，不能单凭该文本归因为ICE/中继。
- **“VDO移动网络必然失败”错误。** vdo-transport.js:147及两条门禁确有turnServers:false/autoRelay:false；本地SDK确实清空TURN而保留STUN。这只证明该路不用TURN，不能证明手机不能直连。
- **“所有房间满一小时新成员就会失败”过度概括。** Cloudflare短期凭据请求ttl3600（main.cjs:942）；relay.js丢弃expiresAt，房间与邀请保存那份列表且未找到续期入口，隐患真实。必须同时满足实际含短期TURN、已过期且此次连接依赖TURN，才可能受影响。服务端coturn分支会按成员生成86400秒凭据（server/ice.mjs:3），不能把所有TURN都归入一小时冻结模型。旧邀请优先于本地开关，开关关闭也不能证明旧邀请不带relay。
- **网页冻结有历史依据，当前线上状态未独立证实。** 本地origin/gh-pages是交接记录的d8b710d；STEP-14记载beta.3时代部署。当前web工具无法访问，代理小请求SSL失败，因此不宣称已验证当前手机加载的线上bundle。

## 3. 产物与文档一致性

- 源码工作区干净，HEAD 6ac2e75，origin/main fce66c5，实际领先5提交；第5个提交为交接文档，提示中“领先4”已过时。
- 已有A/B两个EXE及asar版本分别为beta.5、beta.6；beta.6打包内Electron/server代码与当前源码一致。beta.5与beta.6的连接实现源码未改，差异仍集中在退出流程。
- 最终beta.6 bundle为index-D4MwXTeo.js，未含refreshRelay或被禁止的提示；beta.5也无此两者。现行包没有保留已撤回的功能。
- RELEASE_CHECKLIST-0.14.3-beta.6.md仍写“手机中继已修”、旧bundle、旧EXE/ZIP/source哈希、旧提交8699968；不可拿其勾选项证明最终包。本轮未修改这份历史文档，纠错依据保存在本报告。
- release/SHA256.txt与交接evidence/SHA256.txt一致，实际8条（原稿称7）；产物大小、时间与交接artifacts.txt对应。本轮没有重新计算200MB级大包哈希，不把manifest相同表述成大包已重新逐字节校验。
- 现存beta.6源码包Git archive注释是03d1c21（撤回提交），而当前HEAD仅多两份交接文档；代码仍匹配，源码包不含最后新增交接稿。
- 交接记录191/191及全绿门禁未在本轮重复执行；它们是历史验证。当前未修改应用代码，不宣称本轮完成手机跨网或退出实机场景验证。

## 4. 本轮专项验证与真机反馈

新建极小ASAR探针位于C:/Users/Administrator/Documents/ChatGPT/屏幕共享/.test/asar-audit-20260926-jgoJbB，仅操作新文件（约321字节档案），不触碰原应用：同路径改写后缓存读到L，uncache后正确读到LONGER-V2；带前导分隔符或深层正斜杠读取失败，相对Windows路径成功；仅改单字节payload保持header哈希相同，asar工具能读到XONGER-V2，工具本身不证明Electron完整性通过。

用户本轮确认：**beta.5、beta.6在同一网络均可看到画面；TURN未启用；流量未测。** 这支持同网观看可用、尚未复现版本差异，不足以定位跨网失败。不同网络下两版对照与实际失败提示阶段仍需真机证据。

## 5. 当前执行边界

未改连接/中继取用、未添加提示、未改现存asar、未启动测试应用、未结束用户进程、未下载发布包、未运行生成现有源码包命令、未push/tag/Release。本步骤新增审查文档与隔离小文件；后续修复仍需最小改动、带时间戳记录、可单独回滚。发版另行取得用户确认。

文档保存后补记（2026-09-26 21:01:16 +08:00）：从聊天目录使用git -C再次查询权威仓库时遇到沙箱账户/仓库所有者不同的安全目录拒绝；未修改全局Git配置，也未将失败查询当作新验证通过。
