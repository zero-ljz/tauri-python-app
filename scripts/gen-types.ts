#!/usr/bin/env node
/**
 * scripts/gen-types.ts
 * 
 * 读取 Python (Pydantic) 导出的 JSON Schema 并为前端生成严格对应的 TypeScript 类型定义文件。
 * 
 * 使用方式：
 *   1. 从 Python 导出最新的 schema 结构模型：
 *      python -c "
 *        import json, sys
 *        sys.path.insert(0, 'src-tauri/sidecar')
 *        from models import *
 *        schemas = {
 *          'RpcRequest': RpcRequest.model_json_schema(),
 *          'RpcResponse': RpcResponse.model_json_schema(),
 *          'RpcNotification': RpcNotification.model_json_schema(),
 *          'TaskStatus': TaskStatus.model_json_schema(),
 *          'TaskResult': TaskResult.model_json_schema(),
 *          'TaskProgress': TaskProgress.model_json_schema(),
 *          'SidecarReadyPayload': SidecarReadyPayload.model_json_schema(),
 *        }
 *        print(json.dumps(schemas, indent=2))
 *      " > src/types/schema.json
 *   2. 运行此脚本：npx ts-node scripts/gen-types.ts
 */

import * as fs from "fs";
import * as path from "path";

const SCHEMA_PATH = path.resolve("src/types/schema.json");
const OUTPUT_PATH = path.resolve("src/types/generated.ts");

// 递归地将 JSON Schema 节点解析转换为 TypeScript 类型文本
function jsonTypeToTs(schema: Record<string, unknown>, defs: Record<string, unknown> = {}): string {
  if (schema.$ref) {
    const ref = (schema.$ref as string).replace("#/$defs/", "");
    return ref;
  }
  const type = schema.type as string | undefined;
  if (type === "string") return "string";
  if (type === "number" || type === "integer") return "number";
  if (type === "boolean") return "boolean";
  if (type === "null") return "null";
  if (type === "array") {
    const items = schema.items as Record<string, unknown> | undefined;
    return items ? `Array<${jsonTypeToTs(items, defs)}>` : "Array<unknown>";
  }
  if (type === "object" || schema.properties) {
    const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
    const required = (schema.required as string[]) ?? [];
    if (!props) return "Record<string, unknown>";
    const fields = Object.entries(props).map(([key, val]) => {
      const isRequired = required.includes(key);
      return `  ${key}${isRequired ? "" : "?"}: ${jsonTypeToTs(val, defs)};`;
    });
    return `{\n${fields.join("\n")}\n}`;
  }
  if (schema.anyOf || schema.oneOf) {
    const variants = ((schema.anyOf ?? schema.oneOf) as Record<string, unknown>[]);
    return variants.map((v) => jsonTypeToTs(v, defs)).join(" | ");
  }
  if (schema.const !== undefined) {
    return JSON.stringify(schema.const);
  }
  return "unknown";
}

// 遍历生成所有模型的 TypeScript Interface / Type 声明
function generateTypes(schemas: Record<string, Record<string, unknown>>): string {
  const lines: string[] = [
    "// 自动生成的类型声明文件 — 请勿手动修改！",
    "// 生成命令: node scripts/gen-types.ts",
    "",
  ];

  for (const [name, schema] of Object.entries(schemas)) {
    const defs = (schema.$defs ?? {}) as Record<string, unknown>;
    const body = jsonTypeToTs(schema, defs);
    if (body.startsWith("{")) {
      lines.push(`export interface ${name} ${body}`, "");
    } else {
      lines.push(`export type ${name} = ${body};`, "");
    }
  }

  return lines.join("\n");
}

// 检查是否存在 schema 数据源
if (fs.existsSync(SCHEMA_PATH)) {
  const raw = fs.readFileSync(SCHEMA_PATH, "utf-8");
  const schemas = JSON.parse(raw) as Record<string, Record<string, unknown>>;
  const output = generateTypes(schemas);
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, output, "utf-8");
  console.log(`✓ 成功生成: ${OUTPUT_PATH}`);
} else {
  console.warn(`⚠ 未在指定路径找到 schema.json: ${SCHEMA_PATH}`);
  console.warn("  请先按照此脚本顶部的 Python 指令导出 Schema 结构源。");
  
  // 兜底写入占位声明
  const placeholder = [
    "// 自动生成的占位类型声明 — 请勿手动修改！",
    "// 请先按照 scripts/gen-types.ts 头部的说明运行 Python 命令导出 schema.json 以覆盖此文件。",
    "",
    "export type RpcRequest = Record<string, unknown>;",
    "export type RpcResponse = Record<string, unknown>;",
    "export type RpcNotification = Record<string, unknown>;",
    "export type TaskStatus = Record<string, unknown>;",
    "export type TaskResult = Record<string, unknown>;",
    "export type TaskProgress = Record<string, unknown>;",
    "export type SidecarReadyPayload = Record<string, unknown>;",
    "",
  ].join("\n");
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, placeholder, "utf-8");
  console.log(`  已为您自动生成了占位类型文件：${OUTPUT_PATH}`);
}
