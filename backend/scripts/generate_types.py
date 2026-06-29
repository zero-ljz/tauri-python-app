from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from pydantic import BaseModel

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from sidecar.schemas import TYPE_MODELS

SCHEMA_OUT = ROOT / "src" / "generated" / "sidecar.schema.json"
TYPES_OUT = ROOT / "src" / "generated" / "sidecarTypes.ts"


def bundle_schema(models: tuple[type[BaseModel], ...]) -> dict[str, Any]:
    defs: dict[str, Any] = {}
    for model in models:
        schema = model.model_json_schema(ref_template="#/$defs/{model}")
        nested_defs = schema.pop("$defs", {})
        defs.update(nested_defs)
        defs[model.__name__] = schema
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "sidecar.schema.json",
        "title": "Sidecar Schema Bundle",
        "$defs": defs,
    }


def ref_name(ref: str) -> str:
    return ref.rsplit("/", 1)[-1]


def literal(value: Any) -> str:
    if value is None:
        return "null"
    return json.dumps(value, ensure_ascii=False)


def property_name(name: str) -> str:
    return name if name.replace("_", "").isalnum() and not name[0].isdigit() else literal(name)


def schema_to_ts(schema: dict[str, Any]) -> str:
    if "$ref" in schema:
        return ref_name(schema["$ref"])
    if "const" in schema:
        return literal(schema["const"])
    if "enum" in schema:
        return " | ".join(literal(value) for value in schema["enum"])
    if "anyOf" in schema:
        return " | ".join(schema_to_ts(item) for item in schema["anyOf"])
    if "oneOf" in schema:
        return " | ".join(schema_to_ts(item) for item in schema["oneOf"])
    if "allOf" in schema:
        return " & ".join(schema_to_ts(item) for item in schema["allOf"])

    schema_type = schema.get("type")
    if isinstance(schema_type, list):
        return " | ".join(schema_to_ts({**schema, "type": item}) for item in schema_type)
    if schema_type == "string":
        return "string"
    if schema_type in ("integer", "number"):
        return "number"
    if schema_type == "boolean":
        return "boolean"
    if schema_type == "null":
        return "null"
    if schema_type == "array":
        return f"{schema_to_ts(schema.get('items', {}))}[]"
    if schema_type == "object" or "properties" in schema:
        properties = schema.get("properties", {})
        additional = schema.get("additionalProperties", True)
        if not properties:
            if isinstance(additional, dict):
                return f"Record<string, {schema_to_ts(additional)}>"
            return "Record<string, unknown>"
        required = set(schema.get("required", []))
        lines = ["{"]
        for key, value in properties.items():
            optional = "" if key in required else "?"
            lines.append(f"  {property_name(key)}{optional}: {schema_to_ts(value)};")
        if isinstance(additional, dict):
            lines.append(f"  [key: string]: {schema_to_ts(additional)};")
        lines.append("}")
        return "\n".join(lines)
    return "unknown"


def emit_types(schema_bundle: dict[str, Any]) -> str:
    lines = [
        "/* eslint-disable */",
        "// Generated from backend/sidecar/schemas.py. Do not edit by hand.",
        "",
    ]
    for name, schema in schema_bundle["$defs"].items():
        description = schema.get("description")
        if description:
            lines.append(f"/** {description} */")
        if schema.get("type") == "object" or "properties" in schema:
            lines.append(f"export interface {name} {schema_to_ts(schema)}")
        else:
            lines.append(f"export type {name} = {schema_to_ts(schema)};")
        lines.append("")
    return "\n".join(lines)


def main() -> None:
    schema = bundle_schema(TYPE_MODELS)
    SCHEMA_OUT.parent.mkdir(parents=True, exist_ok=True)
    SCHEMA_OUT.write_text(json.dumps(schema, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    TYPES_OUT.write_text(emit_types(schema), encoding="utf-8")
    print(f"generated {SCHEMA_OUT.relative_to(ROOT)}")
    print(f"generated {TYPES_OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
