from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

try:
    from ._python_env import reexec_with_local_venv
except ImportError:
    from _python_env import reexec_with_local_venv


ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = ROOT / "src" / "types" / "schema.json"
OUTPUT_PATH = ROOT / "src" / "types" / "generated.ts"
TS_IDENTIFIER = re.compile(r"^[A-Za-z_$][A-Za-z0-9_$]*$")


def ts_property(name: str) -> str:
    return name if TS_IDENTIFIER.fullmatch(name) else json.dumps(name)


if __name__ == "__main__":
    reexec_with_local_venv(ROOT, "BACKEND_TYPES_REEXEC", (ROOT / ".venv", ROOT / "venv"))

sys.path.insert(0, str(ROOT))

from pydantic import BaseModel, TypeAdapter  # noqa: E402

import backend.handlers.echo  # noqa: F401, E402
import backend.handlers.tasks  # noqa: F401, E402
from backend.dispatcher import NO_PARAMS  # noqa: E402
from backend.models import (  # noqa: E402
    BackendReadyPayload,
    LogPayload,
    RpcError,
    RpcNotification,
    RpcRequest,
    RpcResponse,
    TaskCancelParams,
    TaskCancelResult,
    TaskGetParams,
    TaskIdResult,
    TaskProgress,
    TaskRemoveResult,
    TaskSnapshot,
)
from backend.rpc import rpc  # noqa: E402

MODELS = {
    "RpcError": RpcError,
    "RpcRequest": RpcRequest,
    "RpcResponse": RpcResponse,
    "RpcNotification": RpcNotification,
    "TaskProgress": TaskProgress,
    "TaskSnapshot": TaskSnapshot,
    "TaskCancelResult": TaskCancelResult,
    "TaskCancelParams": TaskCancelParams,
    "TaskGetParams": TaskGetParams,
    "TaskRemoveResult": TaskRemoveResult,
    "TaskIdResult": TaskIdResult,
    "BackendReadyPayload": BackendReadyPayload,
    "LogPayload": LogPayload,
}

IDENT_RE = re.compile(r"^[A-Za-z_$][A-Za-z0-9_$]*$")


def ts_prop_name(name: str) -> str:
    return name if IDENT_RE.match(name) else json.dumps(name, ensure_ascii=False)


def ref_name(ref: str) -> str:
    return ref.rsplit("/", 1)[-1]


def literal(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def schema_to_ts(schema: dict[str, Any]) -> str:
    if "$ref" in schema:
        return ref_name(str(schema["$ref"]))

    if "const" in schema:
        return literal(schema["const"])

    if "enum" in schema:
        return " | ".join(literal(item) for item in schema["enum"])

    if "anyOf" in schema or "oneOf" in schema:
        variants = schema.get("anyOf") or schema.get("oneOf") or []
        return " | ".join(schema_to_ts(variant) for variant in variants)

    if "allOf" in schema:
        variants = schema.get("allOf") or []
        return " & ".join(schema_to_ts(variant) for variant in variants)

    schema_type = schema.get("type")
    if isinstance(schema_type, list):
        return " | ".join(schema_to_ts({**schema, "type": item}) for item in schema_type)

    if schema_type == "string":
        return "string"
    if schema_type in {"number", "integer"}:
        return "number"
    if schema_type == "boolean":
        return "boolean"
    if schema_type == "null":
        return "null"
    if schema_type == "array":
        items = schema.get("items")
        return f"Array<{schema_to_ts(items)}>" if isinstance(items, dict) else "Array<unknown>"

    properties = schema.get("properties")
    if schema_type == "object" or isinstance(properties, dict):
        if isinstance(properties, dict):
            required = set(schema.get("required", []))
            fields = []
            for key, value in properties.items():
                optional = "" if key in required else "?"
                fields.append(f"  {ts_prop_name(key)}{optional}: {schema_to_ts(value)};")
            return "{\n" + "\n".join(fields) + "\n}"

        additional = schema.get("additionalProperties")
        if isinstance(additional, dict):
            return f"Record<string, {schema_to_ts(additional)}>"
        return "Record<string, unknown>"

    return "unknown"


def collect_defs(schemas: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    defs: dict[str, dict[str, Any]] = {}
    for schema in schemas.values():
        for name, value in schema.get("$defs", {}).items():
            if name not in schemas and isinstance(value, dict):
                defs[name] = value
    return defs


def emit_type(name: str, schema: dict[str, Any]) -> str:
    body = schema_to_ts(schema)
    if body.startswith("{"):
        return f"export interface {name} {body}\n"
    return f"export type {name} = {body};\n"


def annotation_to_ts(annotation: Any) -> str:
    if annotation is NO_PARAMS:
        return "null"
    if annotation is Any:
        return "unknown"
    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        return annotation.__name__
    return schema_to_ts(TypeAdapter(annotation).json_schema())


RPC_METHODS = {
    spec.name: (annotation_to_ts(spec.params_type), annotation_to_ts(spec.result_type))
    for spec in rpc.specs
}


def main() -> None:
    schemas = {name: model.model_json_schema() for name, model in MODELS.items()}
    defs = collect_defs(schemas)

    SCHEMA_PATH.parent.mkdir(parents=True, exist_ok=True)
    SCHEMA_PATH.write_text(
        json.dumps(schemas, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )

    lines = [
        "// AUTO-GENERATED - do not edit by hand.",
        "// Generated by: python scripts/gen_types.py",
        "",
    ]

    for name in sorted(defs):
        lines.append(emit_type(name, defs[name]).rstrip())
        lines.append("")

    for name, schema in schemas.items():
        lines.append(emit_type(name, schema).rstrip())
        lines.append("")

    lines.append("export interface RpcMethodMap {")
    for method, (params_type, result_type) in RPC_METHODS.items():
        lines.append(
            f"  {ts_property(method)}: {{ params: {params_type}; result: {result_type} }};"
        )
    lines.extend(
        [
            "}",
            "",
            "export type RpcMethod = keyof RpcMethodMap;",
            'export type RpcParams<M extends RpcMethod> = RpcMethodMap[M]["params"];',
            'export type RpcResult<M extends RpcMethod> = RpcMethodMap[M]["result"];',
            "",
            "export const RPC_METHOD_PERMISSIONS = {",
        ]
    )
    for spec in rpc.specs:
        lines.append(f"  {ts_property(spec.name)}: {json.dumps(spec.permission)},")
    lines.extend(
        [
            "} as const satisfies Record<",
            "  RpcMethod,",
            '  "public" | "debug-only" | "requires-confirmation" | "dangerous"',
            ">;",
            "",
        ]
    )

    OUTPUT_PATH.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8", newline="\n")
    print(f"Generated {OUTPUT_PATH}")
    print(f"Generated {SCHEMA_PATH}")


if __name__ == "__main__":
    main()
