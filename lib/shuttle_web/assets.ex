defmodule ShuttleWeb.Assets do
  @moduledoc """
  Resolves the built Shuttle UI bundle directory (`ui/dist`).

  The daemon serves its own frontend, so "the UI to Shuttle" is one process.
  Both consumers — the `Plug.Static` mount (via an MFA `:from`, resolved per
  request) and the SPA index fallback — call `dist/0`, so they can never
  disagree about where the bundle lives.

  Resolution, at RUNTIME, in order:

  1. `SHUTTLE_UI_DIST` — explicit override in the daemon's environment.
  2. The release's own `priv/ui/dist` — the CI release pipeline copies the
     built bundle into `priv/` before `mix release`, so a fetched daemon
     serves the bundle it shipped with, wherever the tree is unpacked.
  3. The source checkout's `ui/dist` (compile-time `__DIR__`-derived) — the
     build-on-host path, where the bundle is built or rsynced beside the code.
  """

  @src_dist Path.expand(Path.join([__DIR__, "..", "..", "ui", "dist"]))

  @doc "Absolute path to the built UI bundle directory."
  @spec dist() :: String.t()
  def dist do
    System.get_env("SHUTTLE_UI_DIST") || priv_dist() || @src_dist
  end

  defp priv_dist do
    path = Application.app_dir(:shuttle, "priv/ui/dist")
    if File.dir?(path), do: path
  rescue
    # :code.priv_dir fails in contexts where the app is not loaded (rare —
    # compile-time evaluation of other modules); fall through to the checkout.
    _ -> nil
  end
end
