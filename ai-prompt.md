# Tauri v2 + Python 混合架构应用模板开发方案

## 技术栈
前端：
React + TypeScript + Vite + MobX + shadcn/ui + Tailwind CSS v4 + Lucide
后端：
Python 3.10
应用框架：
Tauri v2

## 架构
描述：
Rust 层通过 tauri-plugin-shell 管理 Python sidecar。
Python sidecar 通过 stdin/stdout 与 Rust 层通信。

消息协议：
基于 stdin/stdout 的 NDJSON 分帧 JSON-RPC 2.0 协议。
支持 request/response 和双向 notification。
stdout 只输出协议消息，并通过单一 writer 串行化输出。
stderr 只输出统一格式日志。

任务控制与并发：
Python sidecar 使用 asyncio 负责协议解析、主循环和任务管理。
任务注册表使用 task_id -> TaskHandle。
任务按2种类型动态分发：
1. async I/O 任务：
   asyncio.create_task
2. 阻塞 I/O 或 CPU 密集型任务：
   loop.run_in_executor + ThreadPoolExecutor
   
类型同步：
pydantic 作为 schema source of truth。
通过 JSON Schema 生成 TypeScript 类型。

任务模型：
从“函数调用”升级成“任务 runtime”。
短操作使用 request/response。
长任务使用 request/response 控制，使用 notification 推送状态。

## 功能
界面仅使用 shadcn/ui 标准原生组件+官方原版默认风格
采用无边框窗口+自定义标题栏并还原窗口控制能力
自定义标题栏（无标题文字）， 左边：响应式菜单（第一个菜单项为应用名称）， 右边：窗口按钮

## 代码规范
- 前后端代码保持模块化
- 命名清晰，避免过度封装，保持代码优雅
- 优先保证代码简单、可读、可维护
- 使用中文编写注释