CREATE TABLE users (
    user_id BLOB NOT NULL PRIMARY KEY CHECK(length(user_id) = 16)
) STRICT;

CREATE TABLE devices (
    device_id BLOB NOT NULL PRIMARY KEY CHECK(length(device_id) = 16),
    user_id BLOB NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
    token_hash BLOB NOT NULL UNIQUE CHECK(length(token_hash) = 32),
    revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0, 1))
) STRICT;

CREATE TABLE vault_members (
    vault_id BLOB NOT NULL REFERENCES vaults(vault_id) ON DELETE RESTRICT,
    user_id BLOB NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
    role TEXT NOT NULL CHECK(role IN ('reader', 'writer', 'owner')),
    PRIMARY KEY (vault_id, user_id)
) STRICT;

PRAGMA user_version = 2;
