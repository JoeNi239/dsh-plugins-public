# 在另一台电脑安装

1. 将本仓库克隆到目标电脑的固定目录。仓库根目录就是 `@local/pdf-reader` 插件包。
2. 在 DSH 正在使用的 Profile 的 `package.json` 中添加 `@local/pdf-reader` 本地依赖链接和 bundle，具体格式见仓库 `README.md`。
3. 在 Profile 目录执行 `pnpm install`，并运行 `py -m pip install pymupdf`。
4. 重启 DSH，然后从侧栏打开「PDF 阅读」。

插件可打开 Windows 文件选择框中的任意 PDF 路径，并支持中文目录名。PDF 原件、最近阅读记录、对话和标注文件需在目标电脑自行提供；这些个人数据不包含在仓库中。
