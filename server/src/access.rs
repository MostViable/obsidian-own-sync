use std::fmt;

use sha2::{Digest, Sha256};

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct UserId(pub [u8; 16]);

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct DeviceId(pub [u8; 16]);

pub struct DeviceToken(pub [u8; 32]);

impl fmt::Debug for DeviceToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("DeviceToken([REDACTED])")
    }
}

impl DeviceToken {
    pub(crate) fn digest(&self) -> [u8; 32] {
        let mut bytes = [0_u8; 32];
        bytes.copy_from_slice(&Sha256::digest(self.0));
        bytes
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum VaultRole {
    Reader,
    Writer,
    Owner,
}

impl VaultRole {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Reader => "reader",
            Self::Writer => "writer",
            Self::Owner => "owner",
        }
    }

    pub(crate) fn can_write(self) -> bool {
        matches!(self, Self::Writer | Self::Owner)
    }

    pub(crate) fn from_str(value: &str) -> Option<Self> {
        match value {
            "reader" => Some(Self::Reader),
            "writer" => Some(Self::Writer),
            "owner" => Some(Self::Owner),
            _ => None,
        }
    }
}
