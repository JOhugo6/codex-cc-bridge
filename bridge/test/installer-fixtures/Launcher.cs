using System;
using System.Diagnostics;
using System.IO;
using System.Text.RegularExpressions;

// Offline fixture only. No native Claude, auth, network, or user profile access.
public static class Launcher {
    static string Quote(string value) {
        value = Regex.Replace(value, "(\\\\*)\"", "$1$1\\\"");
        value = Regex.Replace(value, "(\\\\*)$", "$1$1");
        return "\"" + value + "\"";
    }
    public static int Main(string[] args) {
        string directory = AppDomain.CurrentDomain.BaseDirectory;
        // Later PATH candidates are real applications but must never be invoked.
        // Check before spawning Node so this also safely traps node.exe itself.
        if (File.Exists(Path.Combine(directory, "discovery-trap"))) {
            File.AppendAllText(Path.Combine(directory, "unexpected-invocations.txt"), Environment.CommandLine + "\n");
            return 93;
        }
        string arguments = Quote(Path.Combine(directory, "external-cli.js")) + " claude";
        foreach (string arg in args) arguments += " " + Quote(arg);
        var start = new ProcessStartInfo(Path.Combine(directory, "node.exe"), arguments);
        start.UseShellExecute = false;
        using (var process = Process.Start(start)) { process.WaitForExit(); return process.ExitCode; }
    }
}
