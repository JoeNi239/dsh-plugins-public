# 发给另一台电脑的配置说明

此压缩包包含 PDF Reader 插件源码与本说明，不包含个人 PDF 文件、对话记录或标注数据。将压缩包解压到 DeepSeekHarness 工作区根目录，得到：

```text
<工作区>/
  pdf-reader-plugin/
```

## 让 DeepSeekHarness 加载插件

在 DeepSeekHarness 正在使用的 Profile `package.json` 里：

1. 在 `dependencies` 中添加本地链接 `@local/pdf-reader`，目标指向 `<工作区>/pdf-reader-plugin`。如果 Profile 的 `package.json` 在其他目录，按它所在目录计算相对路径。
2. 在 `dsh.profile.bundles` 中添加 `@local/pdf-reader`，保留已有的 bundle 项。
3. 保存配置并重启 DeepSeekHarness。插件自带的 `cordis.patch.yml` 会注册 PDF 阅读入口和 API 路由。

配置示例（相对路径按这台电脑的实际目录调整）：

```json
{
  "dependencies": {
    "@local/pdf-reader": "link:./pdf-reader-plugin"
  },
  "dsh": {
    "profile": {
      "bundles": ["@local/pdf-reader"]
    }
  }
}
```

如果 Profile 已有 `dependencies` 或 `dsh.profile.bundles`，只合并上述条目，不要覆盖其他配置。插件运行不需要 `node_modules`。

## 安装 PDF 解析依赖

插件需要 Python 3 和 PyMuPDF。在 Windows PowerShell 运行：

```powershell
py -m pip install pymupdf
py -c "import fitz; print(fitz.__doc__.splitlines()[1])"
```

插件默认依次尝试 `python` 和 `py`。如需固定解释器，可设置环境变量 `PDF_READER_PYTHON` 为 Python 可执行文件完整路径，然后重启 Harness。

## 检查安装

- 在 Harness 左侧栏底部打开「PDF 阅读」。
- `GET /pdf-reader/health` 应返回 `ok: true`。
- 从工作区打开一个 PDF，检查页面渲染、文字选择和对话。

插件默认只浏览工作区内文件。需要访问额外目录时，用系统路径分隔符配置环境变量 `PDF_READER_ROOTS`（Windows 使用分号）。PDF 文件和标注侧车文件需在目标电脑上自行提供，不包含在此压缩包内。

其余功能与路径限制见 `pdf-reader-plugin/README.md`。
