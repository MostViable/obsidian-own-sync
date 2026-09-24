use std::{path::PathBuf, sync::Arc};

use axum::{
    body::{to_bytes, Body},
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, Request, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Serialize;
use tokio::task;

use crate::{
    access::DeviceToken,
    revision::{CommitDecision, OperationId},
    store::{SqliteStore, StoreError, VaultId},
};

pub const MAX_PACKET_BYTES: usize = 1024 * 1024;
pub const PROTOCOL_VERSION: u32 = 0;
pub const PACKET_FORMAT_VERSION: u32 = 1;

#[derive(Clone)]
struct ApiState {
    db_path: Arc<PathBuf>,
}

pub fn router(db_path: Option<PathBuf>) -> Router {
    let health = Router::new().route("/healthz", get(health));
    let Some(db_path) = db_path else {
        return health;
    };

    let vaults = Router::new()
        .route("/api/v0/capabilities", get(capabilities))
        .route("/api/v0/vaults/{vault_id}/head", get(head))
        .route(
            "/api/v0/vaults/{vault_id}/commits/{revision}",
            get(read_packet),
        )
        .route(
            "/api/v0/vaults/{vault_id}/operations/{operation_id}",
            post(commit_packet),
        )
        .with_state(ApiState {
            db_path: Arc::new(db_path),
        });
    health.merge(vaults)
}

#[derive(Serialize)]
struct Health {
    status: &'static str,
}

async fn health() -> Json<Health> {
    Json(Health { status: "ok" })
}

#[derive(Serialize)]
struct Capabilities {
    protocol_version: u32,
    packet_format_version: u32,
    max_packet_bytes: usize,
}

async fn capabilities() -> Response {
    no_store(
        Json(Capabilities {
            protocol_version: PROTOCOL_VERSION,
            packet_format_version: PACKET_FORMAT_VERSION,
            max_packet_bytes: MAX_PACKET_BYTES,
        })
        .into_response(),
    )
}

#[derive(Serialize)]
struct HeadReply {
    current_revision: u64,
}

#[derive(Serialize)]
#[serde(tag = "result", rename_all = "snake_case")]
enum CommitReply {
    Applied { revision: u64 },
    Replayed { revision: u64 },
    Conflict { current_revision: u64 },
}

async fn head(
    State(state): State<ApiState>,
    Path(vault_id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let vault_id = VaultId(parse_hex(&vault_id)?);
    let token = bearer_token(&headers)?;
    let revision = with_store(state, move |store| {
        store.current_revision_for(&token, vault_id)
    })
    .await?;
    Ok(no_store(
        Json(HeadReply {
            current_revision: revision,
        })
        .into_response(),
    ))
}

async fn read_packet(
    State(state): State<ApiState>,
    Path((vault_id, revision)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let vault_id = VaultId(parse_hex(&vault_id)?);
    let revision = revision
        .parse::<u64>()
        .map_err(|_| ApiError::InvalidRequest)?;
    let token = bearer_token(&headers)?;
    let payload = with_store(state, move |store| {
        store.encrypted_payload_for(&token, vault_id, revision)
    })
    .await?
    .ok_or(ApiError::NotFound)?;
    let mut response = payload.into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    Ok(no_store(response))
}

async fn commit_packet(
    State(state): State<ApiState>,
    Path((vault_id, operation_id)): Path<(String, String)>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    let vault_id = VaultId(parse_hex(&vault_id)?);
    let operation_id = OperationId(parse_hex(&operation_id)?);
    let headers = request.headers();
    let token = bearer_token(&headers)?;
    let expected_revision = single_header(&headers, "x-expected-revision")?
        .parse::<u64>()
        .map_err(|_| ApiError::InvalidRequest)?;
    let token_bytes = token.0;
    with_store(state.clone(), move |store| {
        store.ensure_write_access(&DeviceToken(token_bytes), vault_id)
    })
    .await?;
    let body = to_bytes(request.into_body(), MAX_PACKET_BYTES)
        .await
        .map_err(|_| ApiError::PayloadTooLarge)?;
    let decision = with_store(state, move |store| {
        store.commit_authenticated(&token, vault_id, operation_id, expected_revision, &body)
    })
    .await?;

    let (status, reply) = match decision {
        CommitDecision::Apply { revision } => {
            (StatusCode::CREATED, CommitReply::Applied { revision })
        }
        CommitDecision::Replay { revision } => (StatusCode::OK, CommitReply::Replayed { revision }),
        CommitDecision::Conflict { current_revision } => (
            StatusCode::CONFLICT,
            CommitReply::Conflict { current_revision },
        ),
        CommitDecision::OperationIdReused => return Err(ApiError::OperationIdReused),
        CommitDecision::InvalidRevision => return Err(ApiError::InvalidRequest),
        CommitDecision::RevisionExhausted => return Err(ApiError::RevisionExhausted),
        CommitDecision::InconsistentState => return Err(ApiError::Internal),
    };
    Ok(no_store((status, Json(reply)).into_response()))
}

async fn with_store<T, F>(state: ApiState, operation: F) -> Result<T, ApiError>
where
    T: Send + 'static,
    F: FnOnce(&mut SqliteStore) -> Result<T, StoreError> + Send + 'static,
{
    task::spawn_blocking(move || {
        let mut store = SqliteStore::open_existing(&*state.db_path)?;
        operation(&mut store)
    })
    .await
    .map_err(|_| ApiError::Internal)?
    .map_err(ApiError::from)
}

fn parse_hex<const N: usize>(value: &str) -> Result<[u8; N], ApiError> {
    let mut bytes = [0_u8; N];
    hex::decode_to_slice(value, &mut bytes).map_err(|_| ApiError::InvalidRequest)?;
    Ok(bytes)
}

fn single_header<'a>(headers: &'a HeaderMap, name: &str) -> Result<&'a str, ApiError> {
    let mut values = headers.get_all(name).iter();
    let value = values.next().ok_or(ApiError::InvalidRequest)?;
    if values.next().is_some() {
        return Err(ApiError::InvalidRequest);
    }
    value.to_str().map_err(|_| ApiError::InvalidRequest)
}

fn bearer_token(headers: &HeaderMap) -> Result<DeviceToken, ApiError> {
    let mut values = headers.get_all(header::AUTHORIZATION).iter();
    let value = values.next().ok_or(ApiError::Unauthorized)?;
    if values.next().is_some() {
        return Err(ApiError::Unauthorized);
    }
    let value = value.to_str().map_err(|_| ApiError::Unauthorized)?;
    let encoded = value
        .strip_prefix("Bearer ")
        .ok_or(ApiError::Unauthorized)?;
    parse_hex(encoded)
        .map(DeviceToken)
        .map_err(|_| ApiError::Unauthorized)
}

fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

enum ApiError {
    InvalidRequest,
    Unauthorized,
    NotFound,
    PayloadTooLarge,
    OperationIdReused,
    RevisionExhausted,
    Internal,
}

impl From<StoreError> for ApiError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::Unauthorized => Self::Unauthorized,
            StoreError::UnknownVault => Self::NotFound,
            _ => Self::Internal,
        }
    }
}

