use std::collections::BTreeMap;
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::{DesktopError, DesktopResult};
use crate::settings::write_json_atomic;

const SERVICE: &str = "deepseek.desktop.credentials.vault.v1";
const DATA_DIR_ENV: &str = "DEEPSEEK_DESKTOP_DATA_DIR";
const SESSION_FILE: &str = "credential-session.json";
const VAULT_FILE: &str = "credential-vault.json";
const VAULT_KEY_FILE: &str = "credential-vault.key";
const VAULT_LOCK_FILE: &str = "credential-vault.lock";
const VAULT_KEY_LEN: usize = 32;
const VAULT_NONCE_LEN: usize = 24;

pub struct RuntimeSession {
    token: String,
    path: PathBuf,
    digest: String,
}

impl RuntimeSession {
    pub fn create(data_dir: &Path) -> DesktopResult<Self> {
        let token = Uuid::new_v4().to_string();
        let digest = session_digest(&token);
        let path = data_dir.join(SESSION_FILE);
        write_json_atomic(
            &path,
            &SessionAuthorization {
                version: 1,
                digest: digest.clone(),
            },
        )?;
        restrict_session_file(&path)?;
        Ok(Self {
            token,
            path,
            digest,
        })
    }

    pub fn token(&self) -> &str {
        &self.token
    }
}

