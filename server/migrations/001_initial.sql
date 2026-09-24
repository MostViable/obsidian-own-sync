CREATE TABLE vaults (
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

PRAGMA user_version = 1;
