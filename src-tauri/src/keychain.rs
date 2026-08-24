use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use keyring::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::error::{DesktopError, DesktopResult};
use crate::settings::write_json_atomic;

const SERVICE: &str = "com.springopen.dshdesktop.credentials";
const DATA_DIR_ENV: &str = "DSH_DESKTOP_DATA_DIR";
const SESSION_NAMESPACE: &str = "session";
const SESSION_KEY: &str = "runtime";

pub struct RuntimeSession {
    token: String,
}

impl RuntimeSession {
    pub fn create() -> DesktopResult<Self> {
        let token = Uuid::new_v4().to_string();
        set_secret(SESSION_NAMESPACE, SESSION_KEY, &token)?;
        Ok(Self { token })
    }

    pub fn token(&self) -> &str {
        &self.token
    }
}

impl Drop for RuntimeSession {
    fn drop(&mut self) {
        let _ = delete_secret(SESSION_NAMESPACE, SESSION_KEY);
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Operation {
    GetRef,
    DescribeRef,
    SetRef,
    DeleteRef,
    GetRecord,
    DescribeRecord,
    ListRecords,
    SetRecord,
    DeleteRecord,
}

#[derive(Debug, Deserialize)]
struct HelperRequest {
    operation: Operation,
    key: Option<String>,
    value: Option<Value>,
    session: Option<String>,
}

#[derive(Debug, Default, Deserialize, Serialize)]
struct CredentialIndex {
    version: u8,
    records: BTreeMap<String, String>,
}

impl CredentialIndex {
    fn load(data_dir: &Path) -> DesktopResult<(Self, PathBuf)> {
        fs::create_dir_all(data_dir)?;
        let path = data_dir.join("credential-index.json");
        let index = match fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => Self {
                version: 1,
                records: BTreeMap::new(),
            },
            Err(error) => return Err(error.into()),
        };
        Ok((index, path))
    }
}

trait SecretStore {
    fn get(&self, namespace: &str, key: &str) -> DesktopResult<Option<String>>;
    fn set(&self, namespace: &str, key: &str, value: &str) -> DesktopResult<()>;
    fn delete(&self, namespace: &str, key: &str) -> DesktopResult<()>;
}

struct SystemSecretStore;

impl SecretStore for SystemSecretStore {
    fn get(&self, namespace: &str, key: &str) -> DesktopResult<Option<String>> {
        get_secret(namespace, key)
    }

    fn set(&self, namespace: &str, key: &str, value: &str) -> DesktopResult<()> {
        set_secret(namespace, key, value)
    }