#[derive(Serialize)]
struct ErrorReply {
    error: &'static str,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, error) = match self {
            Self::InvalidRequest => (StatusCode::BAD_REQUEST, "invalid_request"),
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            Self::NotFound => (StatusCode::NOT_FOUND, "not_found"),
            Self::PayloadTooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "packet_too_large"),
            Self::OperationIdReused => (StatusCode::CONFLICT, "operation_id_reused"),
            Self::RevisionExhausted => (StatusCode::CONFLICT, "revision_exhausted"),
            Self::Internal => (StatusCode::INTERNAL_SERVER_ERROR, "internal_error"),
        };
        no_store((status, Json(ErrorReply { error })).into_response())
    }
}

#[cfg(test)]
mod tests {
    use axum::{
        body::{to_bytes, Body, Bytes},
        http::{Method, Request},
    };
    use serde_json::Value;
    use tempfile::{tempdir, TempDir};
    use tower::ServiceExt;

    use super::*;
    use crate::access::DeviceId;

    fn fixture() -> (TempDir, Router, PathBuf, VaultId, DeviceId, DeviceToken) {
        let directory = tempdir().unwrap();
        let path = directory.path().join("sync.sqlite");
        let mut store = SqliteStore::open(&path).unwrap();
        let user_id = store.create_user().unwrap();
        let (device_id, token) = store.issue_device(user_id).unwrap();
        let vault_id = store.create_vault_for_owner(user_id).unwrap();
        drop(store);
        let app = router(Some(path.clone()));
        (directory, app, path, vault_id, device_id, token)
    }

    fn request(
        method: Method,
        uri: &str,
        token: Option<&DeviceToken>,
        expected_revision: Option<&str>,
        body: Body,
    ) -> Request<Body> {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(token) = token {
            builder = builder.header(
                header::AUTHORIZATION,
                format!("Bearer {}", hex::encode(token.0)),
            );
        }
        if let Some(revision) = expected_revision {
            builder = builder.header("x-expected-revision", revision);
        }
        builder.body(body).unwrap()
    }

