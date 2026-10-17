// Read-only Win32 geometry bridge. Compiled once with Windows' .NET Framework;
// runs only while a desktop laser trail is alive. No mouse hooks or input injection.
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Diagnostics;

internal static class DesktopLaserGeometry
{
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct MonitorInfo {
        public int Size; public Rect Monitor, Work; public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Device;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct DisplayDevice {
        public int Size;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Name;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Description;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Id;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Key;
    }
    [StructLayout(LayoutKind.Sequential)] struct Message {
        public IntPtr Window; public uint Id; public UIntPtr WParam; public IntPtr LParam;
        public uint Time; public Point Position; public uint Private;
    }
    delegate bool EnumWindow(IntPtr window, IntPtr parameter);
    delegate bool EnumMonitor(IntPtr monitor, IntPtr dc, ref Rect rect, IntPtr parameter);
    delegate void WinEvent(IntPtr hook, uint type, IntPtr window, int obj, int child, uint thread, uint time);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindow callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, EnumMonitor callback, IntPtr parameter);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplayDevices(string device, uint index, ref DisplayDevice output, uint flags);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window, ref Point point);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint length);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, uint attribute, out Rect value, int size);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int DwmGetWindowCloaked(IntPtr window, uint attribute, out int value, int size);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("shcore.dll")] static extern int SetProcessDpiAwareness(int awareness);
    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEvent callback, uint pid, uint thread, uint flags);
    [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] static extern int GetMessage(out Message message, IntPtr window, uint min, uint max);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref Message message);

    static IntPtr target;
    static uint targetPid;
    static bool clientArea;
    static string monitorId;
    static string previous;
    static WinEvent callback;

    static string Decode(string text) { return text.Replace("#3A", ":").Replace("#22", "#"); }
    static string ReadText(IntPtr window, bool name) {
        StringBuilder value = new StringBuilder(4096);
        if (name) GetWindowText(window, value, value.Capacity); else GetClassName(window, value, value.Capacity);
        return value.ToString();
    }
    static string ReadExe(uint pid) {
        IntPtr process = OpenProcess(0x1000, false, pid);
        if (process == IntPtr.Zero) return "";
        try {
            StringBuilder name = new StringBuilder(32768); uint size = (uint)name.Capacity;
            return QueryFullProcessImageName(process, 0, name, ref size) ? Path.GetFileName(name.ToString()) : "";
        } finally { CloseHandle(process); }
    }
    static bool ResolveWindow(string id) {
        string[] parts = id.Split(':');
        if (parts.Length != 3) return false;
        string title = Decode(parts[0]), name = Decode(parts[1]), exe = Decode(parts[2]);
        List<IntPtr> matches = new List<IntPtr>();
        EnumWindows(delegate(IntPtr window, IntPtr unused) {
            uint pid; GetWindowThreadProcessId(window, out pid);
            // OBS title priority may fall back to another same-titled window. An
            // overlay must be stricter: ambiguous or inaccessible identity hides.
            if (IsWindowVisible(window) && String.Equals(ReadText(window, true), title, StringComparison.OrdinalIgnoreCase)
                && String.Equals(ReadText(window, false), name, StringComparison.OrdinalIgnoreCase)
                && String.Equals(ReadExe(pid), exe, StringComparison.OrdinalIgnoreCase)) matches.Add(window);
            return true;
        }, IntPtr.Zero);
        if (matches.Count != 1) return false;
        target = matches[0]; GetWindowThreadProcessId(target, out targetPid); return true;
    }
    static bool MonitorRect(out Rect result) {
        Rect found = new Rect(); int matches = 0;
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr handle, IntPtr dc, ref Rect rect, IntPtr unused) {
            MonitorInfo info = new MonitorInfo(); info.Size = Marshal.SizeOf(typeof(MonitorInfo));
            if (!GetMonitorInfo(handle, ref info)) return true;
            DisplayDevice device = new DisplayDevice(); device.Size = Marshal.SizeOf(typeof(DisplayDevice));
            bool hasId = EnumDisplayDevices(info.Device, 0, ref device, 1);
            if (String.Equals(monitorId, info.Device, StringComparison.OrdinalIgnoreCase)
                || (hasId && String.Equals(monitorId, device.Id, StringComparison.OrdinalIgnoreCase))) { found = info.Monitor; matches++; }
            return true;
        }, IntPtr.Zero);
        result = found; return matches == 1;
    }
    static void Emit() {
        Rect rect = new Rect(); bool visible;
        if (monitorId != null) visible = MonitorRect(out rect);
        else {
            uint pid; GetWindowThreadProcessId(target, out pid);
            int cloaked = 0; DwmGetWindowCloaked(target, 14, out cloaked, sizeof(int));
            IntPtr foreground = GetForegroundWindow();
            visible = IsWindow(target) && pid == targetPid && IsWindowVisible(target) && !IsIconic(target) && cloaked == 0
                && (foreground == target || GetAncestor(foreground, 3) == GetAncestor(target, 3));
            if (visible && clientArea) {
                Point origin = new Point();
                visible = GetClientRect(target, out rect) && ClientToScreen(target, ref origin);
                rect.Right += origin.X; rect.Bottom += origin.Y; rect.Left += origin.X; rect.Top += origin.Y;
            } else if (visible) {
                // WGC captures the visible frame, excluding invisible resize borders.
                if (DwmGetWindowAttribute(target, 9, out rect, Marshal.SizeOf(typeof(Rect))) != 0) visible = GetWindowRect(target, out rect);
            }
        }
        visible = visible && rect.Right > rect.Left && rect.Bottom > rect.Top;
        string message = visible
            ? String.Format(System.Globalization.CultureInfo.InvariantCulture, "{{\"visible\":true,\"x\":{0},\"y\":{1},\"width\":{2},\"height\":{3},\"hwnd\":\"{4}\",\"pid\":{5}}", rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top, target.ToInt64(), targetPid)
            : "{\"visible\":false}";
        if (message == previous) return;
        previous = message; Console.WriteLine(message); Console.Out.Flush();
    }
    [STAThread] static int Main(string[] args) {
        try {
            try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDpiAwareness(2); }
            catch (EntryPointNotFoundException) { SetProcessDpiAwareness(2); }
            if (args.Length < 3) return 1;
            string id = Encoding.UTF8.GetString(Convert.FromBase64String(args[1]));
            clientArea = args[2] == "client";
            if (args[0] == "monitor") monitorId = id;
            else if (args[0] == "obs-window") { if (!ResolveWindow(id)) { Console.WriteLine("{\"visible\":false}"); return 2; } }
            else if (args[0] == "hwnd") {
                long value; if (!Int64.TryParse(id, out value) || value <= 0) return 1;
                target = new IntPtr(value); GetWindowThreadProcessId(target, out targetPid);
                if (args.Length > 3 && args[3] != "0" && args[3] != targetPid.ToString()) return 2;
            } else return 1;
            // Electron owns monitor topology notifications. A monitor lookup is
            // one-shot and the process exits immediately, with no global hooks.
            if (monitorId != null) { Emit(); return 0; }
            // A forced Roomcast exit must not leave this message pump orphaned.
            Process parent = args.Length > 4 ? Process.GetProcessById(Int32.Parse(args[4])) : null;
            if (parent != null) {
                parent.EnableRaisingEvents = true;
                parent.Exited += delegate { Environment.Exit(0); };
                if (parent.HasExited) return 0;
            }
            // Hook callbacks and all geometry reads run on this DPI-aware thread.
            callback = delegate(IntPtr hook, uint type, IntPtr window, int obj, int child, uint thread, uint time) {
                if (type == 3 || window == target) Emit();
            };
            List<IntPtr> hooks = new List<IntPtr>();
            hooks.Add(SetWinEventHook(3, 3, IntPtr.Zero, callback, 0, 0, 0)); // foreground
            hooks.Add(SetWinEventHook(0x8000, 0x800C, IntPtr.Zero, callback, targetPid, 0, 0));
            hooks.Add(SetWinEventHook(0x0016, 0x0017, IntPtr.Zero, callback, targetPid, 0, 0)); // minimize
            Emit();
            Message message;
            while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) { TranslateMessage(ref message); DispatchMessage(ref message); }
            foreach (IntPtr hook in hooks) if (hook != IntPtr.Zero) UnhookWinEvent(hook);
            GC.KeepAlive(parent);
            return 0;
        } catch { return 3; }
    }
}
