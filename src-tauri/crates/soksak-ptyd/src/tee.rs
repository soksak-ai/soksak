//! Per-subscriber tee buffer — bounded, order-preserving, gap-on-overflow. The
//! output reader enqueues copies with a non-blocking call; a slow subscriber
//! loses data as a recorded gap (never a silent drop) and can never make the
//! enqueue block or grow without bound, so it can never stall the live path.
//! The subscriber's own writer thread drains this buffer to its socket — the
//! only place tee socket I/O happens, off the reader's thread.

use std::collections::VecDeque;

pub enum TeeFrame {
    /// A raw output copy.
    Data(Vec<u8>),
    /// Dropped range `[from_seq, to_seq)` — bytes the buffer could not hold.
    Gap(u64, u64),
}

pub struct TeeBuf {
    frames: VecDeque<TeeFrame>,
    // Queued Data bytes only — the cap bounds retained data, gaps are free.
    bytes: usize,
    cap: usize,
    pub closed: bool,
}

impl TeeBuf {
    pub fn new(cap: usize) -> Self {
        TeeBuf { frames: VecDeque::new(), bytes: 0, cap, closed: false }
    }

    pub fn is_empty(&self) -> bool {
        self.frames.is_empty()
    }

    /// Queued Data bytes — bounded by `cap` at all times. The boundedness
    /// accessor the tests assert on; the daemon reads it for no control flow.
    #[allow(dead_code)]
    pub fn buffered(&self) -> usize {
        self.bytes
    }

    /// Enqueue a raw copy of `[seq0, seq0 + bytes.len())`. Within cap it queues
    /// a Data frame; over cap it drops and records (or extends) a trailing Gap
    /// so order is preserved — the gap sits exactly between the data queued
    /// before and after it. O(1)-bounded and non-blocking: the reader that
    /// calls this never waits on subscriber I/O and never grows this buffer
    /// past `cap` bytes of data.
    pub fn push_data(&mut self, seq0: u64, bytes: &[u8]) {
        if self.bytes + bytes.len() <= self.cap {
            self.frames.push_back(TeeFrame::Data(bytes.to_vec()));
            self.bytes += bytes.len();
        } else {
            let to = seq0 + bytes.len() as u64;
            match self.frames.back_mut() {
                Some(TeeFrame::Gap(_from, gap_to)) => *gap_to = to,
                _ => self.frames.push_back(TeeFrame::Gap(seq0, to)),
            }
        }
    }

    /// Drain every queued frame in order, resetting the data byte count.
    pub fn drain(&mut self) -> Vec<TeeFrame> {
        self.bytes = 0;
        self.frames.drain(..).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(frames: &[TeeFrame]) -> Vec<String> {
        frames
            .iter()
            .map(|f| match f {
                TeeFrame::Data(d) => format!("data:{}", String::from_utf8_lossy(d)),
                TeeFrame::Gap(a, b) => format!("gap:{a}-{b}"),
            })
            .collect()
    }

    #[test]
    fn within_cap_queues_data() {
        let mut b = TeeBuf::new(16);
        b.push_data(0, b"hello");
        assert_eq!(b.buffered(), 5);
        assert_eq!(kinds(&b.drain()), vec!["data:hello"]);
    }

    // The M1.2 guarantee: a subscriber that never drains cannot make the
    // enqueue block or grow — it stays bounded and the loss surfaces as a gap,
    // never a silent drop.
    #[test]
    fn a_slow_subscriber_stays_bounded_and_loses_data_loudly_not_silently() {
        let mut b = TeeBuf::new(8);
        b.push_data(0, b"12345678"); // exactly fills the cap
        assert_eq!(b.buffered(), 8);
        // 4 KB more arrives while the subscriber never drains
        for i in 0..500u64 {
            b.push_data(8 + i * 8, b"OVERFLOW");
        }
        assert!(b.buffered() <= 8, "bounded — the enqueue never grows past cap");
        let frames = b.drain();
        // exactly one Data (the first fill) then one Gap covering everything
        // dropped — the loss is announced, never silent.
        assert_eq!(kinds(&frames), vec!["data:12345678", "gap:8-4008"]);
    }

    #[test]
    fn order_is_preserved_across_a_gap() {
        let mut b = TeeBuf::new(4);
        b.push_data(0, b"AB"); // fits (2 <= 4)
        b.push_data(2, b"CDEFGH"); // overflow → gap [2,8)
        // drain frees room, then more data arrives after the gap
        // (simulate: without draining, the next fitting write still orders after
        // the gap because push appends)
        let frames = b.drain();
        assert_eq!(kinds(&frames), vec!["data:AB", "gap:2-8"]);
        b.push_data(8, b"IJ");
        assert_eq!(kinds(&b.drain()), vec!["data:IJ"]);
    }

    #[test]
    fn consecutive_overflows_extend_one_gap() {
        let mut b = TeeBuf::new(2);
        b.push_data(0, b"ab"); // fills cap
        b.push_data(2, b"cd"); // overflow → gap [2,4)
        b.push_data(4, b"ef"); // overflow → extend gap to [2,6)
        assert_eq!(kinds(&b.drain()), vec!["data:ab", "gap:2-6"]);
    }
}
