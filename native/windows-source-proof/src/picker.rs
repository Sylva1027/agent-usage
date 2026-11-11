use windows::{
    Win32::{
        Foundation::{ERROR_CANCELLED, HWND},
        System::Com::{
            CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
            CoTaskMemFree, CoUninitialize,
        },
        UI::{
            Shell::{
                FOS_FORCEFILESYSTEM, FOS_FORCESHOWHIDDEN, FOS_NOCHANGEDIR, FOS_PATHMUSTEXIST,
                FOS_PICKFOLDERS, FileOpenDialog, IFileOpenDialog, SIGDN_FILESYSPATH,
            },
            WindowsAndMessaging::GetForegroundWindow,
        },
    },
    core::{HRESULT, Result, w},
};

pub fn pick_directory() -> Result<String> {
    // A separate STA process keeps the modal dialog out of the source-proof protocol.
    unsafe {
        let owner = GetForegroundWindow();
        CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
        let result = show_dialog(owner);
        CoUninitialize();
        result
    }
}

unsafe fn show_dialog(owner: HWND) -> Result<String> {
    unsafe {
        let dialog: IFileOpenDialog =
            CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)?;
        dialog.SetOptions(
            dialog.GetOptions()?
                | FOS_PICKFOLDERS
                | FOS_FORCEFILESYSTEM
                | FOS_PATHMUSTEXIST
                | FOS_NOCHANGEDIR
                | FOS_FORCESHOWHIDDEN,
        )?;
        dialog.SetTitle(w!("Agent Usage — 选择记录目录"))?;
        // An owned dialog stays above the window where the user requested it.
        if let Err(error) = dialog.Show(Some(owner)) {
            if error.code() == HRESULT::from_win32(ERROR_CANCELLED.0) {
                return Ok(String::new());
            }
            return Err(error);
        }
        let selected = dialog.GetResult()?.GetDisplayName(SIGDN_FILESYSPATH)?;
        let path = selected.to_string();
        CoTaskMemFree(Some(selected.0.cast()));
        Ok(path?)
    }
}
