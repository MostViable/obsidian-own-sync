use std::{error::Error, fmt, path::Path, time::Duration};

use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};

use crate::revision::{
    decide_commit, AppliedCommit, CommitDecision, CommitRequest, OperationId, PayloadDigest,
    MAX_REVISION,
};

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct VaultId(pub [u8; 16]);

#[derive(Debug)]
pub enum StoreError {
    Database(rusqlite::Error),
    UnknownVault,
    UnsupportedSchema(i64),
    UnsupportedJournalMode(String),
    InconsistentState,
}

impl fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Database(error) => write!(formatter, "SQLite error: {error}"),
            Self::UnknownVault => write!(formatter, "vault does not exist"),
            Self::UnsupportedSchema(version) => {
                write!(formatter, "unsupported database schema version: {version}")
            }
            Self::UnsupportedJournalMode(mode) => {
                write!(formatter, "WAL journal mode is unavailable: {mode}")
            }
            Self::InconsistentState => write!(formatter, "stored revision state is inconsistent"),
        }
    }
}

impl Error for StoreError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Database(error) => Some(error),
            _ => None,
        }
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Database(error)
    }
}

pub struct SqliteStore {
    connection: Connection,
}

impl SqliteStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let mut connection = Connection::open_with_flags(path, flags)?;
        connection.busy_timeout(Duration::from_secs(5))?;

        let mode: String =
            connection.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
        if mode != "wal" {
            return Err(StoreError::UnsupportedJournalMode(mode));
        }
        connection.execute_batch("PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;")?;
        initialize_schema(&mut connection)?;

        Ok(Self { connection })
    }

    pub fn create_vault(&self, vault_id: VaultId) -> Result<(), StoreError> {
        self.connection.execute(
            "INSERT INTO vaults (vault_id, current_revision) VALUES (?1, 0)",
            params![&vault_id.0[..]],
        )?;
        Ok(())
    }

    pub fn current_revision(&self, vault_id: VaultId) -> Result<Option<u64>, StoreError> {
        let revision: Option<i64> = self
            .connection
            .query_row(
                "SELECT current_revision FROM vaults WHERE vault_id = ?1",
                params![&vault_id.0[..]],
                |row| row.get(0),
            )
            .optional()?;
        revision.map(valid_revision).transpose()
    }

    /// Stores an already encrypted packet. Authorization and encryption belong to the caller.
    pub fn commit(
        &mut self,
        vault_id: VaultId,
        operation_id: OperationId,
        expected_revision: u64,
        encrypted_payload: &[u8],
    ) -> Result<CommitDecision, StoreError> {
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

    pub fn encrypted_payload(
        &self,
        vault_id: VaultId,
        revision: u64,
    ) -> Result<Option<Vec<u8>>, StoreError> {
        if revision == 0 || revision > MAX_REVISION {
            return Ok(None);
        }
        let stored: Option<(Vec<u8>, Vec<u8>)> = self
            .connection
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
            transaction.execute_batch(
                "CREATE TABLE vaults (
                     vault_id BLOB NOT NULL PRIMARY KEY CHECK(length(vault_id) = 16),
                     current_revision INTEGER NOT NULL DEFAULT 0
                         CHECK(current_revision BETWEEN 0 AND 9007199254740991)
                 ) STRICT;
                 CREATE TABLE commits (
                     vault_id BLOB NOT NULL REFERENCES vaults(vault_id) ON DELETE RESTRICT,
                     operation_id BLOB NOT NULL CHECK(length(operation_id) = 16),
                     expected_revision INTEGER NOT NULL
                         CHECK(expected_revision BETWEEN 0 AND 9007199254740990),
                     applied_revision INTEGER NOT NULL
                         CHECK(applied_revision BETWEEN 1 AND 9007199254740991),
                     payload_digest BLOB NOT NULL CHECK(length(payload_digest) = 32),
                     encrypted_payload BLOB NOT NULL,
                     PRIMARY KEY (vault_id, operation_id),
                     UNIQUE (vault_id, applied_revision),
                     CHECK(applied_revision = expected_revision + 1)
                 ) STRICT;
                 PRAGMA user_version = 1;",
            )?;
        }
        1 => {}
        other => return Err(StoreError::UnsupportedSchema(other)),
    }
    transaction.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{sync::Arc, sync::Barrier, thread};

    use tempfile::tempdir;

    use super::*;

    fn vault(id: u8) -> VaultId {
        VaultId([id; 16])
    }

    fn operation(id: u8) -> OperationId {
        OperationId([id; 16])
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
            .execute_batch("PRAGMA user_version = 2")
            .unwrap();
        drop(store);

        assert!(matches!(
            SqliteStore::open(&path),
            Err(StoreError::UnsupportedSchema(2))
        ));
        let connection = Connection::open(path).unwrap();
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 2);
    }
}
