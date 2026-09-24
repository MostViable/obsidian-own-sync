use std::{
    error::Error,
    fmt,
    fs,
    path::Path,
    time::Duration,
};

use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};

use crate::access::{DeviceId, DeviceToken, UserId, VaultRole};
use crate::revision::{
    decide_commit, AppliedCommit, CommitDecision, CommitRequest, OperationId, PayloadDigest,
    MAX_REVISION,
};

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct VaultId(pub [u8; 16]);

pub struct BootstrapIdentity {
    pub user_id: UserId,
    pub device_id: DeviceId,
    pub vault_id: VaultId,
    pub token: DeviceToken,
}

#[derive(Debug)]
pub enum StoreError {
    Database(rusqlite::Error),
    Io(std::io::Error),
    Random(getrandom::Error),
    UnknownVault,
    Unauthorized,
    LastOwner,
    AlreadyInitialized,
    LegacyVaultsNeedOwner,
    UnsupportedSchema(i64),
    UnsupportedJournalMode(String),
    InconsistentState,
    BackupDestinationExists,
    InvalidBackupPath,
}

impl fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Database(error) => write!(formatter, "SQLite error: {error}"),
            Self::Io(error) => write!(formatter, "filesystem error: {error}"),
            Self::Random(error) => write!(formatter, "system random source failed: {error}"),
            Self::UnknownVault => write!(formatter, "vault does not exist"),
            Self::Unauthorized => write!(formatter, "device has no access to this vault"),
            Self::LastOwner => write!(formatter, "cannot remove the last vault owner"),
            Self::AlreadyInitialized => write!(formatter, "store already has users or vaults"),
            Self::LegacyVaultsNeedOwner => {
                write!(
                    formatter,
                    "legacy vaults need an owner before schema migration"
                )
            }
            Self::UnsupportedSchema(version) => {
                write!(formatter, "unsupported database schema version: {version}")
            }
            Self::UnsupportedJournalMode(mode) => {
                write!(formatter, "WAL journal mode is unavailable: {mode}")
            }
            Self::InconsistentState => write!(formatter, "stored revision state is inconsistent"),
            Self::BackupDestinationExists => {
                write!(formatter, "backup destination already exists")
            }
            Self::InvalidBackupPath => write!(formatter, "backup path is not valid UTF-8"),
        }
    }
}

impl Error for StoreError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Database(error) => Some(error),
            Self::Io(error) => Some(error),
            Self::Random(error) => Some(error),
            _ => None,
        }
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Database(error)
    }
}

impl From<std::io::Error> for StoreError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<getrandom::Error> for StoreError {
    fn from(error: getrandom::Error) -> Self {
        Self::Random(error)
    }
}

pub struct SqliteStore {
    connection: Connection,
}

