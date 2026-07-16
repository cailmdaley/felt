defmodule ShuttleWeb.AstraController do
  @moduledoc """
  Bake an `astra.yaml` to MyST mdast: `GET /api/v1/astra?path=…&origin=…&universe=…`.

  The ASTRA path of the standalone UI. The paper entry (`paper.html`) renders a
  full Lightcone paper via `@lightcone/renderer`, fed the mdast this route
  produces. MySTRA ships no one-shot transform — its CLI only boots an HTTP
  server — but its `loadASTRASource` + `buildAllPages` are a pure, offline
  library pair; `priv/mystra/bake.mjs` calls them and emits `{ pages }` JSON to
  stdout. This route shells out to it once per opened astra.yaml. The common
  path (fibers, files) never touches MySTRA — only an opened astra.yaml does.

  **Owner-routed via `Shuttle.OriginRouter`, exactly like `/file`.** Only the
  owning daemon can read its own host's `results/` tree, so a remote-owned
  astra.yaml is baked *there* and the mdast relayed back — never the whole
  project tree shipped here. A local origin bakes here; a remote origin forwards
  to the owning daemon's identical `/astra` (origin stripped) and relays its JSON.

  **Path contract.** `path` is the ABSOLUTE project directory holding the
  `astra.yaml` (the panel passes `dirname(embed)`). A relative path is a 400; a
  dir with no `astra.yaml` is a 404; a bake failure (bad yaml, missing MySTRA,
  no `node`) is a 502/500 carrying the diagnostic — never a silent 500.

  Requires `node` on PATH and a built MySTRA checkout on the bake host
  (`LC_MYSTRA_DIR`, else `bake.mjs`'s sibling fallback). A host without them
  fails this route cleanly; the board and fibers are unaffected.
  """

  use Phoenix.Controller, formats: [:json]
  import ShuttleWeb.RelayHelpers, only: [relay_bytes: 2]

  require Logger
  alias Shuttle.OriginRouter

  # Resolved ONCE at compile time, mirroring `ShuttleWeb.Assets`: the escript is
  # rebuilt on every host from a same-path checkout, so the `__DIR__`-derived
  # path points at that host's `priv/mystra/bake.mjs` regardless of the daemon's
  # runtime cwd. `SHUTTLE_BAKE_SCRIPT` overrides at build time.
  @bake_script (System.get_env("SHUTTLE_BAKE_SCRIPT") ||
                  Path.expand(Path.join([__DIR__, "..", "..", "..", "priv", "mystra", "bake.mjs"])))

  def show(conn, %{"path" => path} = params) when is_binary(path) and path != "" do
    case OriginRouter.route(Map.get(params, "origin")) do
      {:remote, remote} ->
        relay_bytes(conn, OriginRouter.forward_get(remote, "/api/v1/astra", Map.take(params, ["path", "universe"])))

      :local ->
        bake_local(conn, path, Map.get(params, "universe"))
    end
  end

  def show(conn, _params) do
    conn |> put_status(400) |> json(%{error: "path is required"})
  end

  defp bake_local(conn, path, universe) do
    cond do
      Path.type(path) != :absolute ->
        conn |> put_status(400) |> json(%{error: "path must be absolute"})

      not File.dir?(path) ->
        conn |> put_status(404) |> json(%{error: "project dir not found"})

      not File.regular?(Path.join(path, "astra.yaml")) ->
        conn |> put_status(404) |> json(%{error: "no astra.yaml in project dir"})

      true ->
        run_bake(conn, path, universe)
    end
  end

  defp run_bake(conn, path, universe) do
    args = [@bake_script, path] ++ if universe in [nil, ""], do: [], else: [universe]

    case bake_cmd(args) do
      {out, 0} ->
        conn |> put_resp_content_type("application/json") |> send_resp(200, out)

      {err, code} ->
        Logger.warning("astra bake failed (exit #{code}) for #{path}: #{err}")
        conn |> put_status(502) |> json(%{error: "bake failed", detail: String.slice(err, 0, 800)})
    end
  rescue
    e in ErlangError ->
      # `bash` unspawnable — both invocation paths failed.
      Logger.warning("astra bake could not run for #{path}: #{Exception.message(e)}")
      conn |> put_status(500) |> json(%{error: "bake could not run", detail: Exception.message(e)})
  end

  # Run the bake. Try `node` on the daemon's PATH first (fast); if it isn't there
  # — a respawn-loop launcher may source asdf (erlang/elixir) but not nvm — retry
  # through a login shell so the user's node (nvm/homebrew/…) is found. The bake
  # is on-demand, so the extra shell on the fallback is cheap. `$@` carries the
  # args so a path with spaces survives.
  defp bake_cmd(args) do
    System.cmd("node", args, stderr_to_stdout: false)
  rescue
    ErlangError ->
      System.cmd("bash", ["-lc", ~s(exec node "$@"), "bake" | args], stderr_to_stdout: false)
  end

end
