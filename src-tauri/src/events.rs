/// Convert a dotted backend method into a Tauri-compatible event name.
/// Tauri event names permit '/', but not '.'.
pub fn backend_event_name(method: &str) -> String {
    format!("backend://{}", method.replace('.', "/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dotted_methods_become_valid_event_paths() {
        assert_eq!(
            backend_event_name("task.progress"),
            "backend://task/progress"
        );
    }
}
