using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

public static class CodexGenerationFakeProcess
{
    private static string JsonQuote(string value)
    {
        if (value == null)
        {
            return "null";
        }

        var builder = new StringBuilder("\"");
        foreach (char character in value)
        {
            switch (character)
            {
                case '\\': builder.Append("\\\\"); break;
                case '"': builder.Append("\\\""); break;
                case '\b': builder.Append("\\b"); break;
                case '\f': builder.Append("\\f"); break;
                case '\n': builder.Append("\\n"); break;
                case '\r': builder.Append("\\r"); break;
                case '\t': builder.Append("\\t"); break;
                default:
                    if (character < 0x20)
                    {
                        builder.Append("\\u");
                        builder.Append(((int)character).ToString("x4"));
                    }
                    else
                    {
                        builder.Append(character);
                    }
                    break;
            }
        }
        builder.Append('"');
        return builder.ToString();
    }

    private static void WriteEngineEvidence(string path, string[] args)
    {
        var argv = new StringBuilder("[");
        for (int index = 0; index < args.Length; index++)
        {
            if (index > 0)
            {
                argv.Append(',');
            }
            argv.Append(JsonQuote(args[index]));
        }
        argv.Append(']');

        string json = "{"
            + "\"pid\":" + Process.GetCurrentProcess().Id + ","
            + "\"argv\":" + argv + ","
            + "\"codexCliPath\":" + JsonQuote(Environment.GetEnvironmentVariable("CODEX_CLI_PATH")) + ","
            + "\"codexHome\":" + JsonQuote(Environment.GetEnvironmentVariable("CODEX_HOME"))
            + "}";
        File.WriteAllText(path, json, new UTF8Encoding(false));
    }

    private static string QuoteArgument(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
        {
            return value;
        }

        var builder = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char character in value)
        {
            if (character == '\\')
            {
                backslashes++;
                continue;
            }
            if (character == '"')
            {
                builder.Append('\\', backslashes * 2 + 1);
                builder.Append('"');
                backslashes = 0;
                continue;
            }
            builder.Append('\\', backslashes);
            backslashes = 0;
            builder.Append(character);
        }
        builder.Append('\\', backslashes * 2);
        builder.Append('"');
        return builder.ToString();
    }

    private static void RunDesktop(string configPath)
    {
        string[] config = File.ReadAllLines(configPath);
        if (config.Length < 5)
        {
            Environment.Exit(64);
        }

        string readyPath = config[0];
        string engineEvidencePath = config[1];
        string engineOverride = config[2];
        int engineHoldMilliseconds = int.Parse(config[3]);
        int desktopHoldMilliseconds = int.Parse(config[4]);
        string enginePath = engineOverride == "-"
            ? Environment.GetEnvironmentVariable("CODEX_CLI_PATH")
            : engineOverride;
        if (String.IsNullOrWhiteSpace(enginePath))
        {
            Environment.Exit(65);
        }

        var startInfo = new ProcessStartInfo(enginePath)
        {
            UseShellExecute = false,
            Arguments = QuoteArgument("engine")
                + " " + QuoteArgument(engineEvidencePath)
                + " " + engineHoldMilliseconds.ToString()
        };
        Process child = Process.Start(startInfo);
        string readyJson = "{"
            + "\"pid\":" + Process.GetCurrentProcess().Id + ","
            + "\"childPid\":" + (child == null ? "null" : child.Id.ToString()) + ","
            + "\"codexCliPath\":" + JsonQuote(Environment.GetEnvironmentVariable("CODEX_CLI_PATH"))
            + "}";
        File.WriteAllText(readyPath, readyJson, new UTF8Encoding(false));
        Thread.Sleep(desktopHoldMilliseconds);
    }

    public static int Main(string[] args)
    {
        if (args.Length < 1)
        {
            return 64;
        }

        if (args[0] == "engine")
        {
            if (args.Length < 2)
            {
                return 64;
            }
            WriteEngineEvidence(args[1], args);
            int holdMilliseconds = args.Length >= 3 ? int.Parse(args[2]) : 0;
            Thread.Sleep(holdMilliseconds);
            return 0;
        }
        if (args[0] == "desktop" && args.Length >= 2)
        {
            RunDesktop(args[1]);
            return 0;
        }
        if (args[0] != "engine")
        {
            RunDesktop(args[0]);
            return 0;
        }
        return 64;
    }
}
