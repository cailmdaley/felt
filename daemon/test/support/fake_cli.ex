defmodule Shuttle.Test.FakeCli do
  @moduledoc """
  Fake executables (`felt`, `shuttle`, `tmux`, …) for one test.

  `install!/1` prepends a directory holding `scripts` to the test's *scoped*
  `PATH` (`Shuttle.Test.Env.prepend_path/1`), so `Shuttle.Runner.Default`
  resolves the fake for this test's processes and the real binary for every
  other test. `script!/2` returns one fake's path, for code that execs by path.

  Each distinct script set is written once per test VM, content-addressed, and
  exec'd once when written: macOS assesses a freshly written executable on its
  first exec (about a second, much longer when many tests do it at once), so
  a fake is written and paid for once, not per test. Scripts are therefore
  generic — a test varies their behaviour through scoped env vars and files
  under its own tmp dir (`"$FELT_ARGS_FILE"`), never through paths
  interpolated into the body.

  A `sh`/`bash` script gets a guard line after its shebang that exits at once
  when `SHUTTLE_FAKE_CLI_WARM` is set, so the warming exec has no effects.

      FakeCli.install!(%{"shuttle" => "#!/bin/sh\\nprintf '%s\\\\n' \\"$@\\" >> \\"$LOG\\"\\n"})
      Shuttle.Test.Env.put_env("LOG", Path.join(tmp_dir, "argv"))
  """

  @warm_var "SHUTTLE_FAKE_CLI_WARM"

  @doc "Install `scripts` (name → script body) on this test's PATH; returns the bin dir."
  def install!(scripts) when is_map(scripts) and map_size(scripts) > 0 do
    dir = cached_dir!(scripts)
    Shuttle.Test.Env.prepend_path(dir)
    dir
  end

  @doc "The path of a fake executable `name` with `body`, written and warmed once per VM."
  def script!(name, body) when is_binary(name) and is_binary(body),
    do: Path.join(cached_dir!(%{name => body}), name)

  @doc "The real executable `name` on the test's PATH before any fake shadows it."
  def real!(name), do: Shuttle.Env.find_executable(name) || raise("#{name} not on PATH")

  defp cached_dir!(scripts) do
    scripts = Enum.sort(scripts)

    hash =
      :crypto.hash(:sha256, :erlang.term_to_binary(scripts)) |> Base.url_encode64(padding: false)

    dir = Path.join([System.tmp_dir!(), "shuttle-fake-cli", binary_part(hash, 0, 16)])

    # One writer per script set; later callers find the finished dir.
    :global.trans({{__MODULE__, dir}, self()}, fn ->
      unless File.dir?(dir), do: write_warmed!(dir, scripts)
    end)

    dir
  end

  defp write_warmed!(dir, scripts) do
    staging = dir <> ".tmp"
    File.rm_rf!(staging)
    File.mkdir_p!(staging)

    for {name, body} <- scripts do
      path = Path.join(staging, name)
      File.write!(path, guarded(body))
      File.chmod!(path, 0o755)
      warm(path)
    end

    File.rename!(staging, dir)
  end

  defp guarded("#!" <> _ = body) do
    case String.split(body, "\n", parts: 2) do
      [shebang, rest] ->
        if shebang =~ ~r/\b(sh|bash)\b/,
          do: "#{shebang}\n[ -n \"$#{@warm_var}\" ] && exit 0\n#{rest}",
          else: body

      _ ->
        body
    end
  end

  defp guarded(body), do: body

  defp warm(path) do
    System.cmd(path, [], env: [{@warm_var, "1"}], stderr_to_stdout: true)
  rescue
    _ -> :ok
  end
end
