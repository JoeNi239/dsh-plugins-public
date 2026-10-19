# 交易练习（Trade Practice）

K 线 **只读工作区 CSV**；网络拉数与插件加载完全分离。唯一数据源为 **HistData.com**（`scripts/fetch_m1.py`）；Harness 面板「更新数据」会启动该脚本，也可手动运行。时间统一为 **MT5 服务器时间**（GMT+2 冬令时 / GMT+3 夏令时），与 MT5 图表对齐。

## 目录约定

```
<workspace>/
  .trade-practice/
    data/
      XAUUSD/
        1m/
          2020-01.csv
          2025-10.csv
    state/
      XAUUSD-1m-fetch.json
    logs/
      XAUUSD-1m-fetch.log
```

环境变量（可选）：

- `TRADE_PRACTICE_DATA` — 覆盖上述 `data` 根目录
- `TRADE_PRACTICE_ROOTS` — 额外工作区根（与 PDF 插件类似）

## CSV 格式

UTF-8，首行表头固定：

```csv
openTime,open,high,low,close,volume
2024-06-01T12:00:00Z,2321.50000,2325.10000,2319.80000,2323.40000,5999
```

- `openTime`：**MT5 服务器时间**，ISO 8601 形式，整分 `…THH:MM:SSZ`（`Z` 仅用于与图表/epoch 对齐，不是真 UTC）
- 价格：十进制小数，按数据实际精度显示（不写死品种位数）
- `volume`：可为 0

同一分钟重复时以后写入为准（按服务器时间分钟去重）。

## 更新 CSV（与插件无关）

**XAUUSD · 1m · 分月（2020→今）· 仅 HistData.com**

```powershell
cd C:\Users\joe\Documents\deepseek-harness\default-workspace\trade-practice-plugin

# 全量慢拉
powershell -File scripts/run-histdata-backfill.ps1 -Workspace C:\Users\joe\Documents\deepseek-harness\default-workspace -Pair XAUUSD -FromYear 2020

# 或直接调 Python
python scripts/fetch_m1.py --workspace C:\Users\joe\Documents\deepseek-harness\default-workspace --histdata --pair XAUUSD --from-year 2020

# 终端监视
powershell -File scripts/watch-fetch.ps1
```

Harness 面板顶栏约 5 秒刷新 `fetch-status`；或 `GET /trade-practice/fetch-status?symbol=XAUUSD&interval=1m`。

高周期（5m / 15m / … / 1M）由插件在读取时从 1m **聚合**，不单独存盘。

CSV 的 `openTime` 按 **MT5 服务器时间**（GMT+2 冬令时 / GMT+3 夏令时）存储；现有历史数据已统一为该基准，抓取脚本也按同一基准写入。

## 插件 API（只读 CSV）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/trade-practice/health` | 数据根、品种列表 |
| GET | `/trade-practice/symbols?interval=1m` | 各品种 CSV 是否存在、mtime、根数 |
| GET | `/trade-practice/meta?symbol=XAUUSD&interval=1m` | 单文件元数据 |
| GET | `/trade-practice/bars?symbol=&interval=&from=&to=` | OHLC 数组（可选时间过滤；高周期现场聚合） |
| POST | `/trade-practice/update-data` | 启动 HistData 拉取 |
| POST | `/trade-practice/ask` | 直连模型对话（fallback，SSE） |
| POST | `/trade-practice/agent/bootstrap` | 启动后首次进入：创建/复用当前 agent |
| GET | `/trade-practice/agent/list` | 插件私有 agent 历史与当前状态 |
| POST | `/trade-practice/agent/new` | 新建 agent（旧 agent 归档） |
| POST | `/trade-practice/agent/switch` | 恢复历史 agent（unarchive + resume） |
| POST | `/trade-practice/agent/delete` | 归档并移出插件历史 |
| GET | `/trade-practice/agent/events?sessionId=` | agent 流式事件 + 画线命令（SSE） |
| POST | `/trade-practice/agent/prompt` | 发送问题、当前视图截图与画线上下文 |
| POST | `/trade-practice/agent/ack` | 浏览器确认画线命令 |
| GET | `/trade-practice/agent/history?sessionId=` | 读取历史 transcript |

## 面板