impl SqliteStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW;
        Self::open_with_flags(path, flags)
    }

    pub fn open_existing(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW;
        Self::open_with_flags(path, flags)
    }

    fn open_with_flags(path: impl AsRef<Path>, flags: OpenFlags) -> Result<Self, StoreError> {
        let mut connection = Connection::open_with_flags(path, flags)?;
        connection.busy_timeout(Duration::from_secs(5))?;

        let mut mode: String = connection.query_row("PRAGMA journal_mode", [], |row| row.get(0))?;
        if mode != "wal" {
            mode = connection.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
        }
        if mode != "wal" {
            return Err(StoreError::UnsupportedJournalMode(mode));
        }
        connection.execute_batch("PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;")?;
        initialize_schema(&mut connection)?;

        Ok(Self { connection })
    }

    pub fn bootstrap_owner(&mut self) -> Result<BootstrapIdentity, StoreError> {
        let user_id = UserId(random_id()?);
        let device_id = DeviceId(random_id()?);
        let vault_id = VaultId(random_id()?);
        let mut token_bytes = [0_u8; 32];
        getrandom::fill(&mut token_bytes)?;
        let token = DeviceToken(token_bytes);

        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing_records: i64 = transaction.query_row(
            "SELECT (SELECT count(*) FROM users) + (SELECT count(*) FROM devices)
                  + (SELECT count(*) FROM vaults) + (SELECT count(*) FROM commits)",
            [],
            |row| row.get(0),
        )?;
        if existing_records != 0 {
            return Err(StoreError::AlreadyInitialized);
        }
        transaction.execute(
            "INSERT INTO users (user_id) VALUES (?1)",
            params![&user_id.0[..]],
        )?;
        transaction.execute(
            "INSERT INTO devices (device_id, user_id, token_hash) VALUES (?1, ?2, ?3)",
            params![&device_id.0[..], &user_id.0[..], &token.digest()[..]],
        )?;
        transaction.execute(
            "INSERT INTO vaults (vault_id, current_revision) VALUES (?1, 0)",
            params![&vault_id.0[..]],
        )?;
        transaction.execute(
            "INSERT INTO vault_members (vault_id, user_id, role) VALUES (?1, ?2, 'owner')",
            params![&vault_id.0[..], &user_id.0[..]],
        )?;
        transaction.commit()?;
        Ok(BootstrapIdentity {
            user_id,
            device_id,
            vault_id,
            token,
        })
    }

    pub fn create_user(&self) -> Result<UserId, StoreError> {
        let user_id = UserId(random_id()?);
        self.connection.execute(
            "INSERT INTO users (user_id) VALUES (?1)",
            params![&user_id.0[..]],
        )?;
        Ok(user_id)
    }

    /// Device provisioning is internal until the pairing and invitation flow exists.
    pub fn issue_device(&self, user_id: UserId) -> Result<(DeviceId, DeviceToken), StoreError> {
        let device_id = DeviceId(random_id()?);
        let mut bytes = [0_u8; 32];
        getrandom::fill(&mut bytes)?;
        let token = DeviceToken(bytes);
        self.connection.execute(
            "INSERT INTO devices (device_id, user_id, token_hash)
             VALUES (?1, ?2, ?3)",
            params![&device_id.0[..], &user_id.0[..], &token.digest()[..]],
        )?;
        Ok((device_id, token))
    }

    /// Issues a device only when the credential token belongs to the declared
    /// user and that user is an owner of the requested vault.
    pub fn issue_device_for_owner(
        &mut self,
        owner_token: &DeviceToken,
        user_id: UserId,
        vault_id: VaultId,
    ) -> Result<(DeviceId, DeviceToken), StoreError> {
        let device_id = DeviceId(random_id()?);
        let mut bytes = [0_u8; 32];
        getrandom::fill(&mut bytes)?;
        let token = DeviceToken(bytes);
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let token_user: Option<Vec<u8>> = transaction
            .query_row(
                "SELECT user_id FROM devices WHERE token_hash = ?1 AND revoked = 0",
                params![&owner_token.digest()[..]],
                |row| row.get(0),
            )
            .optional()?;
        if token_user.as_deref() != Some(&user_id.0[..]) {
            return Err(StoreError::Unauthorized);
        }
        authorize(&transaction, owner_token, vault_id, RequiredRole::Owner)?;
        transaction.execute(
            "INSERT INTO devices (device_id, user_id, token_hash)
             VALUES (?1, ?2, ?3)",
            params![&device_id.0[..], &user_id.0[..], &token.digest()[..]],
        )?;
        transaction.commit()?;
        Ok((device_id, token))
    }

    pub fn create_vault_for_owner(&mut self, owner: UserId) -> Result<VaultId, StoreError> {
        let vault_id = VaultId(random_id()?);
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "INSERT INTO vaults (vault_id, current_revision) VALUES (?1, 0)",
            params![&vault_id.0[..]],
        )?;
        transaction.execute(
            "INSERT INTO vault_members (vault_id, user_id, role) VALUES (?1, ?2, 'owner')",
            params![&vault_id.0[..], &owner.0[..]],
        )?;
        transaction.commit()?;
        Ok(vault_id)
    }

    pub fn grant_member(
        &mut self,
        owner_token: &DeviceToken,
        vault_id: VaultId,
        user_id: UserId,
        role: VaultRole,
    ) -> Result<(), StoreError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        authorize(&transaction, owner_token, vault_id, RequiredRole::Owner)?;
        let previous_role: Option<String> = transaction
            .query_row(
                "SELECT role FROM vault_members WHERE vault_id = ?1 AND user_id = ?2",
                params![&vault_id.0[..], &user_id.0[..]],
                |row| row.get(0),
            )
            .optional()?;
        if previous_role.as_deref() == Some("owner") && role != VaultRole::Owner {
            ensure_another_owner(&transaction, vault_id)?;
        }
        transaction.execute(
            "INSERT INTO vault_members (vault_id, user_id, role) VALUES (?1, ?2, ?3)
             ON CONFLICT(vault_id, user_id) DO UPDATE SET role = excluded.role",
            params![&vault_id.0[..], &user_id.0[..], role.as_str()],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn revoke_member(
        &mut self,
        owner_token: &DeviceToken,
        vault_id: VaultId,
        user_id: UserId,
    ) -> Result<bool, StoreError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        authorize(&transaction, owner_token, vault_id, RequiredRole::Owner)?;
        let role: Option<String> = transaction
            .query_row(
                "SELECT role FROM vault_members WHERE vault_id = ?1 AND user_id = ?2",
                params![&vault_id.0[..], &user_id.0[..]],
                |row| row.get(0),
            )
            .optional()?;
        if role.as_deref() == Some("owner") {
            ensure_another_owner(&transaction, vault_id)?;
        }
        let removed = transaction.execute(
            "DELETE FROM vault_members WHERE vault_id = ?1 AND user_id = ?2",
            params![&vault_id.0[..], &user_id.0[..]],
        )?;
        transaction.commit()?;
        Ok(removed == 1)
    }

    pub fn revoke_device(
        &mut self,
        active_token: &DeviceToken,
        device_id: DeviceId,
    ) -> Result<bool, StoreError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let user_id: Vec<u8> = transaction
            .query_row(
                "SELECT user_id FROM devices WHERE token_hash = ?1 AND revoked = 0",
                params![&active_token.digest()[..]],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(StoreError::Unauthorized)?;
        let revoked = transaction.execute(
            "UPDATE devices SET revoked = 1 WHERE device_id = ?1 AND user_id = ?2 AND revoked = 0",
            params![&device_id.0[..], user_id],
        )?;
        transaction.commit()?;
        Ok(revoked == 1)
    }

    #[cfg(test)]
    fn create_vault(&self, vault_id: VaultId) -> Result<(), StoreError> {
        self.connection.execute(
            "INSERT INTO vaults (vault_id, current_revision) VALUES (?1, 0)",
            params![&vault_id.0[..]],
        )?;
        Ok(())
    }

    pub fn current_revision_for(
        &mut self,
        token: &DeviceToken,
        vault_id: VaultId,
    ) -> Result<u64, StoreError> {
        let transaction = self.connection.transaction()?;
        authorize(&transaction, token, vault_id, RequiredRole::Reader)?;
        let revision =
            read_current_revision(&transaction, vault_id)?.ok_or(StoreError::InconsistentState)?;
        transaction.commit()?;
        Ok(revision)
    }

    /// An early permission check for callers that must reject before reading a request body.
    /// `commit_authenticated` checks again inside its write transaction.
    pub fn ensure_write_access(
        &self,
        token: &DeviceToken,
        vault_id: VaultId,
    ) -> Result<(), StoreError> {
        authorize(&self.connection, token, vault_id, RequiredRole::Writer)
    }

    #[cfg(test)]
    fn current_revision(&self, vault_id: VaultId) -> Result<Option<u64>, StoreError> {
        read_current_revision(&self.connection, vault_id)
    }

    /// Stores an already encrypted packet after checking the device's write access.
    pub fn commit_authenticated(
        &mut self,
        token: &DeviceToken,
        vault_id: VaultId,
        operation_id: OperationId,
        expected_revision: u64,
        encrypted_payload: &[u8],
    ) -> Result<CommitDecision, StoreError> {
        self.commit_inner(
            Some(token),
            vault_id,
            operation_id,
            expected_revision,
            encrypted_payload,
        )
    }

    #[cfg(test)]
    fn commit(
        &mut self,
        vault_id: VaultId,
        operation_id: OperationId,
        expected_revision: u64,
        encrypted_payload: &[u8],
    ) -> Result<CommitDecision, StoreError> {
        self.commit_inner(
            None,
            vault_id,
            operation_id,
            expected_revision,
            encrypted_payload,
        )
    }

    fn commit_inner(
        &mut self,
        token: Option<&DeviceToken>,
        vault_id: VaultId,
        operation_id: OperationId,
        expected_revision: u64,
        encrypted_payload: &[u8],
    ) -> Result<CommitDecision, StoreError> {
        if let Some(token) = token {
            authorize(&self.connection, token, vault_id, RequiredRole::Writer)?;
        }
        if expected_revision > MAX_REVISION {
            return Ok(CommitDecision::InvalidRevision);
        }

        let payload_digest = digest(encrypted_payload);
        let request = CommitRequest {
            operation_id,
            expected_revision,
            payload_digest,
        };

        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(token) = token {
            authorize(&transaction, token, vault_id, RequiredRole::Writer)?;
        }
        let current: Option<i64> = transaction
            .query_row(
                "SELECT current_revision FROM vaults WHERE vault_id = ?1",
                params![&vault_id.0[..]],
                |row| row.get(0),
            )
            .optional()?;
        let current = valid_revision(current.ok_or(StoreError::UnknownVault)?)?;

        let previous: Option<(i64, i64, Vec<u8>, Vec<u8>)> = transaction
            .query_row(
                "SELECT expected_revision, applied_revision, payload_digest, encrypted_payload
                 FROM commits WHERE vault_id = ?1 AND operation_id = ?2",
                params![&vault_id.0[..], &operation_id.0[..]],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let previous = previous
            .map(|(expected, applied, stored_digest, stored_payload)| {
                let stored_digest: [u8; 32] = stored_digest
                    .try_into()
                    .map_err(|_| StoreError::InconsistentState)?;
                if digest(&stored_payload).0 != stored_digest {
                    return Err(StoreError::InconsistentState);
                }
                Ok(AppliedCommit {
                    operation_id,
                    expected_revision: valid_revision(expected)?,
                    payload_digest: PayloadDigest(stored_digest),
                    applied_revision: valid_revision(applied)?,
                })
            })
            .transpose()?;

        let decision = decide_commit(current, previous.as_ref(), &request);
        if let CommitDecision::Apply { revision } = decision {
            transaction.execute(
                "INSERT INTO commits
                 (vault_id, operation_id, expected_revision, applied_revision, payload_digest, encrypted_payload)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    &vault_id.0[..],
                    &operation_id.0[..],
                    expected_revision as i64,
                    revision as i64,
                    &payload_digest.0[..],
                    encrypted_payload
                ],
            )?;
            let updated = transaction.execute(
                "UPDATE vaults SET current_revision = ?2
                 WHERE vault_id = ?1 AND current_revision = ?3",
                params![&vault_id.0[..], revision as i64, current as i64],
            )?;
            if updated != 1 {
                return Err(StoreError::InconsistentState);
            }
        }
        transaction.commit()?;
        Ok(decision)
    }

    pub fn encrypted_payload_for(
        &mut self,
        token: &DeviceToken,
        vault_id: VaultId,
        revision: u64,
    ) -> Result<Option<Vec<u8>>, StoreError> {
        let transaction = self.connection.transaction()?;
        authorize(&transaction, token, vault_id, RequiredRole::Reader)?;
        let payload = read_encrypted_payload(&transaction, vault_id, revision)?;
        transaction.commit()?;
        Ok(payload)
    }

    pub fn backup_to(&mut self, destination: impl AsRef<Path>) -> Result<(), StoreError> {
        let destination = destination.as_ref();
        if destination.symlink_metadata().is_ok() {
            return Err(StoreError::BackupDestinationExists);
        }
        let destination = destination.to_str().ok_or(StoreError::InvalidBackupPath)?;
        let parent = Path::new(destination)
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let temporary = tempfile::Builder::new()
            .prefix(".own-sync-backup-")
            .tempfile_in(parent)?;
        let temporary_path = temporary.path().to_path_buf();
        let temporary_path_guard = temporary.into_temp_path();
        fs::remove_file(&temporary_path)?;

        let vacuum_result = temporary_path
            .to_str()
            .ok_or(StoreError::InvalidBackupPath)
            .and_then(|path| {
                self.connection
                    .execute("VACUUM INTO ?1", params![path])
                    .map(|_| ())
                    .map_err(StoreError::from)
            });
        if let Err(error) = vacuum_result {
            let _ = fs::remove_file(&temporary_path);
            return Err(error);
        }

        let result = match fs::hard_link(&temporary_path, destination) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                Err(StoreError::BackupDestinationExists)
            }
            Err(error) => Err(StoreError::Io(error)),
        };
        let cleanup_result = fs::remove_file(&temporary_path);
        drop(temporary_path_guard);
        result.and(cleanup_result.map_err(StoreError::from))
    }

    #[cfg(test)]
    fn encrypted_payload(
        &self,
        vault_id: VaultId,
        revision: u64,
    ) -> Result<Option<Vec<u8>>, StoreError> {
        read_encrypted_payload(&self.connection, vault_id, revision)
    }
}

