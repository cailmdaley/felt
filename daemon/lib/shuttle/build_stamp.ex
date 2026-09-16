defmodule Shuttle.BuildStamp do
  @moduledoc """
  What this daemon is, as four fields: the commit it was built from, when it
  was built, when it booted, and its release version.

  Two consumers, and the second is why this module exists rather than the
  fields being assembled inline where they were first needed:

    * `GET /api/v1/version` — the deploy verifier's target. A deploy is
      complete when `git_short_sha` AND `booted_at` have both moved, which is
      why both are here and neither is sufficient: the release boots
      `:interactive`, so modules load lazily and a long-running daemon can
      report a fresh `git_sha` out of beams that were swapped underneath it.
    * the poll snapshot, and through it `GET /api/v1/state/composite` — so a
      hub's fleet view can answer "which host is on which build" from the one
      composite it already fetches, instead of a round trip per host.

  `Shuttle.BuildInfo` is generated at build time (`mix shuttle.gen_version`),
  so every read of it is guarded: a checkout that has not generated it yet
  still boots, and reports `"unknown"` rather than failing to compile the
  endpoint that would have told you so.
  """

  @doc """
  The stamp. String-valued throughout, `"unknown"` where a source is absent,
  so a consumer never has to distinguish a missing field from a null one.
  """
  @spec stamp() :: %{
          git_sha: String.t(),
          git_short_sha: String.t(),
          built_at: String.t(),
          booted_at: String.t(),
          mix_vsn: String.t()
        }
  def stamp do
    sha = git_sha()

    %{
      git_sha: sha,
      git_short_sha: short_sha(sha),
      built_at: built_at(),
      booted_at: booted_at(),
      mix_vsn: mix_vsn()
    }
  end

  @doc "The full commit this daemon was built from, or `\"unknown\"`."
  @spec git_sha() :: String.t()
  def git_sha, do: build_info(:git_sha)

  @doc "The build timestamp, ISO8601, or `\"unknown\"`."
  @spec built_at() :: String.t()
  def built_at, do: build_info(:built_at)

  @doc """
  When this OS process started, ISO8601, or `\"unknown\"`.

  Stamped by `Shuttle.Application.start/2` into the app env — a runtime fact,
  deliberately not a compile-time one.
  """
  @spec booted_at() :: String.t()
  def booted_at do
    case Application.get_env(:shuttle, :booted_at) do
      %DateTime{} = dt -> DateTime.to_iso8601(dt)
      _ -> "unknown"
    end
  end

  @doc "The first seven characters of a sha — what a human reads and compares."
  @spec short_sha(String.t()) :: String.t()
  def short_sha(sha) when is_binary(sha), do: String.slice(sha, 0, 7)
  def short_sha(_), do: "unknown"

  defp mix_vsn do
    Shuttle.version()
  rescue
    _ -> "unknown"
  end

  defp build_info(function) do
    if Code.ensure_loaded?(Shuttle.BuildInfo) and
         function_exported?(Shuttle.BuildInfo, function, 0) do
      apply(Shuttle.BuildInfo, function, [])
    else
      "unknown"
    end
  end
end
