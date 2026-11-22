defmodule Shuttle.Go do
  @moduledoc """
  The one verb that moves Rex: `go` shows a fiber's live worker in the Mac's
  Rex app (`POST /api/v1/go`). It never starts a worker, and it touches neither
  the voice target nor a board.

  The request is owner-routed like `/transition`. The owner resolves the fiber
  and its live worker. A worker in the owner's Rex server has its window
  selected in the macOS app client attached to that server, and in no other
  client; the daemon the human asked then brings the Rex app forward. A fiber
  without a live worker (including resting, draft, tempered, or discarded
  fibers) opens a view-only Rex place when pages are enabled. A tmux worker
  opens as the `/attach` viewer (`Shuttle.Opener.open/2`) on the daemon the
  human asked: an owner reached by a forward answers its session name instead,
  since only the asking daemon holds the display.

  The answer is `%{went: bool, place: "live" | "view" | "none"}`. `place` says
  whether the fiber has a live worker or a view-only place; `went: false` with
  place `live` or `view` means Rex could not show it (no Mac app attached to
  the worker's Rex server, or no terminal holding it).
  """

  alias Shuttle.{Env, FiberDocuments, OriginRouter, Poller, Remote, Terminal}
  alias Shuttle.Terminal.{Rex, RexLayout}

  @none %{went: false, place: "none"}
  @live %{went: true, place: "live"}
  @unshown %{went: false, place: "live"}
  @view %{went: true, place: "view"}
  @unshown_view %{went: false, place: "view"}

  @type answer :: %{
          required(:went) => boolean(),
          required(:place) => String.t(),
          optional(atom()) => term()
        }

  @doc """
  Go to `fiber_id`, owned by `origin`. With `forwarded: true` (an owner's leg
  of a hub's request) it selects without bringing the app forward and leaves a
  tmux worker's display to the hub. With `activate: false` it selects the tab
  quietly without bringing Rex forward.

  `{:ok, answer}`, `{:forwarded, status, body}` for an owner's refusal relayed
  verbatim, or `{:error, reason}` (`http_error/1`).
  """
  @spec go(String.t(), String.t() | nil, keyword()) ::
          {:ok, answer()} | {:forwarded, non_neg_integer(), String.t()} | {:error, term()}
  def go(fiber_id, origin, opts \\ []) do
    forwarded? = Keyword.get(opts, :forwarded, false)
    activate? = Keyword.get(opts, :activate, true) and not forwarded?

    case OriginRouter.route(origin) do
      {:error, _} = error -> error
      :local -> here(fiber_id, not forwarded?, activate?)
      {:remote, %Remote{} = remote} -> there(remote, fiber_id, activate?)
    end
  end

  @doc "Go to the Desk tab in Rex when `pages.desk` is enabled."
  @spec desk() :: {:ok, answer()} | {:error, term()}
  def desk, do: surface(:desk)

  @doc "Go to the Fleet Map tab in Rex when `pages.desk` is enabled."
  @spec map() :: {:ok, answer()} | {:error, term()}
  def map, do: surface(:map)

  defp surface(kind) when kind in [:desk, :map] do
    if Terminal.primary() == Rex and match?({:ok, %{desk: true}}, Shuttle.Host.pages()) do
      runner = runner()
      ensure = if kind == :desk, do: &RexLayout.ensure_desk/1, else: &RexLayout.ensure_map/1

      with {:ok, entry} <- ensure.(runner),
           {:ok, moved} <- Rex.select_binding(runner, entry, mac_only: true),
           :ok <- if(moved, do: Rex.activate_app(runner), else: :ok) do
        {:ok, %{went: moved, place: Atom.to_string(kind)}}
      end
    else
      {:ok, @none}
    end
  end

  @doc "The HTTP status and words for a refused go."
  def http_error({:unknown_origin, origin}),
    do: {400, OriginRouter.unknown_origin_message(origin)}

  def http_error(:not_found), do: {404, "not_found"}

  def http_error({:closed, column}),
    do: {422, "the fiber is #{column}; there is nothing to go to"}

  def http_error({:forward_failed, name, reason}),
    do: {502, "forward to #{name} failed: #{inspect(reason)}"}

  def http_error({:absent, name}), do: {502, Shuttle.Opener.absent_message(name)}
  def http_error(reason) when is_binary(reason), do: {502, reason}
  def http_error(reason), do: {502, inspect(reason)}

  defp here(fiber_id, display?, activate?) do
    with {:ok, fiber} <- fiber(fiber_id) do
      case Poller.live_worker(fiber["uid"] || fiber_id) do
        nil -> show_place(fiber, activate?)
        worker -> show(worker.session, display?, activate?)
      end
    end
  end

  defp show_place(fiber, activate?) do
    if Terminal.primary() == Rex and match?({:ok, _}, Shuttle.Host.pages()) do
      runner = runner()

      with {:ok, place} <- RexLayout.ensure_place(runner, fiber),
           {:ok, moved} <- Rex.select_binding(runner, place, mac_only: true),
           :ok <- if(moved and activate?, do: Rex.activate_app(runner), else: :ok) do
        {:ok, if(moved, do: @view, else: @unshown_view)}
      end
    else
      {:ok, @none}
    end
  end

  defp fiber(fiber_id) do
    case FiberDocuments.get(fiber_id) do
      {:ok, %{fibers: [%{fiber: fiber} | _]}} -> {:ok, fiber}
      {:ok, %{fibers: []}} -> {:error, :not_found}
      {:error, reason} -> {:error, "could not read #{fiber_id}: #{inspect(reason)}"}
    end
  end

  defp show(name, display?, activate?) do
    runner = runner()

    case Terminal.locate_target(runner, name) do
      {Rex, binding} ->
        with {:ok, moved} <- Rex.select_binding(runner, binding, mac_only: true),
             :ok <- if(moved and activate?, do: Rex.activate_app(runner), else: :ok) do
          {:ok, if(moved, do: @live, else: @unshown)}
        end

      {Terminal.Tmux, _} when display? ->
        opened(opener().open(name, nil))

      {Terminal.Tmux, _} ->
        {:ok, Map.put(@unshown, :tmux_session, name)}

      nil ->
        {:ok, @unshown}
    end
  end

  defp there(remote, fiber_id, activate?) do
    case OriginRouter.forward(remote, "/api/v1/go", %{"fiber_id" => fiber_id, "forwarded" => true}) do
      {:forwarded, 200, body} ->
        case Jason.decode(body) do
          {:ok, %{"went" => true} = reply} ->
            place = if reply["place"] in ["live", "view"], do: reply["place"], else: "live"

            with :ok <- if(activate?, do: Rex.activate_app(runner()), else: :ok),
                 do: {:ok, %{went: true, place: place}}

          {:ok, %{"tmux_session" => name}} when is_binary(name) ->
            opened(opener().open(name, remote.name))

          {:ok, %{"went" => false, "place" => place}} when place in ["live", "view", "none"] ->
            {:ok, %{went: false, place: place}}

          _ ->
            {:error, "#{remote.name} answered go without saying where it went"}
        end

      {:forwarded, _status, _body} = refused ->
        refused

      {:error, _} = error ->
        error
    end
  end

  defp opened(:ok), do: {:ok, @live}
  defp opened({:error, {:absent, _}}), do: {:ok, @unshown}
  defp opened({:error, _} = error), do: error

  defp opener, do: Env.app(:opener_impl, Shuttle.Opener)
  defp runner, do: Env.app(:rex_runner, Shuttle.Runner.Default)
end