fn read_encrypted_payload(
    connection: &Connection,
    vault_id: VaultId,
    revision: u64,
) -> Result<Option<Vec<u8>>, StoreError> {
    if revision == 0 || revision > MAX_REVISION {
        return Ok(None);
    }
    let stored: Option<(Vec<u8>, Vec<u8>)> = connection
        .query_row(
            "SELECT payload_digest, encrypted_payload FROM commits
                 WHERE vault_id = ?1 AND applied_revision = ?2",
            params![&vault_id.0[..], revision as i64],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    stored
        .map(|(stored_digest, payload)| {
            if stored_digest.as_slice() != digest(&payload).0 {
                return Err(StoreError::InconsistentState);
            }
            Ok(payload)
        })
        .transpose()
}

fn read_current_revision(
    connection: &Connection,
    vault_id: VaultId,
) -> Result<Option<u64>, StoreError> {
    let revision: Option<i64> = connection
        .query_row(
            "SELECT current_revision FROM vaults WHERE vault_id = ?1",
            params![&vault_id.0[..]],
            |row| row.get(0),
        )
        .optional()?;
    revision.map(valid_revision).transpose()
}

enum RequiredRole {
    Reader,
    Writer,
    Owner,
}

fn ensure_another_owner(connection: &Connection, vault_id: VaultId) -> Result<(), StoreError> {
    let owners: i64 = connection.query_row(
        "SELECT count(*) FROM vault_members WHERE vault_id = ?1 AND role = 'owner'",
        params![&vault_id.0[..]],
        |row| row.get(0),
    )?;
    if owners <= 1 {
        return Err(StoreError::LastOwner);
    }
    Ok(())
}

fn authorize(
    connection: &Connection,
    token: &DeviceToken,
    vault_id: VaultId,
    required: RequiredRole,
) -> Result<(), StoreError> {
    let role: Option<String> = connection
        .query_row(
            "SELECT members.role FROM devices
             JOIN vault_members AS members ON members.user_id = devices.user_id
             WHERE devices.token_hash = ?1 AND devices.revoked = 0
               AND members.vault_id = ?2",
            params![&token.digest()[..], &vault_id.0[..]],
            |row| row.get(0),
        )
        .optional()?;
    let role = role.ok_or(StoreError::Unauthorized)?;
    let role = VaultRole::from_str(&role).ok_or(StoreError::InconsistentState)?;
    let allowed = match required {
        RequiredRole::Reader => true,
        RequiredRole::Writer => role.can_write(),
        RequiredRole::Owner => role == VaultRole::Owner,
    };
    if !allowed {
        return Err(StoreError::Unauthorized);
    }
    Ok(())
}

fn random_id() -> Result<[u8; 16], StoreError> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes)?;
    Ok(bytes)
}