impl Drop for RuntimeSession {
    fn drop(&mut self) {
        let current = read_session_authorization(&self.path).ok().flatten();
        if current.as_ref().is_some_and(|authorization| {
            constant_time_eq(authorization.digest.as_bytes(), self.digest.as_bytes())
        }) {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
struct SessionAuthorization {
    version: u8,
    digest: String,
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

struct SystemSecretStore {
    data_dir: PathBuf,
}

impl SystemSecretStore {
    fn new(data_dir: &Path) -> Self {
        Self {
            data_dir: data_dir.to_path_buf(),
        }
    }
}

impl SecretStore for SystemSecretStore {
    fn get(&self, namespace: &str, key: &str) -> DesktopResult<Option<String>> {
        get_secret(self.data_dir(), namespace, key)
    }

    fn set(&self, namespace: &str, key: &str, value: &str) -> DesktopResult<()> {
        set_secret(self.data_dir(), namespace, key, value)
    }

    fn delete(&self, namespace: &str, key: &str) -> DesktopResult<()> {
        delete_secret(self.data_dir(), namespace, key)
    }
}

impl SystemSecretStore {
    fn data_dir(&self) -> &Path {
        &self.data_dir
    }
}

pub fn run() -> i32 {
    let stdin = io::stdin();
    let mut line = String::new();
    let response = match stdin.lock().read_line(&mut line) {
        Ok(0) => error_response(
            "empty-request",
            "credential vault helper received no request",
        ),
        Ok(_) => match serde_json::from_str::<HelperRequest>(&line) {
            Ok(request) => match execute(request) {
                Ok(value) => json!({ "ok": true, "value": value }),
                Err(error) => error_response("vault-failed", &error.to_string()),
            },
            Err(_) => error_response(
                "invalid-request",
                "credential vault helper request is invalid",
            ),
        },
        Err(_) => error_response(
            "read-failed",
            "credential vault helper could not read its request",
        ),
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
        .ok_or_else(|| {
            DesktopError::CredentialVault(format!("{DATA_DIR_ENV} is not configured"))
        })?;
    let store = SystemSecretStore::new(&data_dir);
    validate_session_at(&data_dir, &request)?;
    execute_with(&store, &data_dir, request)
}

fn validate_session_at(data_dir: &Path, request: &HelperRequest) -> DesktopResult<()> {
    let provided = request.session.as_deref().unwrap_or_default();
    let expected = read_session_authorization(&data_dir.join(SESSION_FILE))?
        .filter(|authorization| authorization.version == 1)
        .map(|authorization| authorization.digest)
        .unwrap_or_default();
    let provided_digest = session_digest(provided);
    if provided.is_empty() || !constant_time_eq(provided_digest.as_bytes(), expected.as_bytes()) {
        return Err(DesktopError::CredentialVault(
            "credential helper session is not authorized".to_owned(),
        ));
    }
    Ok(())
}

fn session_digest(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

fn read_session_authorization(path: &Path) -> DesktopResult<Option<SessionAuthorization>> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(serde_json::from_str(&text)?)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

#[cfg(unix)]
fn restrict_session_file(path: &Path) -> DesktopResult<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn restrict_session_file(_path: &Path) -> DesktopResult<()> {
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
            let value = request.value.ok_or_else(|| {
                DesktopError::CredentialVault("record value is required".to_owned())
            })?;
            let kind = value
                .get("kind")
                .and_then(Value::as_str)
                .filter(|kind| matches!(*kind, "api-key" | "grant"))
                .ok_or_else(|| {
                    DesktopError::CredentialVault("record kind must be api-key or grant".to_owned())
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

#[derive(Debug, Default, Deserialize, Serialize)]
struct VaultEntries {
    entries: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct VaultDocument {
    version: u8,
    nonce: String,
    ciphertext: String,
}

fn get_secret(data_dir: &Path, namespace: &str, key: &str) -> DesktopResult<Option<String>> {
    with_vault(data_dir, |entries| {
        Ok((
            entries.entries.get(&account(namespace, key)).cloned(),
            false,
        ))
    })
}

fn set_secret(data_dir: &Path, namespace: &str, key: &str, value: &str) -> DesktopResult<()> {
    if value.is_empty() {
        return Err(DesktopError::CredentialVault(
            "empty credentials are not allowed".to_owned(),
        ));
    }
    with_vault(data_dir, |entries| {
        entries
            .entries
            .insert(account(namespace, key), value.to_owned());
        Ok(((), true))
    })
}

fn delete_secret(data_dir: &Path, namespace: &str, key: &str) -> DesktopResult<()> {
    with_vault(data_dir, |entries| {
        let changed = entries.entries.remove(&account(namespace, key)).is_some();
        Ok(((), changed))
    })
}

fn with_vault<T>(
    data_dir: &Path,
    operation: impl FnOnce(&mut VaultEntries) -> DesktopResult<(T, bool)>,
) -> DesktopResult<T> {
    create_private_directory(data_dir)?;
    let lock = open_private_file(&data_dir.join(VAULT_LOCK_FILE), false)?;
    lock.lock_exclusive().map_err(|_| {
        DesktopError::CredentialVault("encrypted credential vault is busy".to_owned())
    })?;

    let key = load_or_create_vault_key(data_dir)?;
    let mut entries = load_vault(data_dir, &key)?;
    let (result, changed) = operation(&mut entries)?;
    if changed {
        save_vault(data_dir, &key, &entries)?;
    }
    Ok(result)
}

fn load_or_create_vault_key(data_dir: &Path) -> DesktopResult<[u8; VAULT_KEY_LEN]> {
    let path = data_dir.join(VAULT_KEY_FILE);
    match fs::read(&path) {
        Ok(bytes) => bytes.try_into().map_err(|_| {
            DesktopError::CredentialVault("encrypted credential vault key is invalid".to_owned())
        }),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let mut key = [0_u8; VAULT_KEY_LEN];
            getrandom::fill(&mut key).map_err(|_| {
                DesktopError::CredentialVault(
                    "secure random generator is unavailable for credential storage".to_owned(),
                )
            })?;
            let mut file = open_private_file(&path, true)?;
            file.write_all(&key)?;
            file.sync_all()?;
            Ok(key)
        }
        Err(error) => Err(error.into()),
    }
}

fn load_vault(data_dir: &Path, key: &[u8; VAULT_KEY_LEN]) -> DesktopResult<VaultEntries> {
    let path = data_dir.join(VAULT_FILE);
    let document = match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str::<VaultDocument>(&text).map_err(|_| {
            DesktopError::CredentialVault("encrypted credential vault is corrupted".to_owned())
        })?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(VaultEntries::default());
        }
        Err(error) => return Err(error.into()),
    };
    if document.version != 1 {
        return Err(DesktopError::CredentialVault(format!(
            "unsupported encrypted credential vault version {}",
            document.version
        )));
    }

    let nonce = URL_SAFE_NO_PAD.decode(document.nonce).map_err(|_| {
        DesktopError::CredentialVault("encrypted credential vault nonce is invalid".to_owned())
    })?;
    if nonce.len() != VAULT_NONCE_LEN {
        return Err(DesktopError::CredentialVault(
            "encrypted credential vault nonce is invalid".to_owned(),
        ));
    }
    let ciphertext = URL_SAFE_NO_PAD.decode(document.ciphertext).map_err(|_| {
        DesktopError::CredentialVault("encrypted credential vault payload is invalid".to_owned())
    })?;
    let cipher = vault_cipher(key)?;
    let plaintext = cipher
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: SERVICE.as_bytes(),
            },
        )
        .map_err(|_| {
            DesktopError::CredentialVault(
                "encrypted credential vault could not be authenticated".to_owned(),
            )
        })?;
    serde_json::from_slice(&plaintext).map_err(|_| {
        DesktopError::CredentialVault("encrypted credential vault payload is corrupted".to_owned())
    })
}

fn save_vault(
    data_dir: &Path,
    key: &[u8; VAULT_KEY_LEN],
    entries: &VaultEntries,
) -> DesktopResult<()> {
    let mut nonce = [0_u8; VAULT_NONCE_LEN];
    getrandom::fill(&mut nonce).map_err(|_| {
        DesktopError::CredentialVault(
            "secure random generator is unavailable for credential storage".to_owned(),
        )
    })?;
    let plaintext = serde_json::to_vec(entries)?;
    let ciphertext = vault_cipher(key)?
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &plaintext,
                aad: SERVICE.as_bytes(),
            },
        )
        .map_err(|_| {
            DesktopError::CredentialVault("encrypted credential vault write failed".to_owned())
        })?;
    let path = data_dir.join(VAULT_FILE);
    write_json_atomic(
        &path,
        &VaultDocument {
            version: 1,
            nonce: URL_SAFE_NO_PAD.encode(nonce),
            ciphertext: URL_SAFE_NO_PAD.encode(ciphertext),
        },
    )?;
    restrict_private_file(&path)?;
    Ok(())
}

fn vault_cipher(key: &[u8; VAULT_KEY_LEN]) -> DesktopResult<XChaCha20Poly1305> {
    XChaCha20Poly1305::new_from_slice(key).map_err(|_| {
        DesktopError::CredentialVault("encrypted credential vault key is invalid".to_owned())
    })
}

fn open_private_file(path: &Path, create_new: bool) -> DesktopResult<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    if create_new {
        options.create_new(true);
    } else {
        options.create(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    restrict_private_file(path)?;
    Ok(file)
}

fn create_private_directory(path: &Path) -> DesktopResult<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

#[cfg(unix)]
fn restrict_private_file(path: &Path) -> DesktopResult<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn restrict_private_file(_path: &Path) -> DesktopResult<()> {
    Ok(())
}

fn require_key(key: Option<String>) -> DesktopResult<String> {
    key.filter(|value| !value.is_empty())
        .ok_or_else(|| DesktopError::CredentialVault("credential address is required".to_owned()))
}

fn require_string(value: Option<Value>) -> DesktopResult<String> {
    value
        .and_then(|value| value.as_str().map(str::to_owned))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            DesktopError::CredentialVault("non-empty credential value is required".to_owned())
        })
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
            Err(DesktopError::CredentialVault(
                "encrypted credential vault is unavailable".to_owned(),
            ))
        }

        fn set(&self, _namespace: &str, _key: &str, _value: &str) -> DesktopResult<()> {
            Err(DesktopError::CredentialVault(
                "encrypted credential vault is unavailable".to_owned(),
            ))
        }

        fn delete(&self, _namespace: &str, _key: &str) -> DesktopResult<()> {
            Err(DesktopError::CredentialVault(
                "encrypted credential vault is unavailable".to_owned(),
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
        let path = env::temp_dir().join(format!(
            "deepseek-desktop-{name}-{}",
            std::process::id()
        ));
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
    fn authorizes_only_the_current_runtime_session_without_storing_its_token() {
        let data_dir = temporary_data_dir("runtime-session");
        let session = RuntimeSession::create(&data_dir).unwrap();
        let authorization = fs::read_to_string(data_dir.join(SESSION_FILE)).unwrap();
        assert!(!authorization.contains(session.token()));

        let mut request = request(Operation::DescribeRef, "DEEPSEEK_API_KEY", None);
        request.session = Some("unexpected-session".to_owned());
        assert!(validate_session_at(&data_dir, &request).is_err());
        request.session = Some(session.token().to_owned());
        assert!(validate_session_at(&data_dir, &request).is_ok());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(data_dir.join(SESSION_FILE))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }

        drop(session);
        assert!(!data_dir.join(SESSION_FILE).exists());
        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn dropping_an_old_runtime_session_preserves_the_new_session() {
        let data_dir = temporary_data_dir("runtime-session-restart");
        let first = RuntimeSession::create(&data_dir).unwrap();
        let second = RuntimeSession::create(&data_dir).unwrap();
        let mut request = request(Operation::DescribeRef, "DEEPSEEK_API_KEY", None);
        request.session = Some(second.token().to_owned());

        drop(first);
        assert!(data_dir.join(SESSION_FILE).exists());
        assert!(validate_session_at(&data_dir, &request).is_ok());

        drop(second);
        assert!(!data_dir.join(SESSION_FILE).exists());
        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn supports_refs_api_keys_grants_and_record_enumeration_without_plaintext_index_data() {
        let store = MemorySecretStore::default();
        let data_dir = temporary_data_dir("credential-vault-contract");

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
    fn encrypted_vault_round_trips_without_writing_plaintext_credentials() {
        let data_dir = temporary_data_dir("encrypted-vault");
        let store = SystemSecretStore::new(&data_dir);
        let secret = "not-a-real-provider-secret";

        store.set("ref", "PROVIDER_API_KEY", secret).unwrap();
        assert_eq!(
            store.get("ref", "PROVIDER_API_KEY").unwrap().as_deref(),
            Some(secret)
        );
        let vault = fs::read_to_string(data_dir.join(VAULT_FILE)).unwrap();
        let key = fs::read(data_dir.join(VAULT_KEY_FILE)).unwrap();
        assert!(!vault.contains(secret));
        assert!(
            !key.windows(secret.len())
                .any(|window| window == secret.as_bytes())
        );
        assert_eq!(key.len(), VAULT_KEY_LEN);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for path in [
                data_dir.join(VAULT_FILE),
                data_dir.join(VAULT_KEY_FILE),
                data_dir.join(VAULT_LOCK_FILE),
            ] {
                assert_eq!(
                    fs::metadata(path).unwrap().permissions().mode() & 0o777,
                    0o600
                );
            }
            assert_eq!(
                fs::metadata(&data_dir).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }

        store.delete("ref", "PROVIDER_API_KEY").unwrap();
        assert_eq!(store.get("ref", "PROVIDER_API_KEY").unwrap(), None);
        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn corrupted_encrypted_vault_fails_closed_without_overwriting_it() {
        let data_dir = temporary_data_dir("corrupt-encrypted-vault");
        let store = SystemSecretStore::new(&data_dir);
        store
            .set("ref", "PROVIDER_API_KEY", "not-a-real-provider-secret")
            .unwrap();
        let path = data_dir.join(VAULT_FILE);
        fs::write(&path, "corrupted-vault").unwrap();

        assert!(store.get("ref", "PROVIDER_API_KEY").is_err());
        assert!(
            store
                .set("ref", "SECOND_API_KEY", "must-not-be-written")
                .is_err()
        );
        assert_eq!(fs::read_to_string(path).unwrap(), "corrupted-vault");
        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn vault_failure_is_explicit_and_never_creates_a_plaintext_fallback() {
        let data_dir = temporary_data_dir("vault-unavailable");
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
        assert!(error.to_string().contains("vault is unavailable"));
        assert!(!data_dir.join(".credentials.yaml").exists());
        assert!(!data_dir.join(".env").exists());
    }
}
