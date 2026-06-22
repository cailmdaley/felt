defmodule ShuttleWeb.VersionController do
  @moduledoc """
  Agent-API endpoint: GET /api/v1/version

  Returns the daemon binary's compile-time build stamp so consumers can detect
  stale escripts after a schema-touching source update.
  """

  use Phoenix.Controller, formats: [:json]

  def show(conn, _params) do
    git_sha = build_info(:git_sha)

    json(conn, %{
      git_sha: git_sha,
      git_short_sha: short_sha(git_sha),
      built_at: build_info(:built_at),
      mix_vsn: Shuttle.version()
    })
  end

  defp build_info(function) do
    if Code.ensure_loaded?(Shuttle.BuildInfo) and function_exported?(Shuttle.BuildInfo, function, 0) do
      apply(Shuttle.BuildInfo, function, [])
    else
      "unknown"
    end
  end

  defp short_sha("unknown"), do: "unknown"
  defp short_sha(sha) when is_binary(sha), do: String.slice(sha, 0, 7)
end
