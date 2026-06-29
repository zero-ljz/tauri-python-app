use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcErrorPayload {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Debug, Serialize)]
pub struct JsonRpcRequest<'a> {
    pub jsonrpc: &'static str,
    pub id: u64,
    pub method: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcNotification {
    pub jsonrpc: String,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

#[derive(Debug)]
pub enum InboundMessage {
    Response {
        id: u64,
        result: Option<Value>,
        error: Option<JsonRpcErrorPayload>,
    },
    Notification(JsonRpcNotification),
    Request {
        id: Value,
        method: String,
        params: Option<Value>,
    },
}

pub fn parse_inbound(line: &str) -> Result<InboundMessage, String> {
    let value: Value = serde_json::from_str(line).map_err(|error| error.to_string())?;
    let object = value
        .as_object()
        .ok_or_else(|| "JSON-RPC message must be an object".to_string())?;

    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err("JSON-RPC version must be '2.0'".to_string());
    }

    let has_id = object.contains_key("id");
    let has_method = object.contains_key("method");
    let is_response = has_id && (object.contains_key("result") || object.contains_key("error"));

    if is_response {
        let id = object
            .get("id")
            .and_then(Value::as_u64)
            .ok_or_else(|| "JSON-RPC response id must be a u64".to_string())?;
        let error = match object.get("error") {
            Some(value) => Some(
                serde_json::from_value(value.clone())
                    .map_err(|error| format!("invalid JSON-RPC error: {error}"))?,
            ),
            None => None,
        };
        return Ok(InboundMessage::Response {
            id,
            result: object.get("result").cloned(),
            error,
        });
    }

    if has_method && !has_id {
        return Ok(InboundMessage::Notification(
            serde_json::from_value(value)
                .map_err(|error| format!("invalid JSON-RPC notification: {error}"))?,
        ));
    }

    if has_method && has_id {
        return Ok(InboundMessage::Request {
            id: object.get("id").cloned().unwrap_or(Value::Null),
            method: object
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            params: object.get("params").cloned(),
        });
    }

    Err("unsupported JSON-RPC message shape".to_string())
}
