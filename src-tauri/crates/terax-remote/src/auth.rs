use std::sync::OnceLock;

static EXPECTED: OnceLock<String> = OnceLock::new();

pub fn expect_token(token: &str) {
    let _ = EXPECTED.set(token.to_string());
}

pub fn check_token(presented: &str) -> bool {
    let Some(expected) = EXPECTED.get() else {
        return false;
    };
    constant_time_eq(expected.as_bytes(), presented.as_bytes())
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_mismatched_tokens() {
        assert!(!constant_time_eq(b"abcdef", b"abcdeg"));
        assert!(!constant_time_eq(b"short", b"longer"));
        assert!(constant_time_eq(b"abcdef", b"abcdef"));
    }
}
