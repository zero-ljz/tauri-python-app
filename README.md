# tauri-python-app

Tauri v2 desktop app with a React/TypeScript frontend, Rust bridge layer, and Python sidecar runtime.

## 技术栈

- Frontend: React, TypeScript, Vite, MobX, shadcn/ui, Tailwind CSS v4, Lucide
- App shell: Tauri v2
- Rust bridge: Tauri commands, sidecar lifecycle, JSON-RPC request tracking
- Python sidecar: Python 3.10, asyncio, pydantic, PyInstaller
- Transport: stdin/stdout NDJSON framed JSON-RPC 2.0

## 架构概览

```text
React UI
  -> Tauri invoke / event listen
Rust bridge
  -> sidecar process lifecycle
  -> JSON-RPC request/response matching
  -> stderr log forwarding
Python sidecar
  -> asyncio stdin reader
  -> dispatcher
  -> task runtime
```

核心约定：

- stdout 只输出 JSON-RPC/notification NDJSON 协议消息。
- stderr 只输出日志，Rust 会实时转发到前端 RpcDebugPanel 的“日志”页签。
- 短操作使用 request/response。
- 长任务使用 request/response 返回 `task_id`，再用 notification 推送状态、进度和结果。
- pydantic 是 schema source of truth，TypeScript 类型由 `scripts/gen_types.py` 生成。

## 目录说明

```text
src/                         React 前端
src/components/debug/         IPC 调试面板
src/components/titlebar/      自定义标题栏和窗口按钮
src/stores/                   MobX stores
src/lib/tauri-rpc.ts          前端 RPC/sidecar 事件封装
src/types/generated.ts        自动生成的 TypeScript 类型

src-tauri/src/                Rust/Tauri 层
src-tauri/src/sidecar/        sidecar 进程管理
src-tauri/src/rpc/            JSON-RPC pending request 管理
src-tauri/src/bridge/         Python stdout 消息分发
src-tauri/src/commands/       前端可 invoke 的 Tauri commands

sidecar/                      Python sidecar
sidecar/main.py               sidecar 主循环
sidecar/protocol.py           stdin/stdout 协议层
sidecar/models.py             pydantic schema
sidecar/handlers/             RPC handlers

scripts/gen_types.py          pydantic schema -> TypeScript
scripts/build_sidecar.py      PyInstaller sidecar 打包脚本
```

## 环境准备

需要安装：

- Node.js
- pnpm
- Rust stable
- Tauri v2 prerequisites
- Python 3.10
- PyInstaller

安装前端依赖：

```bash
pnpm install
```

推荐使用本地 Python 虚拟环境：

```bash
python -m venv .venv
.venv\Scripts\python -m pip install -U pip pyinstaller pydantic
```

开发和打包时都会优先使用本地虚拟环境 Python。查找顺序：

1. `.venv`
2. `src-tauri/.venv`
3. `venv`
4. `src-tauri/venv`
5. `PYTHON` 环境变量
6. 系统 `python`

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 只启动 Vite 前端开发服务器 |
| `pnpm tauri dev` | 启动完整 Tauri 开发环境 |
| `pnpm gen:types` | 从 pydantic models 生成 `src/types/generated.ts` |
| `pnpm build` | 生成类型、TypeScript 检查、构建前端 |
| `pnpm build:sidecar` | 使用 PyInstaller 构建 Python sidecar 二进制 |
| `pnpm build:release` | 先构建 sidecar，再构建前端 |
| `pnpm tauri build` | 构建发布包，会自动运行 `pnpm build:release` |
| `pnpm tauri build --debug --no-bundle` | 验证 Tauri 构建链，不生成安装包 |
| `cargo check --manifest-path src-tauri/Cargo.toml` | Rust 编译检查 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` | Rust lint 检查 |
| `python -m py_compile ...` | Python sidecar 语法检查 |

Windows PowerShell 示例：

```powershell
pnpm tauri dev
pnpm build
pnpm build:sidecar
pnpm tauri build --debug --no-bundle
cargo check --manifest-path src-tauri\Cargo.toml
cargo clippy --manifest-path src-tauri\Cargo.toml -- -D warnings
```

## 开发流程

### 前端开发

启动完整应用：

```bash
pnpm tauri dev
```

调试面板入口：

- 菜单栏 -> 视图 -> 显示 IPC 调试面板
- 偏好设置 -> IPC 调试面板

RpcDebugPanel 包含：

- 报文：前端 request/response/notification 历史
- 日志：Python sidecar stderr 实时日志和启动日志回放
- 请求：手动发送 JSON-RPC 请求

### 新增 Python RPC handler

1. 在 `sidecar/handlers/` 下新增或修改 handler。
2. 使用 `@dispatcher.register("method.name")` 注册方法。
3. 如果新增了文件，在 `sidecar/main.py` 中 import 它，确保装饰器执行。
4. 如果涉及新数据结构，更新 `sidecar/models.py`。
5. 运行：

```bash
pnpm gen:types
pnpm build
```

示例：

```python
from dispatcher import dispatcher

