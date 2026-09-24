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
        Some(_) => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "usage: own-sync-server [bootstrap <database-path> <credentials-path>]",
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
