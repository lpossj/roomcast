using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

// Independent Windows GUI transaction worker. Arguments and JSON are data;
// no command interpreter or script engine participates in an update.
internal sealed class UpdateLauncher {
    public sealed class Entry { public string name, sha256; }
    public sealed class Plan {
        public string kind, targetPath, launchPath, assetPath, payloadDir, sha256;
        public string workDir, logPath, receiptPath, token, lockPath, failureMarkerPath, version;
        public int pid, parentPid;
        public Entry[] files;
    }
    public sealed class Receipt { public string version, token; public int pid; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo {
        public int size; public string reserved, desktop, title;
        public int x, y, width, height, charsX, charsY, fill, flags;
        public short show, reservedSize; public IntPtr reservedPointer, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits {
        public long processTime, jobTime; public uint flags;
        public UIntPtr minWorkingSet, maxWorkingSet; public uint activeProcesses;
        public UIntPtr affinity; public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters { public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes; }
    [StructLayout(LayoutKind.Sequential)]
    private struct JobLimits {
        public BasicLimits basic; public IoCounters io;
        public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory,
        ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JobLimits limits, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] private static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll")] private static extern bool TerminateProcess(IntPtr process, uint code);

    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 };
    private Plan plan;
    private string stage, backup;
    private bool replaced, directoryMoved, rollbackFailed;
    private Process next;
    private IntPtr ownedJob;

