defmodule Mix.Tasks.Shuttle.GenVersion do
  @moduledoc """
  Generate the compile-time Shuttle build-info module used by the daemon.
  """

  use Mix.Task

  @shortdoc "Generate lib/shuttle/build_info.ex"
  @target Path.expand("../../shuttle/build_info.ex", __DIR__)

  @impl true
  def run(_args) do
    git_sha = git(["rev-parse", "HEAD"])
    built_at = DateTime.utc_now() |> DateTime.truncate(:second) |> DateTime.to_iso8601()

    File.mkdir_p!(Path.dirname(@target))

    File.write!(@target, """
    defmodule Shuttle.BuildInfo do
      @moduledoc false

      @git_sha #{inspect(git_sha)}
      @built_at #{inspect(built_at)}

      def git_sha, do: @git_sha
      def built_at, do: @built_at
    end
    """)

    Mix.shell().info("Generated #{@target}")
  end

  defp git(args) do
    case System.cmd("git", args, stderr_to_stdout: true) do
      {output, 0} -> String.trim(output)
      _ -> "unknown"
    end
  rescue
    _ -> "unknown"
  end
end
