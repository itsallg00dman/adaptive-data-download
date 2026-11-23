# Adaptive Data Download

[简体中文说明](README.md)

Benchmark, download, resume and verify public datasets from S3 and HTTP(S). The tool uses representative samples on the destination disk to select an engine and concurrency. It saves the manifest, selection, partial downloads and SHA-256 records with the task.

Install [Node.js 22 or newer](https://nodejs.org/en/download). Clone the repository with Git, or [download the ZIP](https://github.com/itsallg00dman/adaptive-data-download/archive/refs/heads/main.zip), extract it and run the `node` command in the extracted folder.

```sh
git clone https://github.com/itsallg00dman/adaptive-data-download.git
cd adaptive-data-download
node bin/download.mjs run --source "https://raw.githubusercontent.com/itsallg00dman/adaptive-data-download/main/LICENSE" --out "./demo-download"
```

Replace the URL and output directory with your own. Use a separate directory for each task. Public S3 listings require [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html). Install [aria2](https://github.com/aria2/aria2/releases) for segmented downloads, or use the built-in HTTP engine. `node bin/download.mjs doctor` reports the tools on PATH.

For an S3 prefix, measure first and review the reported total. The following example can download a large dataset when you run the second command.

```sh
node bin/download.mjs bench --source "s3://openneuro.org/ds002345/" --scope raw --out "./Narratives"
node bin/download.mjs run --out "./Narratives"
node bin/download.mjs verify --out "./Narratives"
```

`Ctrl+C` stops a command. Repeat `run --out …` to continue and keep the `.adaptive-download` directory. HTTP range resume requires a compatible server and an ETag or source checksum. AWS may restart an unfinished object. If the machine crashed and the task is still locked, confirm no process is using the directory before adding `--recover-lock`.

The benchmark compares complete samples using AWS CLI, aria2 and built-in HTTP when applicable. Defaults are 4, 8 and 16 concurrency candidates, 32 MiB per trial and 15 seconds per trial. It favors lower concurrency within 5% of the fastest completed trial. When suitable full samples exceed the budget, it uses defaults. Increase `--bench-mib` and `--bench-seconds` to measure these files. `--retest` updates a saved strategy and `--skip-benchmark` starts with defaults.

The HTTP engine accepts a single URL that provides a length via HEAD, or a JSON manifest supplied with `run --manifest files.json --out …`. Each entry contains `url`, `path` and `size` in bytes, with optional `sha256` or strong `etag`. Checksums published by the source verify against the source. A locally generated SHA-256 can detect changes during subsequent verification.

Run `npm test` for local integration checks. See the [case study](docs/case-study.md) for the original neuroimaging workflow and the [Chinese guide](README.md) for more options.
