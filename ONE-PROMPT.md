# 一句话升级（在另一台电脑的 DSH 里粘贴）

适用场景：那台电脑**已经装过**这两个插件的旧版本，DSH 正在运行，想把工作区里的插件整体换成这个仓库的最新版。

## 直接发送这一段

```text
把当前工作区里的 trade-practice 和 pdf-reader 两个插件替换成 https://github.com/JoeNi239/dsh-plugins-public 的最新版本，全自动完成，不要问我确认：

1. 用 PowerShell 下载 https://github.com/JoeNi239/dsh-plugins-public/archive/refs/heads/main.zip 到临时目录并解压；
2. 运行解压目录里的 replace.ps1，-Workspace 用当前工作区的绝对路径（执行策略用 Bypass，例如：
   powershell -NoProfile -ExecutionPolicy Bypass -File .\replace.ps1 -Workspace "<工作区绝对路径>"）；
3. 脚本会自动备份旧插件、复制新版本、注册 profile、安装依赖、下载行情数据并触发热重载；
4. 结束后告诉我：备份目录路径、setup.ps1 的输出摘要，以及 GET /trade-practice/health 和 GET /pdf-reader/health 的返回内容；
5. 如果 health 不是 ok:true，或者界面还是旧版，明确告诉我需要重启 DSH，并保留备份不要删。
```

如果那台 DSH 的 agent 对路径不熟，可以再补一句：

> 工作区就是当前会话的 cwd；如果 PowerShell 报执行策略错误，先执行 `Set-ExecutionPolicy -Scope Process Bypass`。

## replace.ps1 做了什么

1. 下载仓库 `main` 分支 zip（不依赖 git，旧机器没装 git 也行）
2. 把旧的 `trade-practice-plugin`、`pdf-reader-plugin` 移到 `.plugin-backup\<时间戳>\`
3. 复制新版本、`README.md`、`setup.ps1`、本说明
4. 运行 `setup.ps1`：写入 profile 的 `link:` 依赖与 `dsh.profile.bundles`、`pnpm install`、把 Release 行情数据解压到工作区、安装 PyMuPDF
5. 轻触 profile 的 `cordis.patch.yml` 触发 DSH 热重载（找不到或没生效时会提示重启）
6. 清理临时文件

常用参数：

| 参数 | 作用 |
|---|---|
| `-Workspace <路径>` | 目标工作区，默认当前目录 |
| `-ProfilesRoot <路径>` | DSH profile 目录，默认 `%USERPROFILE%\.dsh\profiles` |
| `-FromZip <路径>` | 用本地 zip 代替在线下载（离线/内网可用） |
| `-SkipData` / `-SkipPip` / `-SkipInstall` | 跳过数据下载 / PyMuPDF / pnpm install |
| `-SkipReload` | 不触发热重载（之后手动重启 DSH） |
| `-KeepTemp` | 保留解压目录方便排查 |

## 回滚

```powershell
Move-Item .plugin-backup\<时间戳>\trade-practice-plugin . -Force
Move-Item .plugin-backup\<时间戳>\pdf-reader-plugin . -Force
```

然后重启 DSH。

## 注意

- 脚本会改 profile 的 `package.json`；旧的 `@local/trade-practice`、`@local/pdf-reader` 链接会被覆盖成新路径（通常路径不变，只是内容替换）。
- 旧行情数据不会被删；`.trade-practice\data` 已有 XAUUSD 时 setup 会跳过下载。
- 备份目录默认保留，确认没问题后可以手动删。
