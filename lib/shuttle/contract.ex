defmodule Shuttle.Contract do
  @moduledoc """
  The daemon's expected level of the CLI's daemon-shelled surface — the
  Elixir-side companion to `cmd/shuttle_contract.go`'s `ShuttleContractLevel`.

  Bump `@expected_level` IN LOCKSTEP with that Go constant whenever a change
  touches the daemon-shelled CLI surface (see `cmd/shuttle_contract.go`'s
  moduledoc for exactly what counts — a flag added/removed/renamed on
  mark-runtime/reopen/any verb the daemon shells at dispatch/conclude time, or
  a change to what a shelled verb's stdout/exit code means). This is the exact
  skew that shipped 80ce7b3: a post-fix daemon shelling a pre-fix CLI that
  silently failed every dispatch write because it didn't know `--host`.

  At `Shuttle.Poller.init/1` the daemon shells `felt shuttle contract` and
  compares its bare-integer stdout against `expected_level/0` — catching a
  stale CLI installed alongside a newer daemon (or vice versa) once at boot
  instead of failing one shelled write at a time with "unknown flag".
  """

  require Logger

  @expected_level 1

  @doc "The daemon's expected `felt shuttle contract` level."
  @spec expected_level() :: pos_integer()
  def expected_level, do: @expected_level

  @doc """
  Shell `felt shuttle contract` through `runner` (Runner-bounded — tolerant of
  a slow node, never hangs boot) and compare its output to `expected_level/0`.

  Always returns a map, never raises:

      %{expected: 1, observed: 1, ok: true, reason: nil}
      %{expected: 1, observed: 2, ok: false, reason: "expected contract level 1, CLI reports 2"}
      %{expected: 1, observed: "unknown command \\"contract\\"...", ok: false, reason: "..."}

  `ok: false` covers EVERY shape other than an exact match on stdout exactly
  `"<expected_level>\\n"` at exit 0 — a mismatched level, unparseable/
  multi-line stdout, or a nonzero exit (including an old CLI where `contract`
  is an unknown subcommand: the daemon cannot determine its level, so it must
  be treated as incompatible, same as an explicit mismatch).
  """
  @spec check(module()) :: %{
          expected: pos_integer(),
          observed: integer() | String.t(),
          ok: boolean(),
          reason: String.t() | nil
        }
  def check(runner) do
    case runner.cmd("felt", ["shuttle", "contract"], stderr_to_stdout: true) do
      {output, 0} ->
        parse_level(output)

      {output, status} ->
        trimmed = output |> to_string() |> String.trim()

        %{
          expected: @expected_level,
          observed: trimmed,
          ok: false,
          reason: "felt shuttle contract exited #{inspect(status)}: #{trimmed}"
        }
    end
  rescue
    e ->
      %{
        expected: @expected_level,
        observed: "error",
        ok: false,
        reason: "felt shuttle contract raised: #{inspect(e)}"
      }
  end

  defp parse_level(output) do
    trimmed = String.trim(output)

    case Integer.parse(trimmed) do
      {level, ""} when level == @expected_level ->
        %{expected: @expected_level, observed: level, ok: true, reason: nil}

      {level, ""} ->
        %{
          expected: @expected_level,
          observed: level,
          ok: false,
          reason: "expected contract level #{@expected_level}, CLI reports #{level}"
        }

      _ ->
        %{
          expected: @expected_level,
          observed: trimmed,
          ok: false,
          reason:
            "expected contract level #{@expected_level}, CLI stdout unparseable: #{inspect(trimmed)}"
        }
    end
  end

  @doc """
  Run `check/1` and log at the appropriate level: `debug` on a match, `error`
  (loud, boot-visible) on skew — a stale CLI means every shelled write this
  daemon makes is suspect.
  """
  @spec check_and_log(module()) :: map()
  def check_and_log(runner) do
    result = check(runner)

    if result.ok do
      Logger.debug("felt shuttle contract level #{result.observed} matches expected #{result.expected}")
    else
      Logger.error(
        "CLI/daemon contract skew at boot: #{result.reason}. " <>
          "Fresh dispatches are held until this is fixed and the daemon is restarted " <>
          "(make daemon installs the matching CLI; see cmd/shuttle_contract.go)."
      )
    end

    result
  end
end
