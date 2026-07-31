# tauri-python-app

面向生产环境的 Tauri v2 桌面应用模板：React/TypeScript 前端、Rust 桥接层，以及由 PyInstaller 打包的 Python sidecar。

## 模板包含什么

- React 19、TypeScript、Vite、MobX、Tailwind CSS v4 和 shadcn/ui 风格组件。
- Tauri v2 窗口与生命周期管理，Python 子进程树可优雅退出并在超时后完整终止。
- 严格 UTF-8 NDJSON JSON-RPC 2.0，双向帧大小限制、请求超时、关联 ID 和有界日志。
- Pydantic 参数/返回值运行时校验，并从 Python 方法注册表生成 TypeScript 类型。
- `public`、`debug-only`、`requires-confirmation`、`dangerous` 四级 RPC 权限。
- 可恢复的后台任务、进度通知、权威快照同步和有界历史记录。
- 敏感字段脱敏、全局错误边界、后端失败重试和一键导出诊断信息。
- 带签名校验的 Tauri 更新器、跨平台发布工作流、依赖审计和 Python SBOM。
- Biome、Ruff、Pyright、Vitest、unittest、Clippy 和 Rust tests 的统一检查入口。

## 架构

```text
React UI
  -> 类型安全的 Tauri invoke / event listen
Rust bridge
  -> 权限检查、原生确认、请求跟踪、生命周期和进程树管理
  -> stdin/stdout NDJSON
Python backend
  -> typed dispatcher、Pydantic validation、task runtime
```

协议有几个硬约束：

- Python `stdout` 只写协议帧，`stderr` 只写日志。
- `protocol.json` 是协议版本和限制的唯一来源；运行 `pnpm generate` 生成三端常量和前端类型。
- Rust 完成 `initialize -> initialized` 握手后才接受业务 RPC。
- 每次后端启动都有 generation；旧进程迟到的响应和通知会被丢弃。
- `task.updated` / `task.progress` 只是低延迟提示，`task.get` / `task.list` 才是权威状态。

## 快速开始

需要 Node.js 24、pnpm 11、Rust stable、Python 3.10，以及当前平台的 [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)。

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install --require-hashes -r requirements-dev.txt
pnpm install --frozen-lockfile
pnpm check
pnpm tauri dev
```

开发和打包脚本按 `.venv`、`src-tauri/.venv`、`venv`、`src-tauri/venv`、`PYTHON`、系统 `python` 的顺序查找解释器。

## 初始化为自己的项目

克隆模板后运行一次：

```powershell
python scripts/init_template.py `
  --name my-desktop-app `
  --product-name "My Desktop App" `
  --identifier com.example.mydesktopapp `
  --author "Your Name" `
  --description "My desktop application" `
  --repository owner/my-desktop-app
```

脚本会同步更新 npm、Cargo、Tauri 标识、窗口标题、Rust library 名称、README、菜单和许可证。若模板已经初始化，脚本会停止；只有明确需要重新初始化时才传 `--force`。

版本由根目录 `package.json` 管理：

```powershell
python scripts/sync_version.py --set 1.2.3
python scripts/sync_version.py --check
```

第二条命令检查 `package.json`、`src-tauri/tauri.conf.json`、`Cargo.toml` 和 `Cargo.lock` 是否一致。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `pnpm generate` | 生成三端协议常量、JSON Schema 和 TypeScript RPC 类型 |
| `pnpm check` | 运行生成物漂移、版本、类型、lint 和全部单元/集成测试 |
| `pnpm format:frontend` | 使用 Biome 格式化前端源码和配置 |
| `pnpm build` | 生成代码、TypeScript 检查并构建前端 |
| `pnpm build:backend` | 用 PyInstaller 构建当前平台 Python sidecar |
| `python scripts/smoke_sidecar.py` | 对已构建 sidecar 执行握手与退出冒烟测试 |
| `pnpm tauri dev` | 启动完整开发环境 |
| `pnpm tauri build --debug --no-bundle` | 验证完整 Tauri 构建链，不生成安装包 |
| `pnpm tauri build` | 构建当前平台安装包 |

## 新增 RPC 方法

在 `backend/handlers/` 中定义 Pydantic 模型并注册方法，随后运行 `pnpm generate`。注册表同时驱动后端校验、握手元数据和前端方法类型，不需要维护第二份方法映射。

```python
from pydantic import BaseModel

from backend.rpc import rpc


class GreetParams(BaseModel):
    name: str


class GreetResult(BaseModel):
    message: str


@rpc.register(
    "greet",
    params=GreetParams,
    result=GreetResult,
    permission="public",
)
async def greet(params: GreetParams) -> GreetResult:
    return GreetResult(message=f"Hello, {params.name}")
