use std::{
    error::Error,
    fs::OpenOptions,
    io::{self, Write},
    path::Path,
};

#[cfg(unix)]
use std::{fs::File, os::unix::fs::OpenOptionsExt};

use serde::Serialize;
use tempfile::NamedTempFile;

use crate::store::SqliteStore;

#[derive(Serialize)]
struct Credentials {
    format_version: u32,
    user_id: String,
    device_id: String,
    vault_id: String,
    token: String,
}

/// Creates a fresh test database and writes its first device token to a new private file.
pub fn bootstrap(db_path: &Path, credentials_path: &Path) -> Result<(), Box<dyn Error>> {
    if credentials_path.symlink_metadata().is_ok() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "credentials path already exists",
        )
        .into());
    }
    let credentials_dir = credentials_path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut credentials_file = NamedTempFile::new_in(credentials_dir)?;

    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let db_file = options.open(db_path)?;
    db_file.sync_all()?;
    drop(db_file);

    let mut store = SqliteStore::open_existing(db_path)?;
    let identity = store.bootstrap_owner()?;
    let credentials = Credentials {
        format_version: 1,
        user_id: hex::encode(identity.user_id.0),
        device_id: hex::encode(identity.device_id.0),
        vault_id: hex::encode(identity.vault_id.0),
        token: hex::encode(identity.token.0),
    };
    serde_json::to_writer_pretty(&mut credentials_file, &credentials)?;
    credentials_file.write_all(b"\n")?;
    credentials_file.as_file().sync_all()?;
    let saved_file = credentials_file
        .persist_noclobber(credentials_path)
        .map_err(|error| error.error)?;
    saved_file.sync_all()?;
    sync_directory(credentials_dir)?;
    if let Some(db_dir) = db_path.parent().filter(|path| !path.as_os_str().is_empty()) {
        sync_directory(db_dir)?;
    }
    Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs::{self, File};

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    use serde_json::Value;
    use tempfile::tempdir;

    use super::*;
    use crate::{access::DeviceToken, store::VaultId};

    #[test]
    fn bootstrap_creates_private_credentials_and_an_authorized_vault() {
        let directory = tempdir().unwrap();
        let db_path = directory.path().join("sync.sqlite");
        let credentials_path = directory.path().join("device.json");
        bootstrap(&db_path, &credentials_path).unwrap();

        #[cfg(unix)]
        {
            assert_eq!(
                fs::metadata(&db_path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(&credentials_path)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        let credentials: Value =
            serde_json::from_reader(File::open(&credentials_path).unwrap()).unwrap();
        assert_eq!(credentials["format_version"], 1);
        let mut vault_id = [0_u8; 16];
        let mut token = [0_u8; 32];
        hex::decode_to_slice(credentials["vault_id"].as_str().unwrap(), &mut vault_id).unwrap();
        hex::decode_to_slice(credentials["token"].as_str().unwrap(), &mut token).unwrap();
        let mut store = SqliteStore::open_existing(&db_path).unwrap();
        assert_eq!(
            store
                .current_revision_for(&DeviceToken(token), VaultId(vault_id))
                .unwrap(),
            0
        );
    }

    #[test]
    fn bootstrap_never_overwrites_existing_paths() {
        let directory = tempdir().unwrap();
        let db_path = directory.path().join("sync.sqlite");
        let credentials_path = directory.path().join("device.json");
        fs::write(&credentials_path, b"existing credentials").unwrap();
        assert!(bootstrap(&db_path, &credentials_path).is_err());
        assert!(!db_path.exists());
        assert_eq!(
            fs::read(&credentials_path).unwrap(),
            b"existing credentials"
        );

        let other_credentials = directory.path().join("other-device.json");
        fs::write(&db_path, b"existing database").unwrap();
        assert!(bootstrap(&db_path, &other_credentials).is_err());
        assert!(!other_credentials.exists());
        assert_eq!(fs::read(&db_path).unwrap(), b"existing database");
    }
}
