//! Boot-relative monotonic clock.
//!
//! The daemon's drift detector compares wall-clock movement against this
//! clock. It must NOT reset when the daemon process restarts: a slow
//! sub-tolerance forward ratchet (+55s chunks, each under the per-tick
//! tolerance) chained with watchdog respawns would otherwise look like a
//! fresh baseline every time and eventually expire a multi-hour lock in
//! minutes. A boot-relative source keeps the persisted `clock-anchor.json`
//! comparable across daemon restarts and only re-anchors on an OS reboot
//! (when the value genuinely goes backwards).
//!
//! Linux: `/proc/uptime` (fractional seconds since boot).
//! Windows: `GetTickCount64` (milliseconds since boot).
//! Anything else: process-relative `Instant` fallback (documented degradation
//! of the cross-restart guarantee).

use std::sync::OnceLock;

/// Milliseconds since the OS booted (Linux/Windows), or since this process
/// started on unsupported platforms.
pub fn boot_mono_ms() -> u64 {
    #[cfg(target_os = "linux")]
    {
        if let Ok(contents) = std::fs::read_to_string("/proc/uptime") {
            if let Some(field) = contents.split_whitespace().next() {
                if let Ok(seconds) = field.parse::<f64>() {
                    if seconds.is_finite() && seconds >= 0.0 {
                        return (seconds * 1000.0) as u64;
                    }
                }
            }
        }
        process_relative_ms()
    }

    #[cfg(windows)]
    {
        // SAFETY: GetTickCount64 has no preconditions and returns milliseconds
        // since boot; it cannot fail.
        return unsafe { windows_sys::Win32::System::SystemInformation::GetTickCount64() as u64 };
    }

    #[cfg(not(any(target_os = "linux", windows)))]
    {
        process_relative_ms()
    }
}

fn process_relative_ms() -> u64 {
    static START: OnceLock<std::time::Instant> = OnceLock::new();
    START
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boot_clock_is_monotonic_and_nonzero() {
        let first = boot_mono_ms();
        assert!(first > 0, "boot-relative clock must be past boot");
        std::thread::sleep(std::time::Duration::from_millis(5));
        let second = boot_mono_ms();
        assert!(second >= first, "{second} must not precede {first}");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_boot_clock_is_not_process_relative() {
        // A process-relative clock starts near zero; a boot-relative one is
        // normally far past a second even on a freshly booted CI box.
        assert!(
            boot_mono_ms() > 1_000,
            "expected boot-relative milliseconds, got {}",
            boot_mono_ms()
        );
    }
}
