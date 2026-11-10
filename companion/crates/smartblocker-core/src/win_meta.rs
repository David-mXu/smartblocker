//! Live Windows process metadata that `sysinfo` does not expose.
//!
//! The app picker and the enforcer both need to know whether a process is a
//! Microsoft Store (MSIX) app. Windows answers with the *package family
//! name* (`GetPackageFamilyName`, e.g.
//! `Microsoft.WindowsCalculator_8wekyb3d8bbwe`), which is stable across app
//! versions — unlike the package full name and unlike an install path under
//! `WindowsApps`. A process outside a package reports
//! `APPMODEL_ERROR_NO_PACKAGE`; that is a normal `None`, never an error.
//!
//! This module is Windows-only in practice; the stub returns `None` on every
//! other platform so the pure matcher and its tests run under Linux.

/// Query one pid's MSIX package family name. Best-effort: an unreadable or
/// protected process, or a non-packaged process, is simply `None`.
#[cfg(windows)]
pub fn process_package_family(pid: u32) -> Option<String> {
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_INSUFFICIENT_BUFFER};
    use windows_sys::Win32::Storage::Packaging::Appx::GetPackageFamilyName;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    const ERROR_SUCCESS: u32 = 0;

    // SAFETY: the handle is closed on every path after a successful open,
    // and both calls write only into buffers we own for their duration.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut length = 0u32;
        // First call asks for the required buffer length (including NUL).
        let probe = GetPackageFamilyName(handle, &mut length, std::ptr::null_mut());
        if probe != ERROR_INSUFFICIENT_BUFFER || length == 0 {
            CloseHandle(handle);
            return None;
        }
        let mut buffer = vec![0u16; length as usize];
        let result = GetPackageFamilyName(handle, &mut length, buffer.as_mut_ptr());
        CloseHandle(handle);
        if result != ERROR_SUCCESS || length == 0 {
            return None;
        }
        let text = String::from_utf16_lossy(&buffer[..length as usize - 1]);
        crate::app_targets::normalize_package_family(&text)
    }
}

#[cfg(not(windows))]
pub fn process_package_family(_pid: u32) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_windows_metadata_is_absent_not_an_error() {
        // The current process is running, but it has no MSIX identity here.
        assert_eq!(process_package_family(std::process::id()), None);
    }
}
