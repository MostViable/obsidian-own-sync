use std::{env, error::Error, io, net::SocketAddr, path::PathBuf};

use own_sync_server::{api, bootstrap, store::SqliteStore};

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let mut arguments = env::args_os().skip(1);
    match arguments.next() {
        Some(command) if command == "bootstrap" => {
            let db_path = arguments.next().ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "bootstrap needs a database path",
                )
            })?;
            let credentials_path = arguments.next().ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "bootstrap needs a credentials path",
                )
            })?;
            if arguments.next().is_some() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "bootstrap accepts only a database path and a credentials path",
                )
                .into());
            }
            let db_path = PathBuf::from(db_path);
            let credentials_path = PathBuf::from(credentials_path);
            bootstrap::bootstrap(&db_path, &credentials_path)?;
            println!(
                "Bootstrap credentials written to {}",
                credentials_path.display()
            );
            return Ok(());
        }
        Some(command) if command == "provision" => {
            let db_path = arguments.next().ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "provision needs a database path",
                )
            })?;
            let owner_credentials_path = arguments.next().ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "provision needs owner credentials path",
                )
            })?;
            let device_credentials_path = arguments.next().ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "provision needs device credentials path",
                )
            })?;
            if arguments.next().is_some() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "provision accepts a database path, owner credentials path and device credentials path",
                )
                .into());
            }
            let db_path = PathBuf::from(db_path);
            let owner_credentials_path = PathBuf::from(owner_credentials_path);
            let device_credentials_path = PathBuf::from(device_credentials_path);
            bootstrap::provision_device(
                &db_path,
                &owner_credentials_path,
                &device_credentials_path,
            )?;
            println!(
                "Device credentials written to {}",
                device_credentials_path.display()
            );
            return Ok(());
        }
        Some(command) if command == "backup" => {
            let db_path = arguments.next().ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "backup needs a database path",
                )
            })?;
            let backup_path = arguments.next().ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "backup needs a destination path",
                )
            })?;
            if arguments.next().is_some() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "backup accepts only a database path and a destination path",
                )
                .into());
            }
            let mut store = SqliteStore::open_existing(PathBuf::from(db_path))?;
            let backup_path = PathBuf::from(backup_path);
            store.backup_to(&backup_path)?;
            println!("Backup written to {}", backup_path.display());
            return Ok(());
        }
        Some(_) => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "usage: own-sync-server [bootstrap <database-path> <credentials-path> | provision <database-path> <owner-credentials-path> <device-credentials-path> | backup <database-path> <backup-path>]",
            )
            .into());
        }
        None => {}
    }

    let bind: SocketAddr = env::var("OWN_SYNC_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8787".to_string())
        .parse()?;

    let db_path = match env::var("OWN_SYNC_EXPERIMENTAL_API") {
        Ok(value) if value == "1" => {
            let path = env::var_os("OWN_SYNC_DB").ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "OWN_SYNC_DB is required when the experimental API is enabled",
                )
            })?;
            let path = PathBuf::from(path);
            SqliteStore::open_existing(&path)?;
            Some(path)
        }
        Ok(_) => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "OWN_SYNC_EXPERIMENTAL_API must be 1 when set",
            )
            .into());
        }
        Err(env::VarError::NotPresent) => None,
        Err(error) => return Err(error.into()),
    };

    let app = api::router(db_path);
    let listener = tokio::net::TcpListener::bind(bind).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
