defmodule ShuttleWeb.Assets do
  @moduledoc """
  Resolves the built Shuttle UI bundle directory (`ui/dist`).

  The daemon serves its own frontend, so "the UI to Shuttle" is one process. The
  bundle path is resolved ONCE at COMPILE time and used by both the `Plug.Static`
  mount and the SPA index fallback, so the two can never disagree about where the
  bundle lives.

  Resolution: `SHUTTLE_UI_DIST` if set in the build environment, else this
  module's `__DIR__` (`lib/shuttle_web`) joined to `../../ui/dist`. Under the
  build-on-host deploy model — the escript is rebuilt on every host from a
  checkout at the same path — the `__DIR__`-derived path points at that host's
  `ui/dist` regardless of the daemon's runtime working directory. The escript
  bakes its config at build time, so a compile-time override is the honest fit;
  relocating the bundle on a running daemon means a rebuild, the same as any
  other config change.
  """

  @dist (System.get_env("SHUTTLE_UI_DIST") ||
           Path.expand(Path.join([__DIR__, "..", "..", "ui", "dist"])))

  @doc "Absolute path to the built UI bundle directory (compile-time constant)."
  @spec dist() :: String.t()
  def dist, do: @dist
end
