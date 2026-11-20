defmodule Shuttle.Contract do
  @moduledoc """
  The daemon's expected level of the CLI's daemon-shelled surface — the
  Elixir-side companion to `internal/shuttlecli/contract.go`'s `ShuttleContractLevel`.

  Bump `@expected_level` IN LOCKSTEP with that Go constant whenever a change
  touches the daemon-shelled CLI surface (see `internal/shuttlecli/contract.go`'s
  moduledoc for exactly what counts — a flag added/removed/renamed on
  mark-runtime/reopen/any verb the daemon shells at dispatch/conclude time, or
  a change to what a shelled verb's stdout/exit code means). Without the bump, a
  newer daemon shelling an older CLI fails every write that uses a flag the CLI
  does not know.

  The Poller shells `shuttle contract` at boot and periodically after, and
  compares its bare-integer stdout against `expected_level/0`, catching a stale
  CLI installed alongside a newer daemon (or vice versa) as a hold on fresh
  dispatch instead of one shelled write failing at a time with "unknown flag".
  A check that could not run is not a verdict: the previous one stands and the
  check is retried.
  """

  require Logger

  # Matches internal/shuttlecli/contract.go's ShuttleContractLevel.
  @expected_level 52

  # The daemon-shelled surface each recent level introduced. A skew reason
  # names every surface above the CLI's level, so an operator sees which verb
  # the stale CLI is missing rather than only two integers.
  @level_surfaces %{
    14 => "hook interrupted (Shuttle.InterruptWatcher)",
    15 =>
      "context-mailbox get/receiver/revoke/put (thread receiver authority), " <>
        "close --quiet (lifecycle API)",
    16 => "rest/close --actor (an orchestrator's own acts on its threads)",
    17 => "context-mailbox put --from (a message queued for a fiber's next worker)",
    19 => "process-identity PID (kernel lifetime evidence for hook receivers)",
    20 => "migrate (live conversation assignment and native hook ledger binding)",
    21 => "migrate-documents (locked, conditional assignment patches and recovery)",
    22 => "board append and ask --answered-by (family board)",
    23 =>
      "context-mailbox put --thread-signal and thread-signal-current (fresh lifecycle delivery)",
    26 => "mark-runtime --thread-exit-verb (durable lifecycle signal supersession)",
    27 => "context-mailbox put --retained-at (bounded thread notice retention)",
    29 => "scan-changes (incremental physical-store metadata index)",
    30 => "scan-changes (newline-framed opaque metadata index)",
    31 =>
      "felt show --exact and felt add --namespace; lifecycle --fiber-path (verified UID path hints); " <>
        "resolved lifecycle reads remain exact for UID-less documents",
    32 => "reopen --occurrence (locked conditional standing re-arm with clean service markers)",
    33 =>
      "standing-transition (conditional run disposition) and patch-document (locked source-image CAS)",
    34 => "claude-mail-recover (durable native wake for unoffered automatic Claude mail)",
    35 => "context-mailbox put --from and message --request-json from (the sender as given)",
    36 =>
      "conclude-run (standing runs re-arm on exit); reopen --occurrence and --conclude-run and accept removed",
    37 => "close --review (a thread marked for the human's review)",
    38 => "inbox put/pending/ls (one writer for every inbox entry, with delivery wishes)",
    39 =>
      "inbox consume and context-mailbox put --turn/--derived (live-worker batch consumption)",
    40 =>
      "inbox consume - 0 and --unknown, inbox pending --waking " <>
        "(a session started for a dormant fiber's waking entries)",
    41 =>
      "inbox thread-state, thread-put, routes, route and settle " <>
        "(thread results through the routing inbox)",
    42 =>
      "inbox consume --busy/--message and followup/held/message answers; context-mailbox put --attachments-stdin; " <>
        "inbox record-begin/record-settle (typed human lines and agent fresh requests, recorded and deduplicated)",
    43 => "channels order (the human's order of the Channels rail)",
    44 => "inbox record-begin --source and message --recorded (pulse and voice records)",
    45 => "delayed fiber messages, inbox pending summaries, owner inbox ls and cancel",
    46 => "close --post and --attached (the closing post, written as the outcome)",
    47 =>
      "inbox consume reads a batch's receipt from its manifest and never resends an open batch",
    48 =>
      "message --local sending a Claude session's ask straight to its native socket " <>
        "(this daemon shells no claude-mail-recover)",
    49 => "felt add --uid (a fiber carried to its owner keeps its identity and slug)",
    50 => "channel (a constitution's board channel, set or cleared)",
    51 =>
      "inbox thread-put aliases (a thread result captured under another id is not captured again)",
    52 => "inbox rekey and fiber:<uid> inbox keys (a fiber's inbox names no store)"
  }

  @doc "The daemon's expected `shuttle contract` level."
  @spec expected_level() :: pos_integer()
  def expected_level, do: @expected_level

  @typedoc """
  The daemon's standing contract reading. `observed`, `ok` and `reason` are
  the verdict of the last check that ran; `error` says why the latest attempt
  could not run, and is nil once one does.
  """
  @type reading :: %{
          expected: pos_integer(),
          observed: integer() | nil,
          ok: boolean(),
          reason: String.t() | nil,
          error: String.t() | nil
        }

  # The check runs inside the Poller. A wedged one is retried on the next
  # interval, so it holds the Poller only briefly.
  @check_timeout_ms 5_000

  @doc "The reading before any check has run: no evidence of skew."
  @spec unchecked() :: reading()
  def unchecked,
    do: %{expected: @expected_level, observed: nil, ok: true, reason: nil, error: nil}

  @doc """
  Shell `shuttle contract` through `runner` and classify the answer.

  Only a CLI that ran and printed a level gives a verdict: `{:verdict, map}`,
  with `ok: false` and the missing surfaces named when the level differs.
  Everything else (a spawn failure such as `:eagain` under a pid cap, a
  timeout, a nonzero exit, stdout that is not a level) is
  `{:unavailable, reason}`: the check did not run, which is no evidence about
  the CLI's level.
  """
  @spec check(module()) ::
          {:verdict, %{observed: integer(), ok: boolean(), reason: String.t() | nil}}
          | {:unavailable, String.t()}
  def check(runner) do
    case Shuttle.CLI.run(["contract"], runner: runner, timeout_ms: @check_timeout_ms) do
      {:ok, output} ->
        parse_level(output)

      {:command_error, status, output} ->
        {:unavailable,
         "shuttle contract exited #{inspect(status)}: #{output |> to_string() |> String.trim()}"}

      {:error, reason} ->
        {:unavailable, "shuttle contract could not run: #{reason}"}
    end
  rescue
    e -> {:unavailable, "shuttle contract raised: #{Exception.message(e)}"}
  end

  defp parse_level(output) do
    trimmed = String.trim(output)

    case Integer.parse(trimmed) do
      {level, ""} when level == @expected_level ->
        {:verdict, %{observed: level, ok: true, reason: nil}}

      {level, ""} ->
        {:verdict,
         %{
           observed: level,
           ok: false,
           reason:
             "expected contract level #{@expected_level}, CLI reports #{level}" <>
               missing_surfaces(level)
         }}

      _ ->
        {:unavailable, "shuttle contract printed no level: #{inspect(trimmed)}"}
    end
  end

  defp missing_surfaces(level) when level < @expected_level do
    surfaces =
      (level + 1)..@expected_level//1
      |> Enum.map(&@level_surfaces[&1])
      |> Enum.reject(&is_nil/1)

    case surfaces do
      [] -> ""
      surfaces -> "; the CLI lacks " <> Enum.join(surfaces, "; ")
    end
  end

  defp missing_surfaces(_level), do: ""

  @doc """
  Check again and fold the answer into `previous`. A verdict replaces the
  previous one; a check that could not run keeps it and records why in
  `error`. Logs only when the reading changes, so a periodic recheck stays
  quiet while nothing moves.
  """
  @spec refresh(reading(), module()) :: reading()
  def refresh(previous, runner) do
    next =
      case check(runner) do
        {:verdict, verdict} -> previous |> Map.merge(verdict) |> Map.put(:error, nil)
        {:unavailable, error} -> %{previous | error: error}
      end

    log_change(previous, next)
    next
  end

  defp log_change(same, same), do: :ok

  defp log_change(_previous, %{error: error, ok: ok}) when is_binary(error) do
    Logger.warning(
      "shuttle contract check could not run (#{error}); keeping the last verdict " <>
        "(#{if ok, do: "no skew", else: "skew"}) and retrying"
    )
  end

  defp log_change(previous, %{ok: false, reason: reason})
       when previous.ok or previous.reason != reason do
    Logger.error(
      "CLI/daemon contract skew: #{reason}. Fresh dispatches are held until a check " <>
        "matches (install the matching CLI; see internal/shuttlecli/contract.go)."
    )
  end

  defp log_change(%{ok: false}, %{ok: true, observed: level}),
    do: Logger.warning("CLI/daemon contract skew cleared: CLI reports level #{level}")

  defp log_change(_previous, %{ok: true, observed: level}),
    do: Logger.info("shuttle contract level #{level} matches expected #{@expected_level}")

  defp log_change(_previous, %{reason: reason}),
    do: Logger.error("shuttle contract check runs again; the skew stands: #{reason}")
end
