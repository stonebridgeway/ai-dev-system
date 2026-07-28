using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

internal static class ClaudeMcpProxy
{
    private static readonly object OutputLock = new object();
    private static readonly Regex IdPattern = new Regex("\\\"id\\\"\\s*:\\s*(\\\"(?:\\\\.|[^\\\"])*\\\"|-?\\d+)", RegexOptions.Compiled);
    private static readonly Regex MethodPattern = new Regex("\\\"method\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"", RegexOptions.Compiled);
    private static readonly Regex ProtocolPattern = new Regex("\\\"protocolVersion\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"", RegexOptions.Compiled);

    private static string backendInitializeId;

    private static int Main()
    {
        try
        {
            using (var backend = StartDocker())
            {
                var stdout = PumpBackendOutput(backend);
                var stderr = PumpBackendError(backend);
                using (var input = Console.In)
                {
                    string line;
                    while ((line = input.ReadLine()) != null)
                    {
                        var method = MethodPattern.Match(line);
                        if (method.Success && method.Groups[1].Value == "initialize")
                        {
                            var id = Require(IdPattern, line, "MCP initialize request id");
                            var protocolVersion = Require(ProtocolPattern, line, "MCP protocol version");
                            Volatile.Write(ref backendInitializeId, id);
                            backend.StandardInput.WriteLine(line);
                            backend.StandardInput.Flush();
                            WriteImmediateInitializeResponse(id, protocolVersion);
                        }
                        else
                        {
                            backend.StandardInput.WriteLine(line);
                            backend.StandardInput.Flush();
                        }
                    }
                }

                backend.StandardInput.Close();
                Task.WaitAll(new[] { stdout, stderr }, TimeSpan.FromSeconds(2));
                if (!backend.HasExited) backend.Kill();
            }
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("AI Dev Claude MCP proxy failed: " + error.Message);
            return 1;
        }
    }

    private static Process StartDocker()
    {
        var arguments = new List<string>
        {
            "run", "--rm", "-i", "--read-only",
            "--tmpfs", "/tmp:rw,exec,nosuid,size=512m",
            "--shm-size", "1g",
            "--network", Environment.GetEnvironmentVariable("AI_DEV_DOCKER_NETWORK") ?? "none",
            "--security-opt", "no-new-privileges:true",
            "--cap-drop", "ALL",
            "--mount", "type=volume,source=" + (Environment.GetEnvironmentVariable("AI_DEV_DATA_VOLUME") ?? "ai-dev-system-data") + ",target=/data"
        };
        AddBindMount(arguments, "AI_DEV_PROJECT_PATH", "/workspace", false);
        AddBindMount(arguments, "AI_DEV_MODEL_PATH", "/models/bge-m3", true);
        arguments.Add(Environment.GetEnvironmentVariable("AI_DEV_IMAGE") ?? "ai-dev-system:local");

        var startInfo = new ProcessStartInfo
        {
            FileName = "docker.exe",
            Arguments = string.Join(" ", arguments.ConvertAll(Quote)),
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        var process = new Process { StartInfo = startInfo };
        if (!process.Start()) throw new InvalidOperationException("Could not start Docker.");
        return process;
    }

    private static void AddBindMount(List<string> arguments, string environmentName, string target, bool readOnly)
    {
        var value = Environment.GetEnvironmentVariable(environmentName);
        if (string.IsNullOrWhiteSpace(value)) return;
        var fullPath = Path.GetFullPath(value);
        if (fullPath.Contains(",")) throw new InvalidOperationException(environmentName + " cannot contain a comma.");
        if (!Directory.Exists(fullPath)) throw new DirectoryNotFoundException(environmentName + " does not exist: " + fullPath);
        arguments.Add("--mount");
        arguments.Add("type=bind,source=" + fullPath + ",target=" + target + (readOnly ? ",readonly" : ""));
    }

    private static Task PumpBackendOutput(Process backend)
    {
        return Task.Run(async () =>
        {
            string line;
            while ((line = await backend.StandardOutput.ReadLineAsync()) != null)
            {
                var id = IdPattern.Match(line);
                if (id.Success && id.Groups[1].Value == Volatile.Read(ref backendInitializeId)) continue;
                lock (OutputLock)
                {
                    Console.Out.WriteLine(line);
                    Console.Out.Flush();
                }
            }
        });
    }

    private static Task PumpBackendError(Process backend)
    {
        return Task.Run(async () =>
        {
            string line;
            while ((line = await backend.StandardError.ReadLineAsync()) != null)
            {
                Console.Error.WriteLine(line);
            }
        });
    }

    private static string Require(Regex pattern, string line, string label)
    {
        var match = pattern.Match(line);
        if (!match.Success) throw new InvalidOperationException("Missing " + label + ".");
        return match.Groups[1].Value;
    }

    private static void WriteImmediateInitializeResponse(string id, string protocolVersion)
    {
        var response = "{\"jsonrpc\":\"2.0\",\"id\":" + id
            + ",\"result\":{\"protocolVersion\":\"" + protocolVersion
            + "\",\"capabilities\":{\"tools\":{\"listChanged\":false},\"resources\":{\"subscribe\":false,\"listChanged\":false},\"prompts\":{\"listChanged\":false},\"logging\":{}},\"serverInfo\":{\"name\":\"ai-dev-system\",\"version\":\"1.0.0\"}}}";
        lock (OutputLock)
        {
            Console.Out.WriteLine(response);
            Console.Out.Flush();
        }
    }

    private static string Quote(string argument)
    {
        if (argument.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return argument;
        var quoted = new StringBuilder("\"");
        var backslashes = 0;
        foreach (var character in argument)
        {
            if (character == '\\')
            {
                backslashes += 1;
            }
            else if (character == '"')
            {
                quoted.Append('\\', backslashes * 2 + 1);
                quoted.Append(character);
                backslashes = 0;
            }
            else
            {
                quoted.Append('\\', backslashes);
                quoted.Append(character);
                backslashes = 0;
            }
        }
        quoted.Append('\\', backslashes * 2);
        quoted.Append('"');
        return quoted.ToString();
    }
}