fn valid_revision(value: i64) -> Result<u64, StoreError> {
    let value = u64::try_from(value).map_err(|_| StoreError::InconsistentState)?;
    if value > MAX_REVISION {
        return Err(StoreError::InconsistentState);
    }
    Ok(value)
}

fn digest(payload: &[u8]) -> PayloadDigest {
    let mut bytes = [0_u8; 32];
    bytes.copy_from_slice(&Sha256::digest(payload));
    PayloadDigest(bytes)
}

fn initialize_schema(connection: &mut Connection) -> Result<(), StoreError> {
    let current_version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if current_version == 2 {
        return Ok(());
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let version: i64 = transaction.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    match version {
        0 => {
            let existing_tables: i64 = transaction.query_row(
                "SELECT count(*) FROM sqlite_master
                 WHERE type = 'table' AND name NOT GLOB 'sqlite_*'",
                [],
                |row| row.get(0),
            )?;
            if existing_tables != 0 {
                return Err(StoreError::UnsupportedSchema(0));
            }
            transaction.execute_batch(include_str!("../migrations/001_initial.sql"))?;
            transaction.execute_batch(include_str!("../migrations/002_access.sql"))?;
        }
        1 => {
            let existing_records: i64 = transaction.query_row(
                "SELECT (SELECT count(*) FROM vaults) + (SELECT count(*) FROM commits)",
                [],
                |row| row.get(0),
            )?;
            if existing_records != 0 {
                return Err(StoreError::LegacyVaultsNeedOwner);
            }
            transaction.execute_batch(include_str!("../migrations/002_access.sql"))?;
        }
        2 => {}
        other => return Err(StoreError::UnsupportedSchema(other)),
    }
    transaction.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{mpsc, Arc, Barrier},
        thread,
        time::Duration,
    };

    use tempfile::tempdir;

    use super::*;

    fn vault(id: u8) -> VaultId {
        VaultId([id; 16])
    }

    fn operation(id: u8) -> OperationId {
        OperationId([id; 16])
    }

    #[test]
    fn existing_open_does_not_create_a_missing_database() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("missing.sqlite");
        assert!(SqliteStore::open_existing(&path).is_err());
        assert!(!path.exists());
    }

    #[test]
    fn bootstrap_owner_runs_once_for_an_empty_store() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("sync.sqlite");
        let mut store = SqliteStore::open(path).unwrap();
        let identity = store.bootstrap_owner().unwrap();
        assert_eq!(
            store
                .current_revision_for(&identity.token, identity.vault_id)
                .unwrap(),
            0
        );
        assert!(matches!(
            store.bootstrap_owner(),
            Err(StoreError::AlreadyInitialized)
        ));
        let users: i64 = store
            .connection
            .query_row("SELECT count(*) FROM users", [], |row| row.get(0))
            .unwrap();
        assert_eq!(users, 1);
    }

    #[test]
    fn retry_after_reopen_returns_original_revision_and_payload() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("sync.sqlite");
        let mut store = SqliteStore::open(&path).unwrap();
        store.create_vault(vault(1)).unwrap();
        assert_eq!(
            store
                .commit(vault(1), operation(1), 0, b"encrypted-one")
                .unwrap(),
            CommitDecision::Apply { revision: 1 }
        );
        drop(store);

        let mut reopened = SqliteStore::open(&path).unwrap();
        assert_eq!(reopened.current_revision(vault(1)).unwrap(), Some(1));
        assert_eq!(
            reopened
                .commit(vault(1), operation(1), 0, b"encrypted-one")
                .unwrap(),
            CommitDecision::Replay { revision: 1 }
        );
        assert_eq!(
            reopened.encrypted_payload(vault(1), 1).unwrap(),
            Some(b"encrypted-one".to_vec())
        );

        assert_eq!(
            reopened
                .commit(vault(1), operation(2), 1, b"encrypted-two")
                .unwrap(),
            CommitDecision::Apply { revision: 2 }
        );
        assert_eq!(
            reopened
                .commit(vault(1), operation(1), 0, b"encrypted-one")
                .unwrap(),
            CommitDecision::Replay { revision: 1 }
        );
    }

    #[test]
    fn two_connections_cannot_commit_the_same_base() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("sync.sqlite");
        SqliteStore::open(&path)
            .unwrap()
            .create_vault(vault(1))
            .unwrap();

        let barrier = Arc::new(Barrier::new(3));
        let handles: Vec<_> = (1..=2)
            .map(|id| {
                let path = path.clone();
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    let mut store = SqliteStore::open(path).unwrap();
                    barrier.wait();
                    store.commit(vault(1), operation(id), 0, &[id]).unwrap()
                })
            })
            .collect();
        barrier.wait();
        let outcomes: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert_eq!(
            outcomes
                .iter()
                .filter(|decision| **decision == CommitDecision::Apply { revision: 1 })
                .count(),
            1
        );
        assert_eq!(
            outcomes
                .iter()
                .filter(|decision| {
                    **decision
                        == CommitDecision::Conflict {
                            current_revision: 1,
                        }
                })
                .count(),
            1
        );
        let store = SqliteStore::open(path).unwrap();
        assert_eq!(store.current_revision(vault(1)).unwrap(), Some(1));
        assert!(matches!(
            store.encrypted_payload(vault(1), 1).unwrap(),
            Some(payload) if payload == [1] || payload == [2]
        ));
    }

    #[test]
    fn opening_an_existing_store_does_not_wait_for_a_writer() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("sync.sqlite");
        SqliteStore::open(&path).unwrap();

        let mut blocker = Connection::open(&path).unwrap();
        let transaction = blocker
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        let (sender, receiver) = mpsc::channel();
        let handle = thread::spawn(move || {
            sender.send(SqliteStore::open(path).map(|_| ())).unwrap();
        });
        let opened_while_writer_active = receiver.recv_timeout(Duration::from_millis(500));
        transaction.rollback().unwrap();
        handle.join().unwrap();
        assert!(matches!(opened_while_writer_active, Ok(Ok(()))));
    }

    #[test]
    fn failed_insert_rolls_back_the_entire_commit() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("sync.sqlite");
        let mut store = SqliteStore::open(&path).unwrap();
        store.create_vault(vault(1)).unwrap();
        store
            .connection
            .execute_batch(
                "CREATE TRIGGER reject_commit BEFORE INSERT ON commits
                 BEGIN SELECT RAISE(ABORT, 'injected failure'); END;",
            )
            .unwrap();
        assert!(matches!(
            store.commit(vault(1), operation(1), 0, b"encrypted"),
            Err(StoreError::Database(_))
        ));
        drop(store);

        let mut reopened = SqliteStore::open(&path).unwrap();
        assert_eq!(reopened.current_revision(vault(1)).unwrap(), Some(0));
        assert_eq!(reopened.encrypted_payload(vault(1), 1).unwrap(), None);
        reopened
            .connection
            .execute_batch("DROP TRIGGER reject_commit")
            .unwrap();
        assert_eq!(
            reopened
                .commit(vault(1), operation(1), 0, b"encrypted")
                .unwrap(),
            CommitDecision::Apply { revision: 1 }
        );
    }

    #[test]
    fn rejected_operations_do_not_change_the_vault() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("sync.sqlite");
        let mut store = SqliteStore::open(path).unwrap();
        store.create_vault(vault(1)).unwrap();
        store.commit(vault(1), operation(1), 0, b"first").unwrap();

        assert_eq!(
            store.commit(vault(1), operation(1), 0, b"changed").unwrap(),
            CommitDecision::OperationIdReused
        );
        assert_eq!(
            store.commit(vault(1), operation(2), 0, b"second").unwrap(),
            CommitDecision::Conflict {
                current_revision: 1
            }
        );
        assert_eq!(store.current_revision(vault(1)).unwrap(), Some(1));
        assert_eq!(store.encrypted_payload(vault(1), 2).unwrap(), None);
        assert_eq!(
            store.commit(vault(1), operation(2), 1, b"second").unwrap(),
            CommitDecision::Apply { revision: 2 }
        );
    }

    #[test]
    fn vaults_have_independent_revisions_and_operation_ids() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("sync.sqlite");
        let mut store = SqliteStore::open(path).unwrap();
        store.create_vault(vault(1)).unwrap();
        store.create_vault(vault(2)).unwrap();
        assert_eq!(
            store.commit(vault(1), operation(1), 0, b"one").unwrap(),
            CommitDecision::Apply { revision: 1 }
        );
        assert_eq!(
            store.commit(vault(2), operation(1), 0, b"two").unwrap(),
            CommitDecision::Apply { revision: 1 }
        );
        assert_eq!(
            store.encrypted_payload(vault(1), 1).unwrap(),
            Some(b"one".to_vec())
        );
        assert_eq!(
            store.encrypted_payload(vault(2), 1).unwrap(),
            Some(b"two".to_vec())
        );
        assert!(matches!(
            store.commit(vault(3), operation(1), 0, b"unknown"),
            Err(StoreError::UnknownVault)
        ));
    }

    #[test]
    fn altered_payload_is_never_replayed_as_a_success() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("sync.sqlite");
        let mut store = SqliteStore::open(path).unwrap();
        store.create_vault(vault(1)).unwrap();
        store
            .commit(vault(1), operation(1), 0, b"encrypted")
            .unwrap();
        store
            .connection
            .execute(
                "UPDATE commits SET encrypted_payload = ?1 WHERE vault_id = ?2",
                params![b"damaged", &vault(1).0[..]],
            )
            .unwrap();

        assert!(matches!(
            store.encrypted_payload(vault(1), 1),
            Err(StoreError::InconsistentState)
        ));
        assert!(matches!(
            store.commit(vault(1), operation(1), 0, b"encrypted"),
            Err(StoreError::InconsistentState)
        ));
    }

    #[test]
    fn unknown_schema_version_is_not_modified() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("sync.sqlite");
        let store = SqliteStore::open(&path).unwrap();
        store
            .connection
            .execute_batch("PRAGMA user_version = 3")
            .unwrap();
        drop(store);

        assert!(matches!(
            SqliteStore::open(&path),
            Err(StoreError::UnsupportedSchema(3))
        ));
        let connection = Connection::open(path).unwrap();
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 3);
    }

    #[test]
    fn device_roles_and_revocation_guard_reads_and_writes() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("sync.sqlite");
        let mut store = SqliteStore::open(&path).unwrap();
        let owner = store.create_user().unwrap();
        let member = store.create_user().unwrap();
        let (_, owner_token) = store.issue_device(owner).unwrap();
        let (member_device, member_token) = store.issue_device(member).unwrap();
        let vault_id = store.create_vault_for_owner(owner).unwrap();

        assert_eq!(
            store.current_revision_for(&owner_token, vault_id).unwrap(),
            0
        );
        assert!(matches!(
            store.current_revision_for(&member_token, vault_id),
            Err(StoreError::Unauthorized)
        ));
        assert!(matches!(
            store.commit_authenticated(&member_token, vault_id, operation(1), 0, b"packet"),
            Err(StoreError::Unauthorized)
        ));

        store
            .grant_member(&owner_token, vault_id, member, VaultRole::Reader)
            .unwrap();
        assert_eq!(
            store.current_revision_for(&member_token, vault_id).unwrap(),
            0
        );
        assert!(matches!(
            store.commit_authenticated(&member_token, vault_id, operation(1), 0, b"packet"),
            Err(StoreError::Unauthorized)
        ));
        assert!(matches!(
            store.grant_member(&member_token, vault_id, member, VaultRole::Owner),
            Err(StoreError::Unauthorized)
        ));

        store
            .grant_member(&owner_token, vault_id, member, VaultRole::Writer)
            .unwrap();
        assert_eq!(
            store
                .commit_authenticated(&member_token, vault_id, operation(1), 0, b"packet")
                .unwrap(),
            CommitDecision::Apply { revision: 1 }
        );
        assert_eq!(
            store
                .encrypted_payload_for(&owner_token, vault_id, 1)
                .unwrap(),
            Some(b"packet".to_vec())
        );

        assert!(store.revoke_device(&member_token, member_device).unwrap());
        assert!(matches!(
            store.current_revision_for(&member_token, vault_id),
            Err(StoreError::Unauthorized)
        ));
        assert!(matches!(
            store.commit_authenticated(&member_token, vault_id, operation(2), 1, b"packet"),
            Err(StoreError::Unauthorized)
        ));
        let (_, replacement_token) = store.issue_device(member).unwrap();
        assert_eq!(
            store
                .current_revision_for(&replacement_token, vault_id)
                .unwrap(),
            1
        );
        assert!(store.revoke_member(&owner_token, vault_id, member).unwrap());
        assert!(matches!(
            store.encrypted_payload_for(&replacement_token, vault_id, 1),
            Err(StoreError::Unauthorized)
        ));
        drop(store);
        let mut reopened = SqliteStore::open(path).unwrap();
        assert!(matches!(
            reopened.current_revision_for(&member_token, vault_id),
            Err(StoreError::Unauthorized)
        ));
        assert!(matches!(
            reopened.current_revision_for(&replacement_token, vault_id),
            Err(StoreError::Unauthorized)
        ));
        assert_eq!(
            reopened
                .current_revision_for(&owner_token, vault_id)
                .unwrap(),
            1
        );
    }

    #[test]
    fn backup_is_openable_as_a_restored_store() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("sync.sqlite");
        let backup = directory.path().join("sync-backup.sqlite");
        let mut store = SqliteStore::open(&path).unwrap();
        store.create_vault(vault(1)).unwrap();
        store
            .commit(vault(1), operation(1), 0, b"encrypted-packet")
            .unwrap();
        store.backup_to(&backup).unwrap();
        drop(store);

        let mut restored = SqliteStore::open_existing(&backup).unwrap();
        assert_eq!(restored.current_revision(vault(1)).unwrap(), Some(1));
        assert_eq!(
            restored.encrypted_payload(vault(1), 1).unwrap(),
            Some(b"encrypted-packet".to_vec())
        );
        assert!(matches!(
            restored.backup_to(&backup),
            Err(StoreError::BackupDestinationExists)
        ));
    }

    #[test]
    fn last_owner_cannot_be_removed_or_demoted() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("sync.sqlite");
        let mut store = SqliteStore::open(path).unwrap();
        let first_owner = store.create_user().unwrap();
        let second_owner = store.create_user().unwrap();
        let (_, first_token) = store.issue_device(first_owner).unwrap();
        let (_, second_token) = store.issue_device(second_owner).unwrap();
        let vault_id = store.create_vault_for_owner(first_owner).unwrap();

        assert!(matches!(
            store.revoke_member(&first_token, vault_id, first_owner),
            Err(StoreError::LastOwner)
        ));
        assert!(matches!(
            store.grant_member(&first_token, vault_id, first_owner, VaultRole::Reader),
            Err(StoreError::LastOwner)
        ));
        store
            .grant_member(&first_token, vault_id, second_owner, VaultRole::Owner)
            .unwrap();
        store
            .grant_member(&first_token, vault_id, first_owner, VaultRole::Reader)
            .unwrap();
        assert!(matches!(
            store.grant_member(&first_token, vault_id, first_owner, VaultRole::Owner),
            Err(StoreError::Unauthorized)
        ));
        assert!(store
            .revoke_member(&second_token, vault_id, first_owner)
            .unwrap());
        assert!(matches!(
            store.revoke_member(&second_token, vault_id, second_owner),
            Err(StoreError::LastOwner)
        ));
    }

    #[test]
    fn populated_schema_one_is_left_untouched_until_an_owner_can_be_assigned() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("sync.sqlite");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(include_str!("../migrations/001_initial.sql"))
            .unwrap();
        connection
            .execute(
                "INSERT INTO vaults (vault_id, current_revision) VALUES (?1, 4)",
                params![&vault(1).0[..]],
            )
            .unwrap();
        drop(connection);

        assert!(matches!(
            SqliteStore::open(&path),
            Err(StoreError::LegacyVaultsNeedOwner)
        ));
        let connection = Connection::open(path).unwrap();
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 1);
        let revision: i64 = connection
            .query_row(
                "SELECT current_revision FROM vaults WHERE vault_id = ?1",
                params![&vault(1).0[..]],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(revision, 4);
    }

    #[test]
    fn empty_schema_one_migrates_to_access_schema() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("sync.sqlite");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(include_str!("../migrations/001_initial.sql"))
            .unwrap();
        drop(connection);

        let store = SqliteStore::open(path).unwrap();
        let user_id = store.create_user().unwrap();
        store.issue_device(user_id).unwrap();
        let version: i64 = store
            .connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 2);
    }
}
