use std::{env, error::Error, io, net::SocketAddr, path::PathBuf};

use own_sync_server::{api, store::SqliteStore};

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
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
            SqliteStore::open(&path)?;
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
