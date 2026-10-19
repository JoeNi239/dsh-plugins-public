# 发给另一台电脑的配置说明

此压缩包包含 Trade Practice 插件源码，以及 `.trade-practice/data` 下当前已有的 XAUUSD、GBPUSD 历史 CSV。把压缩包解压到 DeepSeekHarness 的工作区根目录，目录结构应为：

```text
<工作区>/
  trade-practice-plugin/
  .trade-practice/data/
```

## 让 DeepSeekHarness 加载插件

在 DeepSeekHarness 使用中的 Profile `package.json` 里：

1. 在 `dependencies` 中添加本地链接 `@local/trade-practice`，链接目标指向 `<工作区>/trade-practice-plugin`。如果该 `package.json` 不在工作区根目录，按它所在目录计算相对路径。
2. 在 `dsh.profile.bundles` 中添加 `@local/trade-practice`，保留原有的 bundle 项。
3. 保存配置并重启 DeepSeekHarness。插件自己的 `cordis.patch.yml` 会注册面板和 API 路由。

配置形状示例（路径按这台电脑的实际目录调整）：

```json
{
  "dependencies": {
    "@local/trade-practice": "link:./trade-practice-plugin"
  },
  "dsh": {
    "profile": {
      "bundles": ["@local/trade-practice"]
    }
  }
}
```

如果 Profile 已有 `dependencies` 或 `dsh.profile.bundles`，只合并这两个条目，不要覆盖现有配置。插件运行不需要安装 `node_modules`。面板的「更新数据」功能需要 Windows 上可运行的 Python 3。

## 检查安装

- 在 Harness 插件面板中打开 Trade Practice。
- `GET /trade-practice/health` 应返回 `ok: true`。
- 品种列表应能读到已附带的 CSV；高周期由 1 分钟数据现场聚合。
- 如果没有附带 CSV，插件仍可加载，但图表暂无历史数据；可在面板更新或运行插件目录 `scripts/fetch_m1.py` 获取数据。

## 当前数据目录

- 数据放在 `<工作区>/.trade-practice/data/<品种>/1m/YYYY-MM.csv`。
- CSV 的 `openTime` 已按 **MT5 服务器时间**（GMT+2 冬令时 / GMT+3 夏令时）存储，直接复制即可，不要再运行迁移脚本。
- 如果拿到的是**旧版本**（迁移前）的数据，建议直接重新拉取，不要手动再加 2 小时；本次已清理一次性迁移脚本。
- 以后用面板「更新数据」或 `scripts/fetch_m1.py` 拉取时，**不需要额外手动加 2 小时**，脚本内已按服务器时间写入。
- `.trade-practice/state` 和 `.trade-practice/logs` 是每台电脑自己的运行状态，通常不需要复制；`data/README.txt` 会说明当前数据的时间基准。
- 插件源码、数据来源、CSV 格式及 API 见 `trade-practice-plugin/README.md`。
