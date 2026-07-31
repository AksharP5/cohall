use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager, Runtime};

const KEYRING_SERVICE: &str = "com.cohall.desktop";
const KEYRING_USER: &str = "relay-session";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopConfig {
    pub relay_url: String,
    pub device_id: String,
    pub device_name: String,
    pub workspaces: Vec<String>,
}

impl DesktopConfig {
    pub fn validate(&self) -> Result<(), String> {
        if !(self.relay_url.starts_with("http://") || self.relay_url.starts_with("https://")) {
            return Err("Relay URL must start with http:// or https://".into());
        }
        if self.device_name.trim().is_empty() {
            return Err("Device name cannot be empty".into());
        }
        if self.workspaces.is_empty() {
            return Err("Add at least one workspace".into());
        }
        if self
            .workspaces
            .iter()
            .any(|workspace| !Path::new(workspace).is_absolute())
        {
            return Err("Workspace paths must be absolute".into());
        }
        Ok(())
    }
}

fn config_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("desktop.json"))
        .map_err(|error| error.to_string())
}

pub fn default_config(relay_url: String) -> DesktopConfig {
    let device_name = hostname::get()
        .ok()
        .and_then(|name| name.into_string().ok())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Cohall desktop".into());
    DesktopConfig {
        relay_url: relay_url.trim_end_matches('/').into(),
        device_id: uuid::Uuid::new_v4().to_string(),
        device_name,
        workspaces: Vec::new(),
    }
}

pub fn load<R: Runtime>(app: &AppHandle<R>) -> Result<Option<DesktopConfig>, String> {
    let path = config_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| format!("Could not read desktop settings: {error}"))
}

pub fn save<R: Runtime>(app: &AppHandle<R>, config: &DesktopConfig) -> Result<(), String> {
    config.validate()?;
    let path = config_path(app)?;
    if let Some(directory) = path.parent() {
        fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(config).map_err(|error| error.to_string())?;
    fs::write(path, bytes).map_err(|error| error.to_string())
}

fn keyring() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|error| error.to_string())
}

pub fn load_token() -> Result<Option<String>, String> {
    match keyring()?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!(
            "Could not read the relay session from the keychain: {error}"
        )),
    }
}

pub fn save_token(token: &str) -> Result<(), String> {
    if token.trim().is_empty() {
        return Err("Relay session token cannot be empty".into());
    }
    keyring()?
        .set_password(token)
        .map_err(|error| format!("Could not save the relay session in the keychain: {error}"))
}

pub fn delete_token() -> Result<(), String> {
    match keyring()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!(
            "Could not delete the relay session from the keychain: {error}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::DesktopConfig;

    fn config(workspaces: Vec<String>) -> DesktopConfig {
        DesktopConfig {
            relay_url: "https://relay.example.com".into(),
            device_id: "11111111-1111-4111-8111-111111111111".into(),
            device_name: "Test device".into(),
            workspaces,
        }
    }

    #[test]
    fn accepts_absolute_workspace_roots() {
        let workspace = if cfg!(windows) {
            r"C:\Users\test\dev"
        } else {
            "/home/test/dev"
        };
        assert_eq!(config(vec![workspace.into()]).validate(), Ok(()));
    }

    #[test]
    fn rejects_relative_workspace_roots() {
        assert_eq!(
            config(vec!["projects/cohall".into()]).validate(),
            Err("Workspace paths must be absolute".into())
        );
    }

    #[test]
    fn requires_an_explicit_workspace_root() {
        assert_eq!(
            config(Vec::new()).validate(),
            Err("Add at least one workspace".into())
        );
    }
}
