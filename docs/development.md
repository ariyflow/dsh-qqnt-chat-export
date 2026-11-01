# 开发

```
index.js              插件入口：十个工具 + 启动网页服务 + 侧边栏面板路由
client.js             浏览器半边：侧边栏图标 / 主面板 / better-sidebar tab（原生 iframe）
web.js                本地 HTTP 服务与 JSON API
jobs.js               通用后台任务队列（排队、并发、取消、重试、落盘恢复）
runners.js            任务执行器：OCR / 语音 / 分块 / 模型下载 / 组件安装 / 导出
presets.js            导出预设的读写与合并（workDir/presets.json）
chatlookup.js         把「名字/别名/群号/和某某的私聊」解析成会话（导出工具用）
settings.js           设置持久化、校验与默认值
storage.js            生成文件统计与白名单清理
web/                  前端（原生 ESM，无构建）：index.html、css/base.css、
                      js/{api,state,app}.js、js/views/{chats,export,stats,ask,settings,models,jobs}.js
cordis.patch.yml      插件行与默认配置
scripts/
  qqnt_export.py      密钥提取 / 解密 / Protobuf 解析 / 单群导出（Windows + Linux）
  qqnt_query.py       只读查询层：建索引、会话列表、分页查询、多格式导出、问答检索
  qqnt_derived.py     派生库（识别文本 / 分块 / 向量）与 FTS
  qqnt_embed.py       分块与嵌入，写 chunks / vectors
  qqnt_retrieve.py    混合检索（二字词 + 向量 + RRF）与引用
  qqnt_ann.py         可选 usearch 向量索引（缺失时线性扫描）
  qqnt_components.py  OCR / 语音 / 向量所需的 Python 组件安装
  qqnt_models.py      模型文件下载、校验与删除
  qqnt_ocr.py / qqnt_asr.py  截图识别 / 语音转写
  wal_spike.py        WAL 可读性手工诊断（只读源库，复制后回放）
python/              可手工复现的 Python 环境声明（pyproject.toml、.python-version）
locale/               en / zh 显示元数据
tests/                Python / Node 回归测试
docs/screenshot-app.png    界面截图（虚构数据）
docs/windows-checklist.md  Windows 12 项验收清单（步骤 / 预期 / 失败先看哪里 / 实测）
docs/verification-windows.md  某一轮 Windows 全量验证的实测记录
```

## 开发与测试

```bash
python -m unittest discover -s tests -v
node --test tests/*.test.mjs
```

测试不会读取真实 QQ 数据；增量同步、FTS 与「没有 FTS5」的用例使用临时合成库（`tests/test_incremental.py`），它们需要 `sqlcipher3`，没装时自动跳过。CI 会在 Ubuntu/Windows 上安装 `sqlcipher3-wheels` 与 `pyzipper` 让这些用例真正执行；本地想跑全套，把解释器指向插件的私有虚拟环境即可（`PYTHON=<venv>/bin/python node --test tests/*.test.mjs`）。

Node 侧的网页与任务用例原本用一个 `#!/bin/sh` 假解释器，Windows 上无法启动，所以那 26 个用例一直被跳过。现在假解释器改成 `.py`、由真实 Python 运行，测试通过环境变量 `QQNT_HELPER_SCRIPT`（**仅供测试**：只在它是绝对路径时生效，生产环境从不设置）把 `web.js` 指向临时脚本。两个平台因此跑同一套用例，不再有平台相关的 skip。

Windows 真机验收按 [`docs/windows-checklist.md`](windows-checklist.md) 走一遍（12 项，每项都写了失败时先看哪个文件）；排查用户问题时，让对方在设置页点「下载诊断包」，那个 JSON 能判断平台、路径、依赖与表结构哪里不对。

## 改代码后如何生效

- 修改 `settings.js` / `web.js` 后需要重启插件（或重启 DSH），网页才会加载新版本；`web/` 下的静态文件刷新即生效（无构建步骤）；Python 脚本改动会在下一次调用时生效。

## 安装方式：`file:` 与 `link:`

- 用 `file:` 目录安装时，pnpm 会把插件文件复制进 profile：改完源码要重新装一次。如果源码已更新但启动时报 `does not provide an export named ...`，说明安装目录里还是旧副本：在 profile 目录执行 `dsh plugin --profile <name> install` 重新安装即可（必要时先删掉 `node_modules/dsh-qqnt-chat-export`）。
- 想「改完代码重启就生效」，把 profile 的依赖写成 `link:/path/to/dsh-qqnt-chat-export`：pnpm 会在 `node_modules` 里建一个指向仓库的 junction，重启后加载的就是仓库代码，**不会再被覆盖**。反过来，依赖写成 `github:...` 时每次启动都会从 GitHub 重装并覆盖手改的文件——确认「跑的是哪一版」看 `node_modules/dsh-qqnt-chat-export/package.json` 的 `version`，或 `GET /api/diagnostics/bundle` 里的 `version`。