@dispatcher.register("echo")
async def handle_echo(params: dict) -> dict:
    return params
```

### 任务运行时

任务分两类：

- async I/O 任务：`TaskRegistry.submit_async(...)`，内部使用 `asyncio.create_task`
- 阻塞 I/O 或 CPU 密集型任务：`TaskRegistry.submit_blocking(...)`，内部使用 `loop.run_in_executor + ThreadPoolExecutor`

注意：

- async 任务可以正常取消。
- blocking 线程任务不能强制杀掉，只能记录取消意图并返回 `cancelled=false`。
- 真正需要强制终止的 CPU 长任务，应后续升级为独立 process worker。

## Sidecar 打包

Tauri 发布配置使用：

```json
"externalBin": ["bin/sidecar"]
```

实际文件名由 Tauri target triple 决定，例如 Windows：

```text
src-tauri/bin/sidecar-x86_64-pc-windows-msvc.exe
```

手动构建 sidecar：

```bash
pnpm build:sidecar
```

指定 target：

```bash
python scripts/build_sidecar.py --target x86_64-pc-windows-msvc
```

清理 PyInstaller 缓存后构建：

```bash
python scripts/build_sidecar.py --clean-cache
```

`src-tauri/bin/*.exe` 是本地构建产物，默认不提交到 Git。发布构建时会自动重新生成。

## 类型生成

类型来源：

```text
sidecar/models.py
```

生成输出：

```text
src/types/generated.ts
src/types/schema.json
```

命令：

```bash
pnpm gen:types
```

`src/types/schema.json` 是中间产物，默认不提交。`src/types/generated.ts` 是前端使用的类型文件。

## JSON-RPC 约定

request:

```json
{"jsonrpc":"2.0","id":"request-id","method":"echo","params":{"message":"hello"}}
```

success response:

```json
{"jsonrpc":"2.0","id":"request-id","result":{"message":"hello"}}
```

error response:

```json
{"jsonrpc":"2.0","id":"request-id","error":{"code":-32601,"message":"Method not found"}}
```

notification:

```json
{"jsonrpc":"2.0","method":"task.progress","params":{"task_id":"...","progress":0.5}}
```

已处理的协议错误：

- `-32700 Parse error`
- `-32600 Invalid Request`
- `-32601 Method not found`
- `-32603 Internal error`

## 安全策略

Tauri CSP 配置在 `src-tauri/tauri.conf.json`：

- `csp` 用于生产构建，限制脚本、连接、图片和字体来源。
- `devCsp` 用于开发环境，额外允许 Vite HMR 需要的 localhost/ws 和 inline dev script。

不要随意改回 `csp: null`。如果新增远程资源，需要同步评估 CSP 和能力权限。

能力权限在 `src-tauri/capabilities/default.json`。当前保留：

- `shell:allow-spawn`
- `shell:allow-kill`
- `shell:allow-stdin-write`
- 必要窗口控制权限

## 排障

### DevTools 里看到 `http://ipc.localhost/...`

这是 Tauri IPC 的 DevTools 表现，不是访问外网。正常情况下不应持续刷旧的窗口轮询请求。

### `Sidecar 进程尚未运行，RPC 请求已取消`

常见原因：

- Python 解释器不可用
- `.venv` 里缺少依赖
- `sidecar/main.py` 启动异常
- 打包后的 sidecar 二进制不存在或过期

处理：

```bash
python sidecar/main.py
pnpm build:sidecar
pnpm tauri dev
```

同时打开 RpcDebugPanel 的“日志”页签查看 sidecar stderr。

### 模拟发送请求超时

先确认 sidecar 是否已 ready，再检查“日志”页签。如果是协议错误，Python sidecar 应返回 JSON-RPC error，而不是静默超时。

### 发布包 sidecar 不工作

先验证 sidecar 二进制：

```bash
pnpm build:sidecar
```

再验证 Tauri 构建链：

```bash
pnpm tauri build --debug --no-bundle
```

## 提交前检查

建议至少运行：

```bash
pnpm build
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
python -m py_compile sidecar/main.py sidecar/models.py sidecar/protocol.py sidecar/dispatcher.py sidecar/task_manager.py sidecar/handlers/echo.py sidecar/handlers/tasks.py
```

发布前再运行：

```bash
pnpm tauri build --debug --no-bundle
pnpm tauri build
```
