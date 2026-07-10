defmodule ShuttleWeb.VersionController do
  @moduledoc """
  Agent-API endpoint: GET /api/v1/version

  Returns the daemon binary's compile-time build stamp so consumers can detect
  stale escripts after a schema-touching source update, plus (S2) the
  daemon-shelled CLI contract level: what this daemon EXPECTS
  (`Shuttle.Contract.expected_level/0`) versus what it PROBED at boot from the
  CLI (`felt shuttle contract`, cached in the Poller's `contract_check`
  state). Makes a skew human-visible remotely, not just in the boot log/board.
  """

  use Phoenix.Controller, formats: [:json]

  @state_timeout_ms 1_500

  def show(conn, _params) do
    git_sha = build_info(:git_sha)

    json(conn, %{
      git_sha: git_sha,
      git_short_sha: short_sha(git_sha),
      built_at: build_info(:built_at),
      # Runtime boot stamp (Shuttle.start/2), NOT compile-time: the escript
      # loads modules lazily from the file on disk, so git_sha alone can
      # report a fresh build out of a stale, long-booted daemon (BuildInfo
      # first referenced after the escript was replaced). Deploy verifiers
      # must check both: sha matches AND booted_at postdates the deploy.
      booted_at: booted_at(),
      mix_vsn: Shuttle.version(),
      contract: contract_check()
    })
  end

  defp booted_at do
    case Application.get_env(:shuttle, :booted_at) do
      %DateTime{} = dt -> DateTime.to_iso8601(dt)
      _ -> "unknown"
    end
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

  # The Poller probes once at boot and caches the result (`contract_check`
  # state) — reading it here is a cheap GenServer call, not a fresh shell-out.
  # Degrades to "we don't know, ask again" rather than crashing this endpoint
  # if the Poller is unreachable (mirrors `StateController`'s poller-call
  # seam).
  defp contract_check do
    Shuttle.Poller.snapshot(Shuttle.Poller, @state_timeout_ms)
    |> Map.get(:contract, %{})
    |> Map.put(:expected, Shuttle.Contract.expected_level())
  catch
    :exit, _ ->
      %{expected: Shuttle.Contract.expected_level(), observed: nil, ok: nil, reason: "poller_unavailable"}
  end
end
