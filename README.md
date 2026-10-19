# DSH 插件迁移包：Trade Practice + PDF Reader

两个 DeepSeek Harness（DSH）插件的完整源码，以及 Trade Practice 的 1 分钟 K 线历史数据（放在 Release 附件里）。换一台电脑克隆下来、跑一次 `setup.ps1`、重启 DSH 就能用。

仓库：<https://github.com/JoeNi239/dsh-plugins-public>

## 仓库内容

```text
trade-practice-plugin/     # 交易练习插件（宿主 + 界面 + 数据抓取脚本 + 测试）
pdf-reader-plugin/         # PDF 阅读插件（宿主 + 界面 + Python 解析进程）
setup.ps1                  # 新电脑一键注册插件 + 下载行情数据 + 安装 PyMuPDF
README.md
```

- 行情数据在 Release [`data-v1`](https://github.com/JoeNi239/dsh-plugins-public/releases/tag/data-v1)：`trade-practice-data.zip`（约 52 MB 压缩，解压约 285 MB，含 XAUUSD/GBPUSD 的 1m CSV，MT5 服务器时间）。
- 不包含：插件会话索引（`agents.json`）、运行状态、日志、PDF 对话与标注、任何账号凭证。

## 快速开始（新电脑）

前置：Windows、已安装并运行过 DSH（至少有一个 profile）、Python 3。

```powershell
# 1. 克隆
git clone https://github.com/JoeNi239/dsh-plugins-public.git "$env:USERPROFILE\Documents\deepseek-harness\default-workspace"

# 2. 一键注册：写 profile、pnpm install、下载行情数据、安装 PyMuPDF
cd "$env:USERPROFILE\Documents\deepseek-harness\default-workspace"
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

然后重启 DSH：左侧栏底部出现「PDF 阅读」，主面板打开 Trade Practice 即有历史 K 线。

> 如果 `default-workspace` 已存在且非空，`git clone` 会失败。可以先克隆到别处再复制内容；`setup.ps1` 按自身所在目录定位插件，不要求必须是工作区根目录。

### setup.ps1 参数

| 参数 | 作用 |
|---|---|
| `-SkipData` | 不下载 Release 里的行情数据（之后可在面板点「更新数据」重新拉） |
| `-SkipPip` | 不安装 PyMuPDF |
| `-SkipInstall` | 不执行 `pnpm install` |
| `-ProfilesRoot <路径>` | 指定 DSH profile 目录（默认 `%USERPROFILE%\.dsh\profiles`） |
| `-DryRun` | 只打印将要做的改动，不写文件 |

## 手动注册（不用 setup.ps1）

编辑 DSH 使用中的 profile（通常是 `%USERPROFILE%\.dsh\profiles\desktop\package.json`），合并：

```json
{
  "dependencies": {
    "@local/trade-practice": "link:C:/Users/<你>/Documents/deepseek-harness/default-workspace/trade-practice-plugin",
    "@local/pdf-reader": "link:C:/Users/<你>/Documents/deepseek-harness/default-workspace/pdf-reader-plugin"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@local/trade-practice",
        "@local/pdf-reader"
      ]
    }
  }
}
```

在 profile 目录执行 `pnpm install`（DSH 自带 pnpm 在 `%USERPROFILE%\.dsh\dsh-runtimes\...\dependencies\pnpm`），再重启 DSH。

行情数据手动下载：

```powershell
curl.exe -L -o data.zip "https://github.com/JoeNi239/dsh-plugins-public/releases/download/data-v1/trade-practice-data.zip"
Expand-Archive data.zip -DestinationPath .trade-practice\data -Force
```

## 数据说明

- 路径：`.trade-practice/data/<品种>/1m/YYYY-MM.csv`，`openTime` 为 **MT5 服务器时间**（GMT+2/GMT+3），直接复制即可。
- 带数据 = 打开 Trade Practice 立刻有图；没有数据也能启动，在面板点「更新数据」或运行 `trade-practice-plugin/scripts/fetch_m1.py` 拉取。
- 插件按当前工作区解析数据目录，所以数据放在工作区 `.trade-practice/data` 下即可。

## 检查安装

- Trade Practice：`GET /trade-practice/health` 返回 `ok: true`，品种里能看到 XAUUSD/GBPUSD 且有历史 K 线。
- PDF Reader：`GET /pdf-reader/health` 返回 `ok: true`，能打开工作区里的 PDF 并选中文字。

## 后续更新

```powershell
git pull
```

插件代码变更后重启 DSH 生效；只改客户端 `client.js` 时 DSH 会自动重载模块。
