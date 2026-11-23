# 公共数据下载助手 · Adaptive Data Download

[English quick start](README.en.md)

给一个公开数据源和保存目录，工具会短测可用的下载方式，保存选中的配置，下载并逐文件校验。中断后用同一个目录继续。支持 Windows、macOS 和 Linux，适合公开科研数据、S3 目录和直链文件。

## 快速开始

安装 [Node.js 22 或更新版本](https://nodejs.org/en/download)和 [Git](https://git-scm.com/install)，然后在终端执行：

```sh
git clone https://github.com/itsallg00dman/adaptive-data-download.git
cd adaptive-data-download
node bin/download.mjs doctor
node bin/download.mjs run --source "https://raw.githubusercontent.com/itsallg00dman/adaptive-data-download/main/LICENSE" --out "./demo-download"
```

把 `--source` 换成你的下载直链，把 `--out` 换成空的目标文件夹。Windows 移动硬盘可以写成 `--out "E:/研究数据/数据集名"`。每个数据集使用自己的目标目录。

下载公开 S3 目录前，安装 [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)。希望参加大文件分段测速时，再安装 [aria2](https://github.com/aria2/aria2/releases) 并把 `aria2c` 加到 PATH。重新打开终端，运行 `doctor` 确认工具可用。HTTP 下载只需 Node.js。

```sh
# 先对公开 S3 数据生成清单并进行短测
node bin/download.mjs bench --source "s3://openneuro.org/ds002345/" --scope raw --out "./Narratives"
```

`bench` 只生成清单、下载测试样本并保存策略。核对容量后，运行下面的 `run --out …` 开始下载。第一次直接用 `run --source … --out …` 会自动完成测速，然后继续正式下载。长时间下载时保持终端打开，也可以先用 `Ctrl+C` 暂停，等待命令退出再关机。

```sh
node bin/download.mjs run --out "./Narratives"       # 开始或继续
node bin/download.mjs verify --out "./Narratives"    # 重新读取并验证已下载文件
```

保留目标目录中的 `.adaptive-download`，其中的 `manifest.json` 保存源清单，`strategy.json` 保存测速结果，`completed.jsonl` 保存校验记录，`parts` 保存临时文件和 aria2 分段记录。AWS 未完成的单个文件可能重新传输。异常关机留下锁时，先确认没有下载进程使用该目录，再运行 `run --out "./Narratives" --recover-lock`。移动盘重新连接后要确认盘符或挂载点。

## 下载策略

1. **保存清单。** 公开 S3 按前缀列举对象，可用 `--scope raw` 去掉衍生目录和仓库管理文件，或用 `--scope slim` 只选 SWU SLIM 的原始压缩包和根目录 TSV。清单记录路径、长度、ETag 和修改时间，可追溯列举时的对象状态。严格的发布版本复现应使用发布方提供的固定快照和校验值。
2. **分组短测。** 将文件分为小文件和 16 MiB 以上的大文件。在目标盘的临时目录，用同一批完整样本比较可用的工具及 4、8、16 三档候选并发。AWS 调整并发请求数，aria2 分别调整同时下载的文件数和每个文件的分段数，内置 HTTP 可并发下载多个文件。
3. **按有效速度选择。** 每轮只计算完整且通过校验的样本，计时包含请求、重试、写盘和校验。接近最快结果的方案优先选择较低并发。默认每轮最多 32 MiB、15 秒，样本不足或全部失败时采用默认配置。超过样本预算的大包可以增大 `--bench-mib` 和 `--bench-seconds` 后重新测速。
4. **下载、校验和恢复。** 下载写入目标盘的临时目录，完成后核对长度、可用的源端校验值并记录 SHA-256，然后移入最终目录。重复失败时减少并发并重试。只有本地 SHA-256 时，它用于后续复验；AWS 批量传输无法用 ETag 固定每个请求的对象版本。`--etag-md5` 只用于已经确认普通 ETag 就是 MD5 的 S3 数据源。使用 `verify` 可复查同样大小但内容变化的文件。

换网络、硬盘或数据规模后，可用 `run --out "./Narratives" --retest` 为未完成文件重新测速。只想直接开始时，在首轮命令加 `--skip-benchmark`。自定并发可用 `--concurrency 2,4,8`。默认测速适合快速选型，速度会随线路、源站和写盘情况变化。

## 多个网页直链

对于发布方提供的多个 URL，可创建 `files.json`。`path` 是目标目录内的相对路径，`size` 是字节数，可选填发布方给出的 `sha256` 或强 `etag`。以下仅示意格式，替换全部示例值后再运行。

```json
[
  { "url": "https://example.org/files/sample.bin", "path": "data/sample.bin", "size": 123456 }
]
```

```sh
node bin/download.mjs run --manifest files.json --out "./MyDataset"
```

单个直链需要源站在 HEAD 响应中提供文件大小。服务器不支持 HEAD 时可用清单给定大小。HTTP 字节续传要求源站支持 Range，并提供可用的强 ETag 或源端校验值。当前覆盖公开 S3 与 HTTP(S) 文件，使用者应从发布方获取链接并遵守数据许可和引用要求。

本次真实下载的技术路线、实测范围与经验见 [项目案例](docs/case-study.md)。开发者可运行 `npm test` 检查 HTTP 测速、续传、现有文件保护及完整性复验。
