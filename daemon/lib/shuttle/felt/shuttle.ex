defmodule Shuttle.Felt.Shuttle do
  @moduledoc """
  The ONE audited builder for `felt shuttle <verb> <fiber> …` calls — every
  daemon/Phoenix write-plane site that shells a `felt shuttle` lifecycle verb
  (mark-runtime, reopen, pause, close, …) routes through here instead of
  hand-rolling `["shuttle", verb, fiber_id | args]` per callsite (C2). Owns:

    * the `"shuttle"` prefix and verb/fiber_id positional ordering
    * the `--felt-store <path>` flag, via the `:felt_store` option — the one
      place "remember the store flag" stops being a per-callsite obligation
    * delegating execution + error-mapping to `Shuttle.Felt.run/2` (already
      Runner-bounded — see F3/C3), via its `:runner` override, so a callsite
      with an explicit runner (the Poller's `state.runner` test seam) and one
      without (a Phoenix controller, `Shuttle.Felt`'s app-config default)
      share the same execution path and error shape.

  Post-S1/C1, felt's own `resolveOwnHost` is pure local state (env var → host
  file → hostname; no re-entrant daemon round-trip), so there is no `--host`
  ownership-override flag here — every daemon-shelled write resolves its own
  identity locally now, the same as every human-facing verb. A site that
  genuinely needs a DIFFERENT host (`install`/`pin`'s cross-host install
  feature — stamping a block for another host, not overriding this daemon's
  own identity) builds that `--host` itself; it is not part of this helper's
  contract.
  """

  alias Shuttle.Felt

  # The verbs felt can route to an owning daemon. The daemon is the owner, so
  # it runs each of them with `--local`: the write lands here, never calls
  # back into this daemon, and a fiber another host owns is refused rather
  # than forwarded.
  @local_verbs ~w(pause resume close reopen accept set-outcome set-model set-agent reshape uninstall)

  @doc """
  Run `felt shuttle <verb> <fiber_id> <args...>`.

  `args` is a flat list of extra argv tokens — bare flags (`"--as-draft"`) or
  already-paired ones (`["--dispatched-at", ts]`); callers build their own
  flag lists, this only places them after the fiber id.

  `opts`:

    * `:felt_store` — prefixes `--felt-store <path>` (nil/absent/empty omits
      it). Mutually exclusive in practice with passing `:cd` yourself — pick
      one addressing scheme per callsite; both ultimately just tell felt
      which store to resolve `fiber_id` against.
    * `:runner` — the module to shell through; forwarded to
      `Shuttle.Felt.run/2`'s own `:runner` override. Omit to fall back to
      `Shuttle.Felt`'s app-config default (the Phoenix-controller path with no
      explicit Poller runner in scope).
    * anything else forwards to `Shuttle.Felt.run/2` verbatim (`:cd`, `:env`,
      `:timeout_ms`, …).

  A verb felt can route to an owning daemon (`pause`, `resume`, `close`,
  `reopen`, `accept`, `set-outcome`, `set-model`, `set-agent`, `reshape`,
  `uninstall`) gets `--local` appended.
  """
  @spec run(String.t(), String.t(), [String.t()], keyword()) :: Felt.result()
  def run(verb, fiber_id, args \\ [], opts \\ []) do
    {felt_store, opts} = Keyword.pop(opts, :felt_store)

    argv =
      (["shuttle"] ++ felt_store_flag(felt_store) ++ [verb, fiber_id]) ++ args ++ local_flag(verb)

    Felt.run(argv, opts)
  end

  defp local_flag(verb) when verb in @local_verbs, do: ["--local"]
  defp local_flag(_verb), do: []

  defp felt_store_flag(store) when is_binary(store) and store != "", do: ["--felt-store", store]
  defp felt_store_flag(_), do: []
end