```

权限含义：

- `public`：普通前端调用可以访问。
- `debug-only`：仅开发构建或显式启用调试后端时允许。
- `requires-confirmation`：前端必须使用确认调用，Rust 会显示原生确认框。
- `dangerous`：通用 RPC 桥永远拒绝；应为具体操作编写参数收窄、可审计的专用 Rust command。

前端通常使用 `rpcCall(...)`；确认型操作使用 `rpcCallConfirmed(...)`。发布构建默认完全隐藏 IPC 调试面板，只有构建时设置 `VITE_ENABLE_RPC_DEBUG=1` 才会显示。

## 后台任务

- async I/O 使用 `TaskRegistry.submit_async(...)`，可协作取消。
- 阻塞 I/O 使用 `TaskRegistry.submit_blocking(...)`，线程已开始后无法强制取消。
- CPU 密集任务应放到独立 worker 进程，不应依赖线程绕过 GIL。
- 任务历史达到上限时只淘汰终态任务，不会为了限长而丢掉运行中任务。
- 应用退出时先请求后端优雅关闭，超时后再终止整棵子进程树。

## 依赖与锁文件

运行时 Python 依赖定义在 `backend/requirements.in`，开发依赖定义在 `requirements-dev.in`。提交的是带哈希的锁文件：

使用 uv 的 universal resolution 生成同一份可用于 Windows、Linux 与 macOS 的锁；普通 `pip-compile` 输出只适用于生成它的平台。

```powershell
.venv\Scripts\uv pip compile --universal --python-version 3.10 --generate-hashes --upgrade --output-file backend\requirements.txt backend\requirements.in
.venv\Scripts\uv pip compile --universal --python-version 3.10 --generate-hashes --upgrade --output-file requirements-dev.txt requirements-dev.in
```

安装时使用：

```powershell
.venv\Scripts\python -m pip install --require-hashes -r requirements-dev.txt
pnpm install --frozen-lockfile
```

## 安全与诊断

- RPC 参数、返回值、错误和日志会按敏感字段名与常见凭据格式脱敏；仍不应主动把秘密发送到日志接口。
- 每个请求都有 `correlation_id`，Python 日志记录排队时间、帧大小和执行耗时。
- “偏好设置 → 诊断”可导出已脱敏 JSON；文件写入应用数据目录的 `diagnostics/` 子目录。
- Tauri capability 只开放必要窗口权限。sidecar 的启动、停止和 stdin 由 Rust 层独占管理。
- 漏洞披露方式见 `SECURITY.md`，贡献流程见 `CONTRIBUTING.md`。

## 自动更新与发布

普通开发构建没有配置更新公钥和地址时，更新器保持禁用。发布构建需要 HTTPS 更新地址和 Tauri updater 签名密钥；安装更新前会显示原生确认框，安装时先关闭 Python 后端，再请求应用重启。

GitHub 仓库中配置以下 Actions variables：

- `TAURI_UPDATER_PUBLIC_KEY`
- `TAURI_UPDATER_ENDPOINT`，例如 `https://github.com/OWNER/REPO/releases/latest/download/latest.json`

配置以下 Actions secrets：

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（密钥有密码时）

macOS 正式签名和 notarization 还需要 `APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGNING_IDENTITY`、`APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID`。Windows Authenticode 证书的存储方式因提供商而异，应在确定证书方案后向发布工作流增加对应签名环境变量；updater 签名不能替代操作系统代码签名。

发布步骤：

```powershell
python scripts/sync_version.py --set 1.2.3
pnpm check
git tag v1.2.3
git push origin v1.2.3
```

`.github/workflows/release.yml` 会在 Windows、Ubuntu、macOS Apple Silicon 和 macOS Intel 原生 runner 上分别构建 sidecar 和安装包，并创建包含 `latest.json` 的草稿 Release。检查草稿、签名和安装包后再手动发布。

其他自动化：

- `ci.yml`：三大平台全量检查、sidecar 冒烟和 Tauri debug 构建。
- `security.yml`：每周执行 npm、Python、Rust 依赖审计并上传 Python CycloneDX SBOM。
- `dependabot.yml`：跟踪 npm、Cargo、pip 和 GitHub Actions 更新。

## 目录

```text
protocol.json                    协议版本与限制的唯一来源
backend/                         Python runtime、typed dispatcher、handlers
src/                             React UI、stores、typed RPC client
src-tauri/src/backend/           lifecycle、transport、health、process tree
src-tauri/src/commands.rs        Tauri commands 与 RPC 权限门禁
src-tauri/src/updater.rs         签名更新检查、安装和重启
scripts/gen_protocol.py          三端协议常量生成
scripts/gen_types.py             Pydantic/RPC registry -> TypeScript
scripts/init_template.py         一次性模板初始化
scripts/sync_version.py          多清单版本同步
scripts/check.py                 本地统一质量门禁
```

## 排障

- 启动失败：先运行 `python -m backend.main`，再看应用错误页或开发构建的 IPC 日志页。
- 发布包找不到后端：运行 `pnpm build:backend` 和 `python scripts/smoke_sidecar.py`，确认生成文件的 target triple 与 `rustc -vV` 一致。
- RPC 超时：确认后端状态为 `ready`，用同一 `correlation_id` 对照前端历史和 Python stderr。
- 更新器显示未配置：确认公钥和 endpoint 是构建时环境变量，而不是只在运行时设置；endpoint 必须为 HTTPS。
- 生成物检查失败：运行 `pnpm generate` 并提交生成文件，不要手工修改生成文件。

## License

MIT，见 `LICENSE`。
