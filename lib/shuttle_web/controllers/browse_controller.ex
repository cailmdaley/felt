defmodule ShuttleWeb.BrowseController do
  @moduledoc """
  Directory browsing by absolute path: `GET /api/v1/browse?path=…&origin=…`.

  The read half of the UI's "+ Add project…" affordance. Registering a project
  used to mean hand-editing `~/.config/felt/projects.json`; the picker now walks
  the filesystem instead, and this is the walk. It lists **subdirectories only** —
  the caller is choosing a project root, not a file — and marks the ones that are
  already felt stores so the human can see where a `.felt/` already lives.

  **Owner-routed via `Shuttle.OriginRouter`, exactly like `/file`.** Only the
  owning daemon can read its own host's filesystem, so browsing a remote's tree
  forwards to that daemon's identical `/browse` (origin stripped) and relays its
  JSON verbatim (`OriginRouter.forward_get/4` + `relay_bytes/2` — the forwarded
  body is already the JSON the owner produced).

  **Path contract**, mirroring `/file`: `path` must be ABSOLUTE (a relative one
  is a 400) and must be a readable directory (missing/unreadable is a 404).
  Omitted → the user's home directory, so the picker can open cold. Entries
  starting with `.` are skipped: a project root is never a dotdir, and hiding
  them keeps `~` legible.

  Response:

      %{
        path: "/Users/x/Documents/projects",
        parent: "/Users/x/Documents",   # null at the filesystem root
        entries: [%{name: "felt", path: "…/felt", has_felt: true}, …]
      }
  """

  use Phoenix.Controller, formats: [:json]
  import ShuttleWeb.RelayHelpers, only: [relay_bytes: 2]

  alias Shuttle.OriginRouter

  def show(conn, params) do
    case OriginRouter.route(Map.get(params, "origin")) do
      {:remote, remote} ->
        query = params |> Map.take(["path"]) |> Map.reject(fn {_k, v} -> v in [nil, ""] end)
        relay_bytes(conn, OriginRouter.forward_get(remote, "/api/v1/browse", query))

      :local ->
        browse_local(conn, requested_path(params))
    end
  end

  defp requested_path(%{"path" => path}) when is_binary(path) and path != "", do: path
  defp requested_path(_params), do: System.user_home() || "/"

  defp browse_local(conn, path) do
    cond do
      Path.type(path) != :absolute ->
        conn |> put_status(400) |> json(%{error: "path must be absolute"})

      true ->
        expanded = Path.expand(path)

        case File.ls(expanded) do
          {:ok, names} ->
            json(conn, %{
              path: expanded,
              parent: parent_of(expanded),
              entries: entries(expanded, names)
            })

          {:error, _reason} ->
            conn |> put_status(404) |> json(%{error: "directory not found"})
        end
    end
  end

  # `Path.dirname/1` is its own fixpoint at the filesystem root ("/" → "/"), so
  # that fixpoint is what marks "no parent" — the picker hides its `..` row on a
  # null rather than looping on itself.
  defp parent_of(path) do
    parent = Path.dirname(path)
    if parent == path, do: nil, else: parent
  end

  defp entries(root, names) do
    names
    |> Enum.reject(&String.starts_with?(&1, "."))
    |> Enum.sort(:asc)
    |> Enum.map(&{&1, Path.join(root, &1)})
    |> Enum.filter(fn {_name, full} -> File.dir?(full) end)
    |> Enum.map(fn {name, full} ->
      %{name: name, path: full, has_felt: File.dir?(Path.join(full, ".felt"))}
    end)
  end
end