    private static Exception NativeError(string operation) {
        return new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), operation);
    }
    private static string Full(string value) {
        if (String.IsNullOrEmpty(value) || !Path.IsPathRooted(value)) throw new IOException("An absolute path is required");
        return Path.GetFullPath(value);
    }
    private static bool Same(string a, string b) { return String.Equals(Full(a), Full(b), StringComparison.OrdinalIgnoreCase); }
    private static void NoLinks(string value) {
        for (string file = Full(value); !String.IsNullOrEmpty(file); file = Path.GetDirectoryName(file)) {
            if ((File.Exists(file) || Directory.Exists(file)) && (File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("Refusing linked install entry: " + file);
            if (Same(file, Path.GetPathRoot(file))) break;
        }
    }
    private void Validate(string file) {
        if (plan == null || !Same(plan.workDir, Path.GetDirectoryName(file)) || Path.GetFileName(file) != "update-plan.json")
            throw new IOException("Invalid update plan location");
        if (plan.kind != "portable-exe" && plan.kind != "directory") throw new IOException("Unsupported install kind");
        if (plan.pid <= 0 || plan.parentPid < 0 || !Regex.IsMatch(plan.version ?? "", "^[A-Za-z0-9._+-]+$") ||
            !Regex.IsMatch(plan.token ?? "", "^[a-f0-9]{64}$") || !Regex.IsMatch(plan.sha256 ?? "", "^[a-fA-F0-9]{64}$"))
            throw new IOException("Invalid transaction identity");
        if (!Same(plan.logPath, Path.Combine(plan.workDir, "apply.log")) || !Same(plan.receiptPath, Path.Combine(plan.workDir, "receipt.json")) ||
            !Same(plan.lockPath, plan.targetPath + ".update.lock") || Same(plan.targetPath, Path.GetPathRoot(Full(plan.targetPath))))
            throw new IOException("Invalid transaction paths");
        if (Same(plan.assetPath, plan.targetPath) || Same(plan.workDir, plan.targetPath)) throw new IOException("Overlapping transaction paths");
        if (plan.kind == "portable-exe") {
            if (!File.Exists(plan.targetPath) || !Same(plan.launchPath, plan.targetPath)) throw new IOException("Invalid portable target");
        } else {
            if (!Directory.Exists(plan.targetPath) || !Same(plan.launchPath, Path.Combine(plan.targetPath, "Roomcast.exe")) ||
                !Same(plan.payloadDir, Path.Combine(plan.workDir, "payload")) || plan.files == null || plan.files.Length < 2)
                throw new IOException("Invalid directory target");
            bool exe = false, asar = false;
            foreach (Entry entry in plan.files) {
                exe |= Same(PayloadPath(plan.payloadDir, entry.name), Path.Combine(plan.payloadDir, "Roomcast.exe"));
                asar |= Same(PayloadPath(plan.payloadDir, entry.name), Path.Combine(plan.payloadDir, "resources/app.asar"));
            }
            if (!exe || !asar) throw new IOException("Payload is missing required files");
        }
        NoLinks(plan.targetPath); NoLinks(plan.workDir); NoLinks(plan.assetPath);
    }
    private static string PayloadPath(string root, string name) {
        if (String.IsNullOrEmpty(name) || Path.IsPathRooted(name) || name.Contains(":")) throw new IOException("Invalid payload entry");
        string target = Path.GetFullPath(Path.Combine(root, name));
        if (!target.StartsWith(Full(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new IOException("Payload entry escapes its directory");
        return target;
    }
    private void Log(string message) { File.AppendAllText(plan.logPath, "[" + DateTimeOffset.Now.ToString("o") + "] " + message + Environment.NewLine, Utf8); }
    private static string Hash(string file) {
        using (var stream = File.OpenRead(file)) using (var sha = SHA256.Create())
            return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
    }
    private static void WaitForExit(int pid, int seconds) {
        Process previous;
        try { previous = Process.GetProcessById(pid); } catch (ArgumentException) { return; }
        using (previous) if (!previous.WaitForExit(seconds * 1000)) throw new IOException("Timed out waiting for PID " + pid);
    }
    private static void CopyTree(string source, string destination) {
        NoLinks(source); Directory.CreateDirectory(destination);
        foreach (string entry in Directory.EnumerateFileSystemEntries(source)) {
            var attributes = File.GetAttributes(entry);
            if ((attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("Refusing linked install entry: " + entry);
            string target = Path.Combine(destination, Path.GetFileName(entry));
            if ((attributes & FileAttributes.Directory) != 0) CopyTree(entry, target);
            else File.Copy(entry, target, true);
        }
    }
    private void VerifyPayload(string root) {
        foreach (Entry entry in plan.files) {
            string file = PayloadPath(root, entry.name); NoLinks(file);
            if (!Regex.IsMatch(entry.sha256 ?? "", "^[a-f0-9]{64}$") || Hash(file) != entry.sha256)
                throw new IOException("Payload checksum mismatch: " + entry.name);
        }
    }
    private static void Retry(Action action, Action<IOException, int> report) {
        for (int attempt = 1; ; attempt++) {
            try { action(); return; } catch (IOException error) {
                report(error, attempt); if (attempt == 30) throw; Thread.Sleep(1000);
            }
        }
    }
    private void SetJobFlags(uint flags) {
        var limits = new JobLimits(); limits.basic.flags = flags;
        if (!SetInformationJobObject(ownedJob, 9, ref limits, (uint)Marshal.SizeOf(typeof(JobLimits)))) throw NativeError("Cannot configure update-owned job");
    }
    private Process StartNewApp() {
        // Assign a suspended process to the job before running: rollback owns
        // exactly this tree, including a portable wrapper's inner Electron.
        ownedJob = CreateJobObject(IntPtr.Zero, null);
        if (ownedJob == IntPtr.Zero) throw NativeError("Cannot create update-owned job");
        SetJobFlags(0x2000); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        var environment = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (System.Collections.DictionaryEntry entry in Environment.GetEnvironmentVariables()) environment[(string)entry.Key] = (string)entry.Value;
        environment["ROOMCAST_UPDATE_RECEIPT"] = plan.receiptPath;
        environment["ROOMCAST_UPDATE_TOKEN"] = plan.token;
        var block = new StringBuilder(); foreach (var entry in environment) block.Append(entry.Key).Append('=').Append(entry.Value).Append('\0'); block.Append('\0');
        IntPtr memory = Marshal.StringToHGlobalUni(block.ToString());
        var startup = new StartupInfo(); startup.size = Marshal.SizeOf(typeof(StartupInfo));
        ProcessInfo child;
        try {
            if (!CreateProcess(plan.launchPath, new StringBuilder("\"" + plan.launchPath + "\""), IntPtr.Zero, IntPtr.Zero, false,
                0x00000004 | 0x00000400 | 0x08000000, memory, Path.GetDirectoryName(plan.launchPath), ref startup, out child)) throw NativeError("Cannot start new application");
        } finally { Marshal.FreeHGlobal(memory); }
        try {
            if (!AssignProcessToJobObject(ownedJob, child.process)) { TerminateProcess(child.process, 1); throw NativeError("Cannot own new application tree"); }
            if (ResumeThread(child.thread) == UInt32.MaxValue) { TerminateJobObject(ownedJob, 1); throw NativeError("Cannot resume new application"); }
            return Process.GetProcessById((int)child.pid);
        } finally { CloseHandle(child.thread); CloseHandle(child.process); }
    }
    private Process RestartPrevious() {
        var info = new ProcessStartInfo(plan.launchPath) { WorkingDirectory = Path.GetDirectoryName(plan.launchPath), UseShellExecute = false, CreateNoWindow = true };
        info.EnvironmentVariables.Remove("ROOMCAST_UPDATE_RECEIPT"); info.EnvironmentVariables.Remove("ROOMCAST_UPDATE_TOKEN");
        return Process.Start(info);
    }
    private int Run() {
        FileStream updateLock = null;
        try {
            updateLock = new FileStream(plan.lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            Log("update start kind=" + plan.kind + " pid=" + plan.pid + " parentPid=" + plan.parentPid + " version=" + plan.version);
            Log("target=" + plan.targetPath + " source=" + plan.assetPath);
            WaitForExit(plan.pid, 180);
            if (plan.kind == "portable-exe" && plan.parentPid > 0) {
                try {
                    using (var parent = Process.GetProcessById(plan.parentPid)) {
                        if (Same(parent.MainModule.FileName, plan.targetPath)) {
                            Log("waiting for portable launcher PID " + plan.parentPid);
                            if (!parent.WaitForExit(120000)) throw new IOException("Portable launcher did not exit");
                        }
                    }
                } catch (ArgumentException) { Log("portable launcher already exited"); }
            }
            string suffix = Guid.NewGuid().ToString("N");
            stage = plan.targetPath + ".update-" + suffix + ".tmp"; backup = plan.targetPath + ".previous-" + suffix;
            if (Hash(plan.assetPath) != plan.sha256) throw new IOException("Downloaded file changed after checksum verification");
            if (plan.kind == "portable-exe") {
                File.Copy(plan.assetPath, stage, false);
                if (Hash(stage) != plan.sha256) throw new IOException("Staged file checksum mismatch");
                Retry(() => File.Replace(stage, plan.targetPath, backup), (error, attempt) => Log("replace attempt=" + attempt + " error=" + error.Message));
                replaced = true;
                if (Hash(plan.targetPath) != plan.sha256) throw new IOException("Installed file checksum mismatch");
            } else {
                VerifyPayload(plan.payloadDir); CopyTree(plan.targetPath, stage); CopyTree(plan.payloadDir, stage); VerifyPayload(stage);
                Retry(() => Directory.Move(plan.targetPath, backup), (error, attempt) => Log("backup attempt=" + attempt + " error=" + error.Message));
                directoryMoved = true;
                Retry(() => Directory.Move(stage, plan.targetPath), (error, attempt) => Log("deploy attempt=" + attempt + " error=" + error.Message));
                replaced = true;
            }
            Log("files replaced; backup=" + backup);
            next = StartNewApp(); Log("restart started pid=" + next.Id + "; waiting for version receipt");
            DateTime deadline = DateTime.UtcNow.AddSeconds(90); bool confirmed = false;
            while (DateTime.UtcNow < deadline) {
                if (File.Exists(plan.receiptPath)) {
                    Receipt receipt = Json.Deserialize<Receipt>(File.ReadAllText(plan.receiptPath, Utf8));
                    if (receipt == null || receipt.token != plan.token || receipt.version != plan.version || receipt.pid <= 0)
                        throw new IOException("Startup receipt does not match the requested version");
                    confirmed = true; break;
                }
                if (next.HasExited) throw new IOException("New application exited before confirming startup");
                Thread.Sleep(200);
            }
            if (!confirmed) throw new IOException("Timed out waiting for new application startup confirmation");
            // Let the committed app survive this worker AND hand off later
            // updates out of the inherited job. Clearing all flags breaks that.
            SetJobFlags(0x800); // JOB_OBJECT_LIMIT_BREAKAWAY_OK
            Log("COMMITTED version=" + plan.version);
            Cleanup(() => { if (!String.IsNullOrEmpty(plan.failureMarkerPath)) File.Delete(plan.failureMarkerPath); });
            Cleanup(() => File.Delete(plan.assetPath));
            Cleanup(() => { if (!String.IsNullOrEmpty(plan.payloadDir)) Directory.Delete(plan.payloadDir, true); });
            return 0;
        } catch (Exception failure) {
            Log("FAILED hresult=" + failure.HResult + " error=" + failure.Message);
            bool canRestart = updateLock != null;
            if (replaced || directoryMoved) {
                try {
                    if (ownedJob != IntPtr.Zero) {
                        if (!TerminateJobObject(ownedJob, 1)) throw NativeError("Cannot stop update-owned application tree");
                        if (next != null) next.WaitForExit(10000);
                    }
                    if (plan.kind == "portable-exe") File.Replace(backup, plan.targetPath, null);
                    else {
                        if (Directory.Exists(plan.targetPath)) Directory.Move(plan.targetPath, stage);
                        Directory.Move(backup, plan.targetPath);
                    }
                    Log("rolled back to previous image");
                } catch (Exception error) { canRestart = false; rollbackFailed = true; Log("ROLLBACK FAILED; retained backup=" + backup + " error=" + error.Message); }
            }
            if (updateLock != null && !String.IsNullOrEmpty(plan.failureMarkerPath))
                Cleanup(() => File.WriteAllText(plan.failureMarkerPath, plan.version + "\r\n" + plan.workDir + "\r\n" + failure.Message, Utf8));
            if (canRestart) {
                try { using (var previous = RestartPrevious()) Log("previous image restarted pid=" + previous.Id); }
                catch (Exception error) { Log("restart failed: " + error.Message); }
            }
            return 1;
        } finally {
            if (ownedJob != IntPtr.Zero) CloseHandle(ownedJob);
            if (next != null) next.Dispose();
            if (updateLock != null) updateLock.Dispose();
            // Keep old backups and any failed rollback's stage for recovery.
            if (!rollbackFailed) {
                Cleanup(() => { if (stage != null && File.Exists(stage)) File.Delete(stage); });
                Cleanup(() => { if (stage != null && Directory.Exists(stage)) Directory.Delete(stage, true); });
            }
        }
    }
    private void Cleanup(Action action) { try { action(); } catch (Exception error) { try { Log("cleanup deferred: " + error.Message); } catch { } } }
    [STAThread]
    private static int Main(string[] args) {
        if (args.Length != 2 || (args[0] != "--start" && args[0] != "--apply")) return 2;
        try {
            string file = Full(args[1]);
            if (Path.GetFileName(file) != "update-plan.json" || !File.Exists(file)) return 2;
            if (args[0] == "--start") {
                string host = System.Reflection.Assembly.GetExecutingAssembly().Location;
                var startup = new StartupInfo(); startup.size = Marshal.SizeOf(typeof(StartupInfo));
                ProcessInfo child;
                // Self-handoff outside inherited process jobs, no pipe handles.
                if (!CreateProcess(host, new StringBuilder("\"" + host + "\" --apply \"" + file + "\""), IntPtr.Zero, IntPtr.Zero, false,
                    0x01000000 | 0x08000000, IntPtr.Zero, Path.GetDirectoryName(file), ref startup, out child)) return Marshal.GetLastWin32Error();
                CloseHandle(child.thread); CloseHandle(child.process); return 0;
            }
            if (new FileInfo(file).Length > 16 * 1024 * 1024) return 2;
            var worker = new UpdateLauncher { plan = Json.Deserialize<Plan>(File.ReadAllText(file, Utf8)) };
            worker.Validate(file); return worker.Run();
        } catch (Exception error) {
            try { File.AppendAllText(Path.Combine(Path.GetDirectoryName(Full(args[1])), "apply.log"), "[" + DateTimeOffset.Now.ToString("o") + "] FAILED worker validation: " + error.Message + Environment.NewLine, Utf8); } catch { }
            return 2;
        }
    }
}
