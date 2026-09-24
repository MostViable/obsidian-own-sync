/// Highest revision that can be represented exactly as a JSON number in JavaScript.
pub const MAX_REVISION: u64 = (1_u64 << 53) - 1;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct OperationId(pub [u8; 16]);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PayloadDigest(pub [u8; 32]);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CommitRequest {
    pub operation_id: OperationId,
    pub expected_revision: u64,
    pub payload_digest: PayloadDigest,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AppliedCommit {
    pub operation_id: OperationId,
    pub expected_revision: u64,
    pub payload_digest: PayloadDigest,
    pub applied_revision: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CommitDecision {
    Apply { revision: u64 },
    Replay { revision: u64 },
    Conflict { current_revision: u64 },
    OperationIdReused,
    InvalidRevision,
    RevisionExhausted,
    InconsistentState,
}

/// Decides a vault commit after authorization and while its storage transaction is held.
/// `previous` is the operation record for this vault and request ID, if one exists.
pub fn decide_commit(
    current_revision: u64,
    previous: Option<&AppliedCommit>,
    request: &CommitRequest,
) -> CommitDecision {
    if current_revision > MAX_REVISION || request.expected_revision > MAX_REVISION {
        return CommitDecision::InvalidRevision;
    }

    if let Some(previous) = previous {
        if previous.operation_id != request.operation_id {
            return CommitDecision::InconsistentState;
        }
        if previous.expected_revision != request.expected_revision
            || previous.payload_digest != request.payload_digest
        {
            return CommitDecision::OperationIdReused;
        }
        if previous.applied_revision != previous.expected_revision + 1
            || previous.applied_revision > current_revision
        {
            return CommitDecision::InconsistentState;
        }
        return CommitDecision::Replay {
            revision: previous.applied_revision,
        };
    }

    if request.expected_revision != current_revision {
        return CommitDecision::Conflict { current_revision };
    }
    if current_revision == MAX_REVISION {
        return CommitDecision::RevisionExhausted;
    }

    CommitDecision::Apply {
        revision: current_revision + 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(id: u8, expected_revision: u64, payload: u8) -> CommitRequest {
        CommitRequest {
            operation_id: OperationId([id; 16]),
            expected_revision,
            payload_digest: PayloadDigest([payload; 32]),
        }
    }

    fn applied(request: CommitRequest, applied_revision: u64) -> AppliedCommit {
        AppliedCommit {
            operation_id: request.operation_id,
            expected_revision: request.expected_revision,
            payload_digest: request.payload_digest,
            applied_revision,
        }
    }

    #[test]
    fn competing_writes_cannot_both_advance_the_same_revision() {
        let first = request(1, 0, 11);
        let second = request(2, 0, 22);

        assert_eq!(
            decide_commit(0, None, &first),
            CommitDecision::Apply { revision: 1 }
        );
        assert_eq!(
            decide_commit(1, None, &second),
            CommitDecision::Conflict {
                current_revision: 1
            }
        );
        assert_eq!(
            decide_commit(1, None, &request(2, 1, 22)),
            CommitDecision::Apply { revision: 2 }
        );
    }

    #[test]
    fn retry_replays_original_result_even_after_other_commits() {
        let first = request(1, 0, 11);
        let previous = applied(first, 1);

        assert_eq!(
            decide_commit(3, Some(&previous), &first),
            CommitDecision::Replay { revision: 1 }
        );
    }

    #[test]
    fn operation_id_cannot_be_reused_with_changed_payload_or_base() {
        let first = request(1, 0, 11);
        let previous = applied(first, 1);

        assert_eq!(
            decide_commit(1, Some(&previous), &request(1, 0, 12)),
            CommitDecision::OperationIdReused
        );
        assert_eq!(
            decide_commit(1, Some(&previous), &request(1, 1, 11)),
            CommitDecision::OperationIdReused
        );
    }

    #[test]
    fn stale_request_does_not_consume_its_operation_id() {
        let stale = request(1, 0, 11);
        assert_eq!(
            decide_commit(1, None, &stale),
            CommitDecision::Conflict {
                current_revision: 1
            }
        );
        assert_eq!(
            decide_commit(1, None, &request(1, 1, 12)),
            CommitDecision::Apply { revision: 2 }
        );
    }

    #[test]
    fn revision_limit_never_wraps_or_loses_json_precision() {
        assert_eq!(
            decide_commit(MAX_REVISION - 1, None, &request(1, MAX_REVISION - 1, 11)),
            CommitDecision::Apply {
                revision: MAX_REVISION
            }
        );
        assert_eq!(
            decide_commit(MAX_REVISION, None, &request(2, MAX_REVISION, 22)),
            CommitDecision::RevisionExhausted
        );
        assert_eq!(
            decide_commit(MAX_REVISION, None, &request(3, MAX_REVISION + 1, 33)),
            CommitDecision::InvalidRevision
        );
    }

    #[test]
    fn impossible_stored_result_is_rejected() {
        let first = request(1, 0, 11);
        let previous = applied(first, 2);
        assert_eq!(
            decide_commit(3, Some(&previous), &first),
            CommitDecision::InconsistentState
        );

        let wrong_lookup = applied(request(2, 0, 11), 1);
        assert_eq!(
            decide_commit(1, Some(&wrong_lookup), &first),
            CommitDecision::InconsistentState
        );
    }
}