- 品种：XAUUSD、GBPUSD；周期 1分～1月；**只读 CSV**；插件启动时检查/更新一次，运行中不再自动定时更新；状态栏「检查更新」可手动触发，更新完成不会打断练习
- 普通模式用于历史看盘且不开放下单；点击「开始练习」后可选时间或随机选点（输入/显示均为服务器时间），只展示起点及此前 K 线，并按当前周期逐根展开
- 两种模式共用画线；练习模式支持逐 K 回放与播放，向左翻动可动态加载更早 K 线；练习中切换周期会保留练习状态并对齐到当前回放时间，逐 K 前进不重置当前水平视图
- 画线按时间与价格锚定，同品种跨周期显示：水平线、趋势线、射线、垂直线、矩形、平行通道、斐波那契回调与扩展、文字标注（localStorage）
- 画线管理：选择并定位（仅点击管理列表条目会移动视图）、撤销最近一条、编辑文字、删除单条或清空；新增 / 编辑 / 删除画线都不会改变当前 K 线的缩放与位置；选中图表对象会高亮
- 练习模式图表叠加开仓 / 挂单 / 止损 / 止盈水平线与价格标签；SL、TP 线可直接用鼠标上下拖动修改（会校验在当前价正确一侧），交互与 MT5 一致
- 十字线默认自由跟随，仅当鼠标落在当前 K 线的实体上沿 / 实体下沿 / 上影线顶 / 下影线底 5px 内时轻微吸附，其它位置不吸附
- 价格小数位按加载到的 OHLC 数据自动推断（例如 XAUUSD 数据 3 位、GBPUSD 5 位），不按品种写死；图表价格轴、挂单/止损止盈标签、拖动与下单提示使用同一精度
- 指标与成交量图层默认关闭，可分别开启 MA20/MA50、RSI14 与成交量；计算只使用当前图表可见 K 线，练习时不会读取未来 K 线
- 模拟：仅练习模式可开多/开空、设置止损止盈、逐 K 撮合及管理账户；开盘价越过挂单价/止损止盈价时按开盘价成交（下单面板可关闭），成交记录会标注「跳空」
- 侧栏 **对话**：优先接入 DSH agent 层（会话历史、工具调用、流式输出）；agent 不可用时自动降级为 `/trade-practice/ask` 直连模式。每次发送自动截取当前屏幕可见的 K 线范围随问题发给 agent，模型通过工具直接在本插件图表上画线，而不是在截图上标注

### Agent 层

- **1A 启动策略**：每次 DSH 启动后第一次进入插件创建新 agent；同一 boot 内关闭/重开面板复用当前 agent；「新建」显式创建。
- **历史**：历史 agent 保存在插件私有索引 `.trade-practice/agents.json`；点下拉切换，行内 **×** 立即删除该会话（无二次确认，归档并移出索引，之后不再出现）；空闲 agent 通过 `archiveSession` 隐藏，切换时 `unarchive` + `resume`。
- **标题**：与普通 DSH 会话一致，新建 agent 不预先命名（下拉显示「新会话」），发出第一条消息后由 DSH `sessionTitle` 生成并同步到插件索引；旧版本写入的「交易练习 · 品种 · 时间」默认标题按未命名处理，切换到该 agent 时改用其真实标题。
- **隔离**：插件只读自己的索引，不读主 session 列表；当前活跃 agent 若展开主侧栏仍可能出现，但插件内的历史和工具与主对话隔离。
- **工具**：`add_drawing` / `delete_drawing` / `clear_drawings` + `get_bars`（跨周期、可往前翻）；`get_bars` 的 `end` 强制 clamp 到回放 cutoff，练习模式不能读未来。
- **联网**：练习模式通过 scoped `tools.guard` 硬禁用 `web_search` / `web_fetch`；普通模式允许。需要联网时请用主界面或其他普通 agent。
- **画线坐标**：`time` 不得超过 cutoff；分析可以看更早历史，但画线锚点尽量落在当前视图；全部锚点在视图之前会收到提示。
- **当前视图**：每条用户消息包含截图、视图时间/价格范围、视图内与视图前 OHLC、已有画线（含用户/AI 来源、颜色、是否在视图内）。

### AI 画线规则

- 截图只包含发送瞬间屏幕上可见的 K 线、画线与坐标轴，不等于全部已加载数据；模型仍收到同一窗口的 OHLC 与时间/价格范围，工具坐标以此为准。
- 画线 `time` 不能超过回放截止时间；价格在视图价格范围外、或所有锚点都在当前视图之前时，工具结果会附带提示（不强制拒绝）。
- 每次提问最多新增 3 个画线对象；不主动删除或清空已有画线，`clear_drawings` 只在用户明确说“清空/全部删除”时放行。
- 新增 / 删除 / 清空与手工画线共用同一 localStorage 和覆盖层；画线变化不会移动或重载 K 线视图。
- 模型菜单中的「图」标记表示支持图片输入；不支持或附件不可用时，对话里会提示，并自动降级为只发送 K 线与画线数据。

## 安装到 DSH Profile

将 `trade-practice-plugin` 放在工作区根目录，在正在使用的 Profile `package.json` 中添加指向它的本地 `link:` 依赖，并把 `@local/trade-practice` 加入 `dsh.profile.bundles`；保留已有配置并重启 Harness。Agent 层新增了宿主路由与 `AgentManager`，**首次升级后需要重启 DSH**；之后客户端 bundle 会随文件变化热更新。另一台电脑的完整迁移步骤见 [TRANSFER-SETUP.md](TRANSFER-SETUP.md)。
