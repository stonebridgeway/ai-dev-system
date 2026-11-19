// The 2.x launcher Claude on Windows was configured with, kept so that the
// configs naming it work until 4.0. 3.0 writes
// `docker run -i --rm ...` into a client's config itself (bootstrap.ps1, or
// `ai-dev clients install --docker`) and compiles nothing on the user's machine.
//
// It used to answer `initialize` itself while the container started and drop
// the server's own answer, which lost the server's instructions and fixed the
// version at 2.0.0. The image answers in about a second now: the proxy
// passes the bytes through, both ways, and the server answers its handshake.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;

internal static class ClaudeMcpProxy
{
    private static int Main()
    {
        try
        {
            Console.Error.WriteLine("ai-dev: this client config runs ClaudeMcpProxy.exe, the 2.x launcher, which works until 4.0. "
                + "Run bootstrap.ps1 (or `ai-dev clients install --docker`) to write the 3.0 entry: docker run, with the state your agent hooks share.");
            using (var backend = StartDocker())
            {
                var stdout = Pump(backend.StandardOutput.BaseStream, Console.OpenStandardOutput());
                var stderr = Pump(backend.StandardError.BaseStream, Console.OpenStandardError());
                var stdin = Pump(Console.OpenStandardInput(), backend.StandardInput.BaseStream).ContinueWith(_ => backend.StandardInput.Close());
                backend.WaitForExit();
                Task.WaitAll(new[] { stdout, stderr }, TimeSpan.FromSeconds(2));
                return backend.ExitCode;
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("AI Dev Claude MCP proxy failed: " + error.Message);
            return 1;
        }
    }

    // Copy one stream into another as it arrives, flushing each piece: MCP messages are lines a client waits on.
    private static Task Pump(Stream from, Stream to)
    {
        return Task.Run(() =>
        {
            var buffer = new byte[64 * 1024];
            int read;
            while ((read = from.Read(buffer, 0, buffer.Length)) > 0)
            {
                to.Write(buffer, 0, read);
                to.Flush();
            }
        });
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
        AddBindMount(arguments, MountSource("AI_DEV_PROJECT_PATH"), "/workspace", false);
        AddBindMount(arguments, ModelMountSource(), "/models", true);
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

    private static string MountSource(string environmentName)
    {
        var value = Environment.GetEnvironmentVariable(environmentName);
        if (string.IsNullOrWhiteSpace(value)) return null;
        var fullPath = Path.GetFullPath(value);
        if (fullPath.Contains(",")) throw new InvalidOperationException(environmentName + " cannot contain a comma.");
        if (!Directory.Exists(fullPath)) throw new DirectoryNotFoundException(environmentName + " does not exist: " + fullPath);
        return fullPath;
    }

    // As in run-mcp.sh and run-mcp.ps1: the folder holds bge-m3-onnx\, and the
    // image looks for it under /models. This copy mounted it at /models/bge-m3,
    // one level too deep, so Claude on Windows never had dense search.
    // A lone bge-m3\ is the removed Python backend's
    // weights.
    private static readonly string[] ModelFileMarkers = { "pytorch_model.bin", "modules.json", "config.json", "onnx" };

    private static string ModelMountSource()
    {
        var fullPath = MountSource("AI_DEV_MODEL_PATH");
        if (fullPath == null) return null;
        // In 2.0.0 the variable named the model directory itself. A folder
        // that holds model files is that old value, and mounted at /models it
        // would leave both backends looking one level too deep.
        foreach (var marker in ModelFileMarkers)
        {
            var candidate = Path.Combine(fullPath, marker);
            if (File.Exists(candidate) || Directory.Exists(candidate))
            {
                throw new InvalidOperationException("AI_DEV_MODEL_PATH now names the folder above the models, and " + fullPath
                    + " holds model files itself (" + marker + "). Point it at the parent folder that contains bge-m3-onnx\\"
                    + " - for a default install that is %USERPROFILE%\\.ai-dev\\models (docs/INSTALL.md).");
            }
        }
        if (!Directory.Exists(Path.Combine(fullPath, "bge-m3-onnx")))
        {
            Console.Error.WriteLine(Directory.Exists(Path.Combine(fullPath, "bge-m3"))
                ? "AI_DEV_MODEL_PATH=" + fullPath + " holds bge-m3\\, the weights of the Python backend 3.0 removed, and no bge-m3-onnx\\; dense search will report that it is not set up. Put the ONNX model there: npm run model -- install --dir " + Path.Combine(fullPath, "bge-m3-onnx") + " (docs/INSTALL.md)."
                : "AI_DEV_MODEL_PATH=" + fullPath + " holds no bge-m3-onnx\\; dense search will report that it is not set up until a model is put there.");
        }
        return fullPath;
    }

    private static void AddBindMount(List<string> arguments, string source, string target, bool readOnly)
    {
        if (source == null) return;
        arguments.Add("--mount");
        arguments.Add("type=bind,source=" + source + ",target=" + target + (readOnly ? ",readonly" : ""));
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
