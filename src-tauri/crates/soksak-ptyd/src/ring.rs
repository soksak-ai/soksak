//! Bounded raw output ring with a monotonic sequence — the warm-handoff
//! substrate. `push` appends output bytes and advances `seq` (total bytes ever
//! emitted, the end coordinate); the ring retains only the most recent `cap`
//! bytes. `since(from_seq)` replays `[from_seq, seq)`; if `from_seq` predates
//! the retained window the evicted prefix is reported as a gap, never returned
//! as silently wrong bytes. A reattaching client hands the sequence it has
//! already accounted for and the ring streams exactly the tail after it — the
//! race-free coordinate the daemon-internal atomic injection lacked.

use std::collections::VecDeque;

pub struct RawRing {
    buf: VecDeque<u8>,
    cap: usize,
    // Total bytes ever pushed = the end sequence (exclusive). Monotonic.
    seq: u64,
}

impl RawRing {
    pub fn new(cap: usize) -> Self {
        RawRing { buf: VecDeque::new(), cap, seq: 0 }
    }

    /// End sequence — one past the last byte pushed.
    pub fn seq(&self) -> u64 {
        self.seq
    }

    /// Start sequence — the oldest byte still retained.
    pub fn start_seq(&self) -> u64 {
        self.seq - self.buf.len() as u64
    }

    /// Append output bytes; advance the sequence; evict the oldest bytes past
    /// the cap.
    pub fn push(&mut self, bytes: &[u8]) {
        self.buf.extend(bytes.iter().copied());
        self.seq += bytes.len() as u64;
        while self.buf.len() > self.cap {
            self.buf.pop_front();
        }
    }

    /// Replay from `from_seq`. Returns the retained tail
    /// `[max(from_seq, start_seq), seq)` and, when `from_seq` fell before the
    /// retained window, the evicted gap `[from_seq, start_seq)` so the caller
    /// learns of the loss instead of receiving a shifted stream. A `from_seq`
    /// at or beyond `seq` replays nothing (the caller is already current).
    pub fn since(&self, from_seq: u64) -> (Option<(u64, u64)>, Vec<u8>) {
        let start = self.start_seq();
        let (gap, effective_from) = if from_seq < start {
            (Some((from_seq, start)), start)
        } else if from_seq >= self.seq {
            (None, self.seq)
        } else {
            (None, from_seq)
        };
        let skip = (effective_from - start) as usize;
        let tail: Vec<u8> = self.buf.iter().skip(skip).copied().collect();
        (gap, tail)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_advances_sequence_and_retains_within_cap() {
        let mut r = RawRing::new(16);
        r.push(b"hello");
        assert_eq!(r.seq(), 5);
        assert_eq!(r.start_seq(), 0);
        r.push(b" world");
        assert_eq!(r.seq(), 11);
        assert_eq!(r.start_seq(), 0, "still within cap — nothing evicted");
    }

    #[test]
    fn since_replays_exactly_the_tail_after_from_seq() {
        let mut r = RawRing::new(64);
        r.push(b"abcdefghij"); // seq 0..10
        let (gap, tail) = r.since(4);
        assert_eq!(gap, None);
        assert_eq!(tail, b"efghij", "exactly [from_seq, seq)");
        // from_seq at the end replays nothing — the caller is already current
        let (gap, tail) = r.since(10);
        assert_eq!(gap, None);
        assert!(tail.is_empty());
    }

    #[test]
    fn eviction_advances_start_and_since_reports_a_gap_not_wrong_bytes() {
        let mut r = RawRing::new(4);
        r.push(b"abcdefgh"); // 8 bytes into a 4-cap ring
        assert_eq!(r.seq(), 8);
        assert_eq!(r.start_seq(), 4, "oldest 4 bytes evicted");
        // a client that had accounted only up to seq 1 asks to replay from 1 —
        // bytes [1,4) are gone. The ring must SAY so, not hand back a stream
        // that silently starts at 4 as if it were 1.
        let (gap, tail) = r.since(1);
        assert_eq!(gap, Some((1, 4)), "the evicted prefix is a loud gap");
        assert_eq!(tail, b"efgh", "the retained tail, correctly from start_seq");
    }
}
