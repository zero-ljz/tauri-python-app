use log::{debug, warn};
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, oneshot};

pub(super) const MAX_PROTOCOL_LINE_BYTES: usize = 4 * 1024 * 1024;
pub(super) const MAX_LOG_LINE_BYTES: usize = 64 * 1024;

/// A queued stdin frame plus an acknowledgement completed by the actual writer.
pub struct StdinMessage {
    pub bytes: Vec<u8>,
    pub written: oneshot::Sender<std::result::Result<(), String>>,
}

/// Shared writer endpoint. `None` means that no writable process is available.
pub type StdinTx = Arc<Mutex<Option<mpsc::Sender<StdinMessage>>>>;

/// Stateful newline decoder that stays synchronized after oversized frames.
pub(super) struct NdjsonDecoder {
    buffer: Vec<u8>,
    max_line_bytes: usize,
    strict_utf8: bool,
    discarding_oversized_frame: bool,
}

impl NdjsonDecoder {
    pub(super) fn protocol(max_line_bytes: usize) -> Self {
        Self::new(max_line_bytes, true)
    }

    pub(super) fn logs(max_line_bytes: usize) -> Self {
        Self::new(max_line_bytes, false)
    }

    fn new(max_line_bytes: usize, strict_utf8: bool) -> Self {
        Self {
            buffer: Vec::new(),
            max_line_bytes,
            strict_utf8,
            discarding_oversized_frame: false,
        }
    }

    pub(super) fn push(&mut self, mut chunk: &[u8]) -> Vec<String> {
        let mut lines = Vec::new();

        while !chunk.is_empty() {
            if self.discarding_oversized_frame {
                let Some(newline) = chunk.iter().position(|byte| *byte == b'\n') else {
                    return lines;
                };
                chunk = &chunk[newline + 1..];
                self.discarding_oversized_frame = false;
                continue;
            }

            if let Some(newline) = chunk.iter().position(|byte| *byte == b'\n') {
                let segment = &chunk[..newline];
                if self.buffer.len().saturating_add(segment.len()) > self.max_line_bytes {
                    warn!(
                        "[BackendRuntime] 丢弃超过 {} 字节的输出帧",
                        self.max_line_bytes
                    );
                    self.buffer.clear();
                } else {
                    self.buffer.extend_from_slice(segment);
                    self.finish_frame(&mut lines);
                }
                chunk = &chunk[newline + 1..];
                continue;
            }

            if self.buffer.len().saturating_add(chunk.len()) > self.max_line_bytes {
                warn!(
                    "[BackendRuntime] 丢弃未终止且超过 {} 字节的输出帧",
                    self.max_line_bytes
                );
                self.buffer.clear();
                self.discarding_oversized_frame = true;
            } else {
                self.buffer.extend_from_slice(chunk);
            }
            break;
        }

        lines
    }

    pub(super) fn finish(&mut self) -> Option<String> {
        if self.discarding_oversized_frame || self.buffer.is_empty() {
            self.buffer.clear();
            return None;
        }

        let mut lines = Vec::with_capacity(1);
        self.finish_frame(&mut lines);
        lines.pop()
    }

    fn finish_frame(&mut self, lines: &mut Vec<String>) {
        if self.buffer.last() == Some(&b'\r') {
            self.buffer.pop();
        }
        if self.buffer.is_empty() {
            return;
        }

        let bytes = std::mem::take(&mut self.buffer);
        if self.strict_utf8 {
            match String::from_utf8(bytes) {
                Ok(line) => lines.push(line),
                Err(error) => warn!("[BackendRuntime] 丢弃非 UTF-8 协议帧: {}", error),
            }
        } else {
            lines.push(String::from_utf8_lossy(&bytes).into_owned());
        }
    }
}

pub(super) fn handle_stdout_line(
    line: &str,
    on_message: &Arc<dyn Fn(Value) + Send + Sync>,
    source: &str,
) {
    debug!("[backend stdout ({})] {}", source, line);
    match serde_json::from_str::<Value>(line) {
        Ok(message) => (on_message)(message),
        Err(error) => warn!(
            "[BackendRuntime] JSON 解析失败: {} — 原始数据: {}",
            error, line
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oversized_frame_is_discarded_through_its_newline() {
        let mut decoder = NdjsonDecoder::protocol(4);
        assert!(decoder.push(b"12345").is_empty());
        let lines = decoder.push(b"tail\nok\n");
        assert_eq!(lines, vec!["ok"]);
    }

    #[test]
    fn complete_oversized_frame_does_not_hide_the_next_frame() {
        let mut decoder = NdjsonDecoder::protocol(4);
        let lines = decoder.push(b"12345\nok\n");
        assert_eq!(lines, vec!["ok"]);
    }

    #[test]
    fn protocol_frames_require_strict_utf8() {
        let mut decoder = NdjsonDecoder::protocol(64);
        let lines = decoder.push(b"{\"bad\":\"\xff\"}\n{\"ok\":true}\n");
        assert_eq!(lines, vec!["{\"ok\":true}"]);
    }

    #[test]
    fn split_frames_are_reassembled() {
        let mut decoder = NdjsonDecoder::protocol(64);
        assert!(decoder.push(b"{\"ok\":").is_empty());
        assert_eq!(decoder.push(b"true}\r\n"), vec!["{\"ok\":true}"]);
    }
}