    fn delete(&self, namespace: &str, key: &str) -> DesktopResult<()> {
        delete_secret(namespace, key)
    }
}

pub fn run() -> i32 {
    let stdin = io::stdin();
    let mut line = String::new();
    let response = match stdin.lock().read_line(&mut line) {
        Ok(0) => error_response("empty-request", "keychain helper received no request"),
        Ok(_) => match serde_json::from_str::<HelperRequest>(&line) {
            Ok(request) => match execute(request) {
                Ok(value) => json!({ "ok": true, "value": value }),
                Err(error) => error_response("keychain-failed", &error.to_string()),
            },
            Err(_) => error_response("invalid-request", "keychain helper request is invalid"),
        },
        Err(_) => error_response("read-failed", "keychain helper could not read its request"),
    };
    let mut stdout = io::stdout().lock();
    if serde_json::to_writer(&mut stdout, &response).is_err() || stdout.write_all(b"\n").is_err() {
        return 2;
    }
    if response.get("ok").and_then(Value::as_bool) == Some(true) {
        0
    } else {
        1
    }
}

fn execute(request: HelperRequest) -> DesktopResult<Value> {
    let data_dir = env::var_os(DATA_DIR_ENV)
        .map(PathBuf::from)
        .ok_or_else(|| DesktopError::Keychain(format!("{DATA_DIR_ENV} is not configured")))?;
    let store = SystemSecretStore;
    validate_session(&store, &request)?;
    execute_with(&store, &data_dir, request)
}

fn validate_session(store: &dyn SecretStore, request: &HelperRequest) -> DesktopResult<()> {
    let provided = request.session.as_deref().unwrap_or_default();
    let expected = store
        .get(SESSION_NAMESPACE, SESSION_KEY)?
        .unwrap_or_default();
    if provided.is_empty() || !constant_time_eq(provided.as_bytes(), expected.as_bytes()) {
        return Err(DesktopError::Keychain(
            "credential helper session is not authorized".to_owned(),
        ));
    }
    Ok(())
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn execute_with(
    store: &dyn SecretStore,
    data_dir: &Path,
    request: HelperRequest,
) -> DesktopResult<Value> {
    match request.operation {
        Operation::GetRef => store
            .get("ref", &require_key(request.key)?)
            .map(|value| json!(value)),
        Operation::DescribeRef => {
            let configured = store.get("ref", &require_key(request.key)?)?.is_some();
            Ok(json!({ "configured": configured }))
        }
        Operation::SetRef => {
            let key = require_key(request.key)?;
            let value = require_string(request.value)?;
            store.set("ref", &key, &value)?;
            Ok(Value::Null)
        }
        Operation::DeleteRef => {
            store.delete("ref", &require_key(request.key)?)?;
            Ok(Value::Null)
        }
        Operation::GetRecord => {
            let value = store
                .get("record", &require_key(request.key)?)?
                .map(|stored| serde_json::from_str::<Value>(&stored))
                .transpose()?;
            Ok(json!(value))
        }
        Operation::DescribeRecord => {
            let key = require_key(request.key)?;
            let value = store
                .get("record", &key)?
                .map(|stored| serde_json::from_str::<Value>(&stored))
                .transpose()?;
            let kind = value
                .as_ref()
                .and_then(|record| record.get("kind"))
                .and_then(Value::as_str);
            Ok(json!({ "configured": value.is_some(), "kind": kind }))
        }
        Operation::ListRecords => {
            let (index, _) = CredentialIndex::load(data_dir)?;
            let records = index
                .records
                .into_iter()
                .map(|(key, kind)| json!({ "key": key, "kind": kind }))
                .collect::<Vec<_>>();
            Ok(json!({ "records": records }))
        }
        Operation::SetRecord => {
            let key = require_key(request.key)?;
            let value = request
                .value
                .ok_or_else(|| DesktopError::Keychain("record value is required".to_owned()))?;
            let kind = value
                .get("kind")
                .and_then(Value::as_str)
                .filter(|kind| matches!(*kind, "api-key" | "grant"))
                .ok_or_else(|| {
                    DesktopError::Keychain("record kind must be api-key or grant".to_owned())
                })?;
            let previous = store.get("record", &key)?;
            store.set("record", &key, &serde_json::to_string(&value)?)?;
            let (mut index, path) = CredentialIndex::load(data_dir)?;
            index.records.insert(key.clone(), kind.to_owned());
            if let Err(error) = write_json_atomic(&path, &index) {
                match previous {
                    Some(value) => store.set("record", &key, &value)?,
                    None => store.delete("record", &key)?,
                }
                return Err(error);
            }
            Ok(Value::Null)
        }
        Operation::DeleteRecord => {
            let key = require_key(request.key)?;
            let previous = store.get("record", &key)?;
            let (mut index, path) = CredentialIndex::load(data_dir)?;
            let previous_kind = index.records.remove(&key);
            write_json_atomic(&path, &index)?;
            if let Err(error) = store.delete("record", &key) {
                if let Some(kind) = previous_kind {
                    index.records.insert(key.clone(), kind);
                }
                write_json_atomic(&path, &index)?;
                if let Some(value) = previous {
                    store.set("record", &key, &value)?;
                }
                return Err(error);
            }
            Ok(Value::Null)
        }
    }
}

fn account(namespace: &str, key: &str) -> String {
    format!("{namespace}.{}", URL_SAFE_NO_PAD.encode(key.as_bytes()))
}

fn entry(namespace: &str, key: &str) -> DesktopResult<Entry> {
    Entry::new(SERVICE, &account(namespace, key))
        .map_err(|error| DesktopError::Keychain(safe_keyring_error(&error)))
}

fn get_secret(namespace: &str, key: &str) -> DesktopResult<Option<String>> {
    match entry(namespace, key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(DesktopError::Keychain(safe_keyring_error(&error))),
    }
}

fn set_secret(namespace: &str, key: &str, value: &str) -> DesktopResult<()> {
    if value.is_empty() {
        return Err(DesktopError::Keychain(
            "empty credentials are not allowed".to_owned(),
        ));
    }
    entry(namespace, key)?
        .set_password(value)
        .map_err(|error| DesktopError::Keychain(safe_keyring_error(&error)))
}

fn delete_secret(namespace: &str, key: &str) -> DesktopResult<()> {
    match entry(namespace, key)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(error) => Err(DesktopError::Keychain(safe_keyring_error(&error))),
    }
}

fn require_key(key: Option<String>) -> DesktopResult<String> {
    key.filter(|value| !value.is_empty())
        .ok_or_else(|| DesktopError::Keychain("credential address is required".to_owned()))
}

fn require_string(value: Option<Value>) -> DesktopResult<String> {
    value
        .and_then(|value| value.as_str().map(str::to_owned))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| DesktopError::Keychain("non-empty credential value is required".to_owned()))
}

fn safe_keyring_error(error: &KeyringError) -> String {
    match error {
        KeyringError::NoEntry => "credential is not configured".to_owned(),
        _ => "operating-system keychain is unavailable".to_owned(),
    }
}