    async fn json(response: Response) -> Value {
        let body = to_bytes(response.into_body(), 1024).await.unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    #[tokio::test]
    async fn only_health_is_available_without_experimental_database() {
        let app = router(None);
        let response = app
            .clone()
            .oneshot(request(Method::GET, "/healthz", None, None, Body::empty()))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(json(response).await["status"], "ok");

        let response = app
            .oneshot(request(
                Method::GET,
                "/api/v0/vaults/00000000000000000000000000000000/head",
                None,
                None,
                Body::empty(),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn capabilities_report_protocol_and_limits() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("sync.sqlite");
        let app = router(Some(path));
        let response = app
            .oneshot(request(
                Method::GET,
                "/api/v0/capabilities",
                None,
                None,
                Body::empty(),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let body = json(response).await;
        assert_eq!(body["protocol_version"], PROTOCOL_VERSION);
        assert_eq!(body["packet_format_version"], PACKET_FORMAT_VERSION);
        assert_eq!(body["max_packet_bytes"], MAX_PACKET_BYTES);
    }

    #[tokio::test]
    async fn authenticated_packet_round_trip_and_retry() {
        let (_directory, app, _path, vault_id, _device_id, token) = fixture();
        let head_uri = format!("/api/v0/vaults/{}/head", hex::encode(vault_id.0));
        let commit_uri = format!(
            "/api/v0/vaults/{}/operations/{}",
            hex::encode(vault_id.0),
            hex::encode([1_u8; 16])
        );
        let packet_uri = format!("/api/v0/vaults/{}/commits/1", hex::encode(vault_id.0));

        let response = app
            .clone()
            .oneshot(request(Method::GET, &head_uri, None, None, Body::empty()))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        let response = app
            .clone()
            .oneshot(request(
                Method::POST,
                &commit_uri,
                Some(&token),
                Some("0"),
                Body::from("encrypted-packet"),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        assert_eq!(json(response).await["revision"], 1);

        let response = app
            .clone()
            .oneshot(request(
                Method::POST,
                &commit_uri,
                Some(&token),
                Some("0"),
                Body::from("encrypted-packet"),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(json(response).await["result"], "replayed");

        let response = app
            .clone()
            .oneshot(request(
                Method::GET,
                &head_uri,
                Some(&token),
                None,
                Body::empty(),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(json(response).await["current_revision"], 1);

        let response = app
            .oneshot(request(
                Method::GET,
                &packet_uri,
                Some(&token),
                None,
                Body::empty(),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "application/octet-stream"
        );
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(
            to_bytes(response.into_body(), 1024).await.unwrap(),
            Bytes::from_static(b"encrypted-packet")
        );
    }

    #[tokio::test]
    async fn conflict_changed_retry_and_revoked_device_are_rejected() {
        let (_directory, app, path, vault_id, device_id, token) = fixture();
        let first_uri = format!(
            "/api/v0/vaults/{}/operations/{}",
            hex::encode(vault_id.0),
            hex::encode([1_u8; 16])
        );
        let second_uri = format!(
            "/api/v0/vaults/{}/operations/{}",
            hex::encode(vault_id.0),
            hex::encode([2_u8; 16])
        );
        let head_uri = format!("/api/v0/vaults/{}/head", hex::encode(vault_id.0));

        let response = app
            .clone()
            .oneshot(request(
                Method::POST,
                &first_uri,
                Some(&token),
                Some("0"),
                Body::from("first"),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);

        let response = app
            .clone()
            .oneshot(request(
                Method::POST,
                &second_uri,
                Some(&token),
                Some("0"),
                Body::from("second"),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(json(response).await["current_revision"], 1);

        let response = app
            .clone()
            .oneshot(request(
                Method::POST,
                &first_uri,
                Some(&token),
                Some("0"),
                Body::from("changed"),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(json(response).await["error"], "operation_id_reused");

        let mut store = SqliteStore::open(path).unwrap();
        assert!(store.revoke_device(&token, device_id).unwrap());
        let response = app
            .oneshot(request(
                Method::GET,
                &head_uri,
                Some(&token),
                None,
                Body::empty(),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn packet_limit_is_enforced() {
        let (_directory, app, _path, vault_id, _device_id, token) = fixture();
        let uri = format!(
            "/api/v0/vaults/{}/operations/{}",
            hex::encode(vault_id.0),
            hex::encode([1_u8; 16])
        );
        let response = app
            .clone()
            .oneshot(request(
                Method::POST,
                &uri,
                Some(&token),
                Some("0"),
                Body::from(vec![0_u8; MAX_PACKET_BYTES + 1]),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);

        let response = app
            .oneshot(request(
                Method::POST,
                &uri,
                None,
                Some("0"),
                Body::from(vec![0_u8; MAX_PACKET_BYTES + 1]),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
}
