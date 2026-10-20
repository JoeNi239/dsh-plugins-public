# PDF Reader for DeepSeek Harness

一个用于 DeepSeek Harness（DSH）的 PDF 阅读插件，支持 PDF 页面阅读、最近文件记录、文字选择提问、全文检索、标注和内容导出。

## 安装

需要 Windows、已启动过至少一次的 DSH、Python 3 和 PyMuPDF。

1. 将本仓库克隆到固定目录，例如 `%USERPROFILE%\Documents\deepseek-harness\pdf-reader-plugin`。
2. 在 DSH 正在使用的 Profile 的 `package.json` 中合并以下配置。请将链接路径替换成仓库的实际绝对路径，并保留已有依赖和 bundle 项。

```json
{
  "dependencies": {
    "@local/pdf-reader": "link:C:/Users/<用户名>/Documents/deepseek-harness/pdf-reader-plugin"
  },
  "dsh": {
    "profile": {
      "bundles": ["@local/pdf-reader"]
    }
  }
}
```

3. 在该 Profile 目录执行 `pnpm install`，然后重启 DSH。
4. 安装 PDF 解析依赖：

```powershell
py -m pip install pymupdf
```

插件默认尝试 `python` 和 `py`。可用 `PDF_READER_PYTHON` 指定解释器，也可用 `PDF_READER_PROVIDER` 和 `PDF_READER_MODEL` 覆盖 PDF 对话模型。

## 使用

从 DSH 侧栏打开「PDF 阅读」，点击「打开 PDF」。选择框会列出最近打开的文件，可直接打开或删除记录；点击「选择新 PDF」会打开 Windows 文件选择框。也可以把 PDF 拖到阅读面板。

支持中文文件夹和文件路径。最近记录、阅读进度和对话保存在浏览器本地；标注以 `<PDF 文件名>.annotations.json` 保存到 PDF 同目录，无法写入时存到系统临时目录。

## 仓库内容

仓库根目录就是 `@local/pdf-reader` 插件包，只包含 PDF Reader 源码、界面、Python 解析进程、语言文件和文档。PDF 原件、对话数据、标注数据及账号凭证不属于仓库内容。
