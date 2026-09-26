# STEP-03 下载与校验改造记录

> 时间：创建于 2026-09-26 15:11（取自文件系统）；本步的完整时间线见 [TIMELINE-全程时间戳记录.md](TIMELINE-全程时间戳记录.md)。

- 前置：STEP-02 设计。
- 本步只改 `electron/update-check.mjs` 与它的单测，不动主进程与界面。

## 1. 目标

1. 下载要能报进度（供第 3 步的进度 UI 使用）。
2. 下载期间不能污染目标文件：校验失败必须保持原文件不变。
3. 明确"自动安装该用哪个资产"（便携 EXE 还是 ZIP）。

## 2. 改动

### 2.1 流式下载 + 进度回调

`download(asset, destination, checksumUrl = '', onProgress)`（第 4 个参数是新增的可选参数，
旧调用方式与返回值完全不变）：

- 边读边算 SHA256，写入 `<destination>.part`，**校验通过后才 `rename` 成正式文件**。
- 有 `response.body.getReader` 时走流式；没有时回退到原来的 `arrayBuffer()` 路径，
  保证测试替身与老环境仍可用。
- 进度回调 `onProgress({ phase, received, total })`，`phase` 取值：
  `connecting` → `downloading` → `verifying`。
  回调按 200ms 节流（`PROGRESS_INTERVAL_MS`），避免给 IPC 和进度条刷屏；
  最后一次 `downloading` 与 `verifying` 强制上报，保证 UI 一定收到 100%。
- 失败路径：读流出错/写盘出错/校验不一致 → 删除 `.part`，正式文件保持原样。
  写盘错误仍然是 `code: 'write'`，网络错误仍是 `code: 'timeout' | 'network'`，
  校验错误仍是 `code: 'checksum'`（错误码语义不变，界面文案不变）。

### 2.2 资产选择

新增 `selectInstallAsset(assets, kind)`：

- `kind === 'portable-exe'` → 取 `.exe`；
- 其它（目录版）→ 取 `.zip`；
- 找不到返回 `null`。

这样"用哪个文件"由主进程按安装目标决定，渲染层不再自己挑文件。

## 3. 单测（`tests/update-check.test.mjs`）

新增 3 个用例，原有 7 个用例未改动：

| 用例 | 验证内容 |
| --- | --- |
| `install asset selection follows the install target, not the asset order` | exe/zip 选择与缺失返回 null |
| `streaming download reports progress and only lands the verified file` | 流式下载 3 块数据：字节数、SHA256、落盘内容一致；进度首条为 `connecting`、末条为 `verifying`、`downloading` 最终值等于总长度；成功后**没有** `.part` 残留 |
| `a tampered streamed payload removes the partial file and keeps the destination` | 校验不一致时抛错、目标文件仍是旧内容、`.part` 被删除 |

## 4. 验证结果

```
node C:\...\roomcast-source\tests\update-check.test.mjs
✔ 10 个用例全部通过（7 个原有 + 3 个新增），fail 0
```

## 5. 审查结论

- 旧的 `download()` 调用方（`main.cjs` 的手动下载）无需修改即可继续工作。
- 新增行为都是"更严格"：写盘从直接覆盖改为先临时文件后重命名，失败时对现有文件零影响。
- 未验证项：真实 GitHub 大文件下载的流式行为（本机无法访问发布页），
  但已用等价的 `ReadableStream` 替身覆盖了分块读取路径。
