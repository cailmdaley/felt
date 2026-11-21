defmodule Shuttle.Terminal.RexPages do
  @moduledoc """
  Thread pages beside Rex workers. With `pages` enabled in host.json
  (`Shuttle.Host.pages/0`), a live worker's window is `[chat | page]`. The page
  is a Shuttle-owned holder block labelled `rexweb shuttle`: it sets its
  terminal title to `rexweb <url>` and prints the URL as a link, and RexWeb
  draws the thread page over any block carrying that label and title. Without
  RexWeb the link is all there is.

  A launch creates the window with both blocks (`with_page/3`). `reconcile/1`
  brings every other bound worker to that state: it gives a placed worker
  without a page its page, closes every `rexweb shuttle` block in a Shuttle
  session that no placed worker records (a late duplicate, a hidden worker's
  page, a shell Rex restored), and leaves a page the human closed closed until
  the worker's next launch.
  """

  require Logger
  alias Shuttle.Rex
  alias Shuttle.Terminal.RexBindings, as: Bindings

  @label "rexweb shuttle"
  # A Linux remote can take ten seconds to start a block.
  @timeout_ms 60_000

  @holder ~S"""
  url=$1; stty -echo 2>/dev/null
  printf '\033]2;rexweb %s\007\033[?25l\033[2J\033[H  \033]8;;%s\033\\%s\033]8;;\033\\\n' "$url" "$url" "$url"
  while :; do IFS= read -r _ || sleep 3600; done
  """

  def label, do: @label
  def timeout_ms, do: @timeout_ms

  @doc "Whether a Rex block is a page holder."
  def page?(block), do: block["label"] == @label

  @doc "The thread page's URL for a fiber on this daemon's host."
  def url(base, uid),
    do: "#{base}/thread?f=#{enc(uid)}@#{enc(Shuttle.Poller.own_host_id())}&in=rex"

  defp enc(part), do: URI.encode_www_form(part)

  @doc "The fiber uid a worker's page shows: the one in its name, else its fiber's."
  def uid(name, fiber) do
    Shuttle.ULID.from_tmux(name) ||
      case Shuttle.Terminal.RexTree.resolve(fiber) do
        {:ok, %{uid: uid}} when is_binary(uid) -> uid
        _ -> nil
      end
  end

  @doc """
  The launch spec with the worker's window split `[chat | page]`, and the
  timeout its creation needs; the spec unchanged with pages off or no uid.
  """
  def with_page(spec, uid) do
    with {:ok, %{base: base}} <- Shuttle.Host.pages(),
         true <- is_binary(uid),
         {:ok, page} <- block(url(base, uid)) do
      spec =
        update_in(spec, ["initial_windows", Access.at(0), "layout"], fn chat ->
          %{
            "split" => %{
              "direction" => "horizontal",
              "ratio" => 0.5,
              "before" => chat,
              "after" => %{"block" => page}
            }
          }
        end)

      {spec, [timeout_ms: @timeout_ms]}
    else
      _ -> {spec, []}
    end
  end

  defp block(url) do
    with {:ok, holder} <- holder() do
      {:ok,
       %{
         "flavor" => "com.superlogical.terminal.shell",
         "label" => @label,
         "options" => %{
           "shell" => "none",
           "command" => ["sh", holder, url],
           "exit" => %{"on_completion" => false}
         }
       }}
    end
  end

  defp holder do
    dir = Path.join(Shuttle.data_dir(), "rex")
    path = Path.join(dir, "page-holder.sh")

    if Shuttle.FS.read(path) == {:ok, @holder} do
      {:ok, path}
    else
      with :ok <- Shuttle.FS.mkdir_p(dir),
           :ok <- Shuttle.FS.chmod(dir, 0o700),
           :ok <- Shuttle.FS.write_atomic(path, @holder),
           do: {:ok, path}
    end
  end

  @doc """
  Close a worker's page after its block left the view, so the page's window
  closes with it. `place` and `reconcile/1` give it a page again.
  """
  def close_for(runner, sid, bid) do
    with {:ok, doc} <- Bindings.read() do
      case Enum.find(doc["bindings"], fn {_, b} -> b["block_id"] == bid end) do
        {name, %{"page_block_id" => page} = b} ->
          with :ok <- close(runner, sid, page),
               do: Bindings.put_page(name, b, %{"page_block_id" => nil})

        _ ->
          :ok
      end
    end
  end

  @doc "Bring every Shuttle session's pages to the state the bindings and the flag ask for."
  def reconcile(runner) do
    pages = with {:ok, pages} <- Shuttle.Host.pages(), do: pages

    with {:ok, doc} <- Bindings.read() do
      # With pages off and none recorded there is nothing to look at.
      if pages != nil or Enum.any?(doc["bindings"], fn {_, b} -> b["page_block_id"] end) do
        roots = Map.new(doc["families"] || %{}, fn {root, sid} -> {sid, root} end)

        bound =
          for {name, b} <- doc["bindings"], into: %{}, do: {b["session_id"], b["family"] || name}

        Enum.each(Map.merge(bound, roots), fn {sid, root} ->
          result =
            Shuttle.Terminal.Rex.family_lock(root, fn -> reconcile_session(runner, sid, pages) end)

          unless result in [:ok, {:error, :not_found}],
            do: Logger.warning("Rex page reconcile failed for #{sid}: #{inspect(result)}")
        end)
      end

      :ok
    end
  end

  defp reconcile_session(runner, sid, pages) do
    with {:ok, doc} <- Bindings.read(),
         {:ok, blocks} <- Rex.blocks(runner, sid) do
      placed =
        Map.new(blocks, &{&1["block_id"], &1["window_id"]})
        |> Map.reject(fn {_, wid} -> wid == nil end)

      bound =
        for {name, b} <- doc["bindings"],
            b["session_id"] == sid,
            Map.has_key?(placed, b["block_id"]),
            do: {name, b}

      keep =
        if pages,
          do: MapSet.new(bound, fn {_, b} -> b["page_block_id"] end),
          else: MapSet.new()

      with :ok <- close_strays(runner, sid, doc, blocks, keep) do
        if pages, do: ensure(runner, sid, bound, placed, pages.base), else: :ok
      end
    end
  end

  defp close_strays(runner, sid, doc, blocks, keep) do
    each(blocks, fn block ->
      if page?(block) and not MapSet.member?(keep, block["block_id"]) do
        with :ok <- close(runner, sid, block["block_id"]) do
          case Enum.find(doc["bindings"], fn {_, b} ->
                 b["page_block_id"] == block["block_id"]
               end) do
            {name, b} -> Bindings.put_page(name, b, %{"page_block_id" => nil})
            nil -> :ok
          end
        end
      else
        :ok
      end
    end)
  end

  defp ensure(runner, sid, bound, placed, base) do
    each(bound, fn {name, b} ->
      cond do
        b["page_block_id"] && Map.has_key?(placed, b["page_block_id"]) ->
          :ok

        # The human closed it; the next launch brings it back.
        b["page_block_id"] ->
          Bindings.put_page(name, b, %{"page_block_id" => nil, "page_closed" => true})

        b["page_closed"] ->
          :ok

        uid = uid(name, b["fiber"]) ->
          split(runner, sid, name, b, uid, base)

        true ->
          :ok
      end
    end)
  end

  defp split(runner, sid, name, b, uid, base) do
    with {:ok, page} <- block(url(base, uid)),
         {:ok, %{"block_ids" => [page_id]}} <-
           Rex.call(
             runner,
             "session.new_split",
             %{
               "anchor_id" => b["block_id"],
               "direction" => "horizontal",
               "side" => "after",
               "ratio" => 0.5,
               "layout" => %{"block" => page},
               "focus" => false
             },
             session: sid,
             timeout_ms: @timeout_ms
           ) do
      Bindings.put_page(name, b, %{"page_block_id" => page_id})
    else
      {:ok, reply} -> {:error, {:unknown, "invalid Rex split reply: #{inspect(reply)}"}}
      error -> error
    end
  end

  defp close(runner, sid, bid) do
    case Rex.call(runner, "block.close", %{"block_id" => bid}, session: sid) do
      {:ok, _} -> :ok
      {:error, :not_found} -> :ok
      error -> error
    end
  end

  defp each(items, fun) do
    Enum.reduce_while(items, :ok, fn item, :ok ->
      case fun.(item) do
        :ok -> {:cont, :ok}
        error -> {:halt, error}
      end
    end)
  end
end
