using System;
using System.Runtime.InteropServices;
using System.Text;

// GUI subsystem: no console. Hand the worker off outside any inherited process job.
internal static class UpdateLauncher {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo {
        public int size; public string reserved, desktop, title;
        public int x, y, width, height, charsX, charsY, fill, flags;
        public short show, reservedSize; public IntPtr reservedPointer, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory,
        ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [STAThread]
    private static int Main(string[] args) {
        if (args.Length != 1 || !System.Text.RegularExpressions.Regex.IsMatch(args[0], "^[A-Za-z0-9+/=]+$")) return 2;
        string host = System.IO.Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe");
        var command = new StringBuilder("\"" + host + "\" -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " + args[0]);
        var startup = new StartupInfo(); startup.size = Marshal.SizeOf(typeof(StartupInfo));
        startup.flags = 1; startup.show = 0;
        ProcessInfo child;
        // CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW. No inherited pipe handles.
        if (!CreateProcess(host, command, IntPtr.Zero, IntPtr.Zero, false, 0x01000000 | 0x08000000,
            IntPtr.Zero, System.IO.Path.GetTempPath(), ref startup, out child)) return Marshal.GetLastWin32Error();
        CloseHandle(child.thread); CloseHandle(child.process);
        return 0;
    }
}
