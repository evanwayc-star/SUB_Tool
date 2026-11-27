//! The owning Electron process supplies credentials through stdin, never argv or disk.
use serde::Deserialize;
use std::sync::OnceLock;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    OpenAI,
    Gemini,
}

impl Provider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OpenAI => "openai",
            Self::Gemini => "gemini",
        }
    }
    pub fn display_name(self) -> &'static str {
        match self {
            Self::OpenAI => "OpenAI",
            Self::Gemini => "Google Gemini",
        }
    }
}

static API_KEY: OnceLock<String> = OnceLock::new();

pub fn set_api_key(key: String) -> Result<(), String> {
    API_KEY
        .set(key)
        .map_err(|_| "同一行程只接受一個辨識工作。".to_string())
}

pub fn load_api_key_with_source(_: Provider) -> (Option<String>, String) {
    (API_KEY.get().cloned(), "SUB Tool".to_string())
}

pub fn redact_secrets(message: &str, secrets: &[&str]) -> String {
    let mut safe = message.to_string();
    for secret in secrets {
        if !secret.is_empty() {
            safe = safe.replace(secret, "[REDACTED]");
        }
    }
    if let Some(secret) = API_KEY.get() {
        if !secret.is_empty() {
            safe = safe.replace(secret, "[REDACTED]");
        }
    }
    safe
}
