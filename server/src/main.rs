use std::{env, error::Error, net::SocketAddr};

use axum::{routing::get, Json, Router};
use serde::Serialize;

#[derive(Serialize)]
struct Health {
    status: &'static str,
}

async fn health() -> Json<Health> {
    Json(Health { status: "ok" })
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let bind: SocketAddr = env::var("OWN_SYNC_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8787".to_string())
        .parse()?;

    let app = Router::new().route("/healthz", get(health));
    let listener = tokio::net::TcpListener::bind(bind).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