fn error_response(code: &str, message: &str) -> Value {
    json!({ "ok": false, "error": { "code": code, "message": message } })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MemorySecretStore(Mutex<BTreeMap<String, String>>);

    impl SecretStore for MemorySecretStore {
        fn get(&self, namespace: &str, key: &str) -> DesktopResult<Option<String>> {
            Ok(self
                .0
                .lock()
                .unwrap()
                .get(&format!("{namespace}:{key}"))
                .cloned())
        }

        fn set(&self, namespace: &str, key: &str, value: &str) -> DesktopResult<()> {
            self.0
                .lock()
                .unwrap()
                .insert(format!("{namespace}:{key}"), value.to_owned());
            Ok(())
        }

        fn delete(&self, namespace: &str, key: &str) -> DesktopResult<()> {
            self.0.lock().unwrap().remove(&format!("{namespace}:{key}"));
            Ok(())
        }
    }

    struct UnavailableSecretStore;

    impl SecretStore for UnavailableSecretStore {
        fn get(&self, _namespace: &str, _key: &str) -> DesktopResult<Option<String>> {
            Err(DesktopError::Keychain(
                "operating-system keychain is unavailable".to_owned(),
            ))
        }

        fn set(&self, _namespace: &str, _key: &str, _value: &str) -> DesktopResult<()> {
            Err(DesktopError::Keychain(
                "operating-system keychain is unavailable".to_owned(),
            ))
        }

        fn delete(&self, _namespace: &str, _key: &str) -> DesktopResult<()> {
            Err(DesktopError::Keychain(
                "operating-system keychain is unavailable".to_owned(),
            ))
        }
    }

    fn request(operation: Operation, key: &str, value: Option<Value>) -> HelperRequest {
        HelperRequest {
            operation,
            key: Some(key.to_owned()),
            value,
            session: None,
        }
    }

    fn temporary_data_dir(name: &str) -> PathBuf {
        let path = env::temp_dir().join(format!("dsh-desktop-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        path
    }

    #[test]
    fn account_does_not_expose_the_original_key() {
        let encoded = account("ref", "DEEPSEEK_API_KEY");
        assert!(!encoded.contains("DEEPSEEK_API_KEY"));
        assert!(encoded.starts_with("ref."));
    }

    #[test]
    fn rejects_an_unauthorized_helper_session() {
        let store = MemorySecretStore::default();
        store
            .set(SESSION_NAMESPACE, SESSION_KEY, "expected-session")
            .unwrap();
        let mut request = request(Operation::DescribeRef, "DEEPSEEK_API_KEY", None);
        request.session = Some("unexpected-session".to_owned());
        assert!(validate_session(&store, &request).is_err());
        request.session = Some("expected-session".to_owned());
        assert!(validate_session(&store, &request).is_ok());
    }

    #[test]
    fn supports_refs_api_keys_grants_and_record_enumeration_without_plaintext_index_data() {
        let store = MemorySecretStore::default();
        let data_dir = temporary_data_dir("keychain-contract");

        execute_with(
            &store,
            &data_dir,
            request(
                Operation::SetRef,
                "DEEPSEEK_API_KEY",
                Some(json!("secret-ref")),
            ),
        )
        .unwrap();
        assert_eq!(
            execute_with(
                &store,
                &data_dir,
                request(Operation::GetRef, "DEEPSEEK_API_KEY", None)
            )
            .unwrap(),
            json!("secret-ref")
        );

        execute_with(
            &store,
            &data_dir,
            request(
                Operation::SetRecord,
                "provider:primary",
                Some(json!({ "kind": "api-key", "apiKey": "secret-api-key" })),
            ),
        )
        .unwrap();
        execute_with(&store, &data_dir, request(
            Operation::SetRecord,
            "provider:oauth",
            Some(json!({ "kind": "grant", "accessToken": "secret-oauth-token", "expiresAt": 4_102_444_800_i64 })),
        )).unwrap();

        let records = execute_with(
            &store,
            &data_dir,
            request(Operation::ListRecords, "ignored", None),
        )
        .unwrap();
        assert_eq!(records["records"].as_array().unwrap().len(), 2);
        let index = fs::read_to_string(data_dir.join("credential-index.json")).unwrap();
        assert!(!index.contains("secret-api-key"));
        assert!(!index.contains("secret-oauth-token"));

        execute_with(
            &store,
            &data_dir,
            request(Operation::DeleteRecord, "provider:primary", None),
        )
        .unwrap();
        assert_eq!(
            execute_with(
                &store,
                &data_dir,
                request(Operation::GetRecord, "provider:primary", None)
            )
            .unwrap(),
            Value::Null
        );
        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn keychain_failure_is_explicit_and_never_creates_a_plaintext_fallback() {
        let data_dir = temporary_data_dir("keychain-unavailable");
        let error = execute_with(
            &UnavailableSecretStore,
            &data_dir,
            request(
                Operation::SetRef,
                "DEEPSEEK_API_KEY",
                Some(json!("must-not-be-written")),
            ),
        )
        .unwrap_err();
        assert!(error.to_string().contains("keychain is unavailable"));
        assert!(!data_dir.join(".credentials.yaml").exists());
        assert!(!data_dir.join(".env").exists());
    }
}
