# Reads candidate credentials only from the signed-in Xbox PC process.
# Output is consumed by the local server over a private pipe, never a file.
$ErrorActionPreference = 'Stop'
try {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

public static class XboxPcReader {
    [StructLayout(LayoutKind.Sequential)]
    struct MemoryInfo {
        public IntPtr BaseAddress, AllocationBase;
        public uint AllocationProtect;
        public UIntPtr RegionSize;
        public uint State, Protect, Type;
    }
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] static extern UIntPtr VirtualQueryEx(IntPtr process, IntPtr address, out MemoryInfo info, UIntPtr length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, UIntPtr size, out UIntPtr read);
    static readonly Regex Pattern = new Regex(@"XBL3\.0 x=[^\s;\x00]{1,128};[A-Za-z0-9_.=-]{20,16000}", RegexOptions.CultureInvariant);
    public static string[] Read() {
        var found = new Dictionary<string, int>();
        foreach (var process in Process.GetProcessesByName("XboxPcApp")) {
            IntPtr handle = IntPtr.Zero;
            try {
                handle = OpenProcess(0x410, false, process.Id);
                if (handle == IntPtr.Zero) continue;
                long address = 0, max = IntPtr.Size == 8 ? 0x00007fffffffffffL : 0x7fffffffL;
                var infoSize = (UIntPtr)(uint)Marshal.SizeOf(typeof(MemoryInfo));
                while (address < max) {
                    MemoryInfo info;
                    if (VirtualQueryEx(handle, new IntPtr(address), out info, infoSize) == UIntPtr.Zero) break;
                    long start = info.BaseAddress.ToInt64();
                    long size = unchecked((long)info.RegionSize.ToUInt64());
                    if (size <= 0 || start < 0 || start > max - size) break;
                    long end = start + size;
                    bool readable = info.State == 0x1000 && (info.Protect & 0x101) == 0 && (info.Protect & 0xee) != 0;
                    if (readable) {
                        const int block = 1024 * 1024, overlap = 16384;
                        for (long pos = start; pos < end; pos += block) {
                            int count = (int)Math.Min((long)block + overlap, end - pos);
                            byte[] bytes = new byte[count]; UIntPtr read;
                            if (!ReadProcessMemory(handle, new IntPtr(pos), bytes, (UIntPtr)(uint)count, out read)) continue;
                            string text = Encoding.ASCII.GetString(bytes, 0, checked((int)read.ToUInt64()));
                            foreach (Match match in Pattern.Matches(text)) {
                                if (match.Index >= block || match.Index + match.Length == text.Length) continue;
                                int n; found.TryGetValue(match.Value, out n); found[match.Value] = n + 1;
                            }
                        }
                    }
                    if (end <= address) break;
                    address = end;
                }
            } finally { if (handle != IntPtr.Zero) CloseHandle(handle); process.Dispose(); }
        }
        var ranked = new List<KeyValuePair<string,int>>(found);
        ranked.Sort((a,b) => b.Value.CompareTo(a.Value));
        var result = new List<string>();
        foreach (var entry in ranked) { if (entry.Value < 4) continue; result.Add(entry.Key); if (result.Count == 8) break; }
        return result.ToArray();
    }
}
'@
} catch { [Console]::Error.WriteLine('XAU_AUTH_INIT_FAILED'); exit 1 }
try {
    $results = [XboxPcReader]::Read()
    ConvertTo-Json -InputObject @($results) -Compress
} catch { [Console]::Error.WriteLine('XAU_AUTH_SCAN_FAILED'); exit 1 }
