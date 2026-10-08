using System;
using System.Runtime.InteropServices;

namespace Vide.Desktop
{
    /// <summary>
    /// The Windows Explorer-style folder dialog (<c>IFileOpenDialog</c> with <c>FOS_PICKFOLDERS</c>):
    /// Quick Access (즐겨찾기), the address bar, search and a resizable window that remembers its size.
    /// .NET Framework 4.8's <c>FolderBrowserDialog</c> is the old <c>SHBrowseForFolder</c> tree, so the
    /// shell calls the COM dialog itself (SPEC-01.13, ARCH-01 §3). Written in C# 5 so the manual check
    /// <c>tests/integration/manual-folder-picker.ps1</c> can compile this file with Add-Type.
    /// </summary>
    public static class FolderPicker
    {
        const uint FOS_NOCHANGEDIR = 0x8;
        const uint FOS_PICKFOLDERS = 0x20;
        const uint FOS_FORCEFILESYSTEM = 0x40;
        const uint FOS_PATHMUSTEXIST = 0x800;
        const uint SIGDN_FILESYSPATH = 0x80058000;
        const int ERROR_CANCELLED = unchecked((int)0x800704C7);

        /// <summary>Its own remembered folder and window size, apart from other programs' dialogs.</summary>
        static readonly Guid Client = new Guid("6f1b2c0e-5d1a-4f7e-9a39-2c1f0d7e4a51");

        /// <summary>
        /// Opens the dialog over <paramref name="owner"/> and returns the chosen folder's file-system
        /// path (a drive letter path, a mapped drive's letter or a UNC path), or null when cancelled.
        /// Throws when the dialog cannot be created or shown; the caller falls back to the old picker.
        /// </summary>
        public static string Pick(IntPtr owner, string title)
        {
            IFileDialog dialog = null;
            IShellItem item = null;
            try
            {
                dialog = (IFileDialog)new FileOpenDialogClass();
                uint options;
                dialog.GetOptions(out options);
                dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_NOCHANGEDIR);
                if (!string.IsNullOrEmpty(title)) dialog.SetTitle(title);
                Guid client = Client;
                dialog.SetClientGuid(ref client);
                int shown = dialog.Show(owner);
                if (shown == ERROR_CANCELLED) return null;
                Marshal.ThrowExceptionForHR(shown);
                Marshal.ThrowExceptionForHR(dialog.GetResult(out item));
                IntPtr text;
                Marshal.ThrowExceptionForHR(item.GetDisplayName(SIGDN_FILESYSPATH, out text));
                try { return Marshal.PtrToStringUni(text); }
                finally { Marshal.FreeCoTaskMem(text); }
            }
            finally
            {
                if (item != null) Marshal.ReleaseComObject(item);
                if (dialog != null) Marshal.ReleaseComObject(dialog);
            }
        }

        [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
        class FileOpenDialogClass { }

        [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IFileDialog
        {
            [PreserveSig] int Show(IntPtr parent);
            void SetFileTypes(uint count, IntPtr specs);
            void SetFileTypeIndex(uint index);
            void GetFileTypeIndex(out uint index);
            void Advise(IntPtr events, out uint cookie);
            void Unadvise(uint cookie);
            void SetOptions(uint options);
            void GetOptions(out uint options);
            void SetDefaultFolder(IShellItem item);
            void SetFolder(IShellItem item);
            void GetFolder(out IShellItem item);
            void GetCurrentSelection(out IShellItem item);
            void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
            void GetFileName(out IntPtr name);
            void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
            void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
            void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
            [PreserveSig] int GetResult(out IShellItem item);
            void AddPlace(IShellItem item, int place);
            void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
            void Close(int result);
            void SetClientGuid(ref Guid guid);
            void ClearClientData();
            void SetFilter(IntPtr filter);
        }

        [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IShellItem
        {
            void BindToHandler(IntPtr context, ref Guid handler, ref Guid riid, out IntPtr value);
            void GetParent(out IShellItem parent);
            [PreserveSig] int GetDisplayName(uint form, out IntPtr name);
            void GetAttributes(uint mask, out uint attributes);
            void Compare(IShellItem other, uint hint, out int order);
        }
    }
}
