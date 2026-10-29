# Python 环境说明

插件的一键配置会创建私有虚拟环境并安装 `sqlcipher3-wheels`，不会改动系统 Python。
这个目录是同一套环境的**声明式副本**，方便你在插件之外手工复现。

```bash
# 默认 PyPI
uv sync --directory python

# 国内网络：换成清华镜像
uv sync --directory python --default-index https://pypi.tuna.tsinghua.edu.cn/simple

# 安装到插件实际使用的位置（覆盖目录）
UV_PROJECT_ENVIRONMENT=~/.local/share/dsh-qqnt-chat-export/venv \
  uv sync --directory python
```

也可以只让 uv 建环境、再用 pip 接口装：

```bash
uv venv --python 3.12 ~/.local/share/dsh-qqnt-chat-export/venv
uv pip install --python ~/.local/share/dsh-qqnt-chat-export/venv/bin/python \
  sqlcipher3-wheels
```

## 为什么没有提交 `uv.lock`

`uv.lock` 会记录每个包的实际下载 URL。这份仓库同时给国内和海外用户用：
锁定清华镜像会让海外用户下载变慢，锁定 PyPI 又会让国内用户经常连不上。
需要可复现环境时，在你自己的网络上执行一次 `uv lock --directory python`，
生成的锁文件会跟着你选择的索引走。

`pyproject.toml` 里的 `requires-python` 覆盖 3.10–3.14；`.python-version` 是
插件默认让 uv 下载的版本（3.12），可以用 `pythonVersion` 设置覆盖。
