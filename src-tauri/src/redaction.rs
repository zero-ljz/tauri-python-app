use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

const REDACTED: &str = "[REDACTED]";
const SENSITIVE_PARTS: [&str; 10] = [
    "password",
    "passwd",
    "secret",
    "token",
    "authorization",
    "cookie",
    "api_key",
    "apikey",
    "private_key",
    "credential",
];

static BEARER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\bbearer\s+[a-z0-9._~+/=-]+").expect("valid bearer redaction regex")
});
static ASSIGNMENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(password|passwd|secret|token|authorization|api[_-]?key|credential)\s*[:=]\s*([^\s,;]+)",
    )
    .expect("valid assignment redaction regex")
});

pub fn is_sensitive_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase().replace('-', "_");
    SENSITIVE_PARTS.iter().any(|part| normalized.contains(part))
}

pub fn redact_text(value: &str) -> String {
    let bearer_redacted = BEARER.replace_all(value, format!("Bearer {REDACTED}"));
    ASSIGNMENT
        .replace_all(&bearer_redacted, |captures: &regex::Captures<'_>| {
            format!("{}={REDACTED}", &captures[1])
        })
        .into_owned()
}

pub fn safe_preview(value: &str, max_chars: usize) -> String {
    let redacted = redact_text(value);
    if redacted.chars().count() <= max_chars {
        return redacted;
    }
    let prefix: String = redacted.chars().take(max_chars).collect();
    format!("{prefix}… ({} chars)", redacted.chars().count())
}

pub fn redact_value(value: &Value) -> Value {
    redact_value_at_depth(value, 0)
}

fn redact_value_at_depth(value: &Value, depth: usize) -> Value {
    if depth > 12 {
        return Value::String("[TRUNCATED]".to_string());
    }
    match value {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| {
                    let value = if is_sensitive_key(key) {
                        Value::String(REDACTED.to_string())
                    } else {
                        redact_value_at_depth(value, depth + 1)
                    };
                    (key.clone(), value)
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| redact_value_at_depth(item, depth + 1))
                .collect(),
        ),
        Value::String(value) => Value::String(redact_text(value)),
        _ => value.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nested_secrets_and_bearer_tokens_are_redacted() {
        let value = serde_json::json!({
            "nested": {"apiToken": "secret-value"},
            "message": "Authorization: Bearer abc.def"
        });
        let redacted = redact_value(&value);
        assert_eq!(redacted["nested"]["apiToken"], REDACTED);
        assert!(!redacted["message"]
            .as_str()
            .unwrap_or_default()
            .contains("abc.def"));
    }
}
