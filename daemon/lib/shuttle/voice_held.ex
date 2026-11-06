defmodule Shuttle.Voice.Held do
  @moduledoc "Durable, checkpointed speech drafts owned by the transcript relay coordinator."

  def load(path) do
    case Shuttle.FS.read(path) do
      {:error, :enoent} ->
        %{"seen" => %{}, "cards" => []}

      {:ok, bytes} ->
        case Jason.decode(bytes) do
          {:ok, %{"seen" => seen, "cards" => cards} = state}
          when is_map(seen) and is_list(cards) ->
            validate!(state)
            state

          _ ->
            %{"error" => "invalid held voice state"}
        end

      {:error, reason} ->
        %{"error" => "cannot read held voice: #{inspect(reason)}"}
    end
  rescue
    _ -> %{"error" => "invalid held voice state"}
  end

  defp validate!(state) do
    true =
      Enum.all?(state["seen"], fn {key, offset} ->
        is_binary(key) and is_integer(offset) and offset >= 0
      end)

    Enum.each(state["cards"], fn card ->
      true = Enum.all?(~w(id fiber_id), &is_binary(card[&1]))
      true = is_integer(card["through"]) and card["through"] > 0
      true = is_binary(card["speaker"])
      true = is_list(card["segments"]) and card["segments"] != []

      Enum.reduce(card["segments"], 0, fn segment, previous ->
        true = is_binary(segment["text"])
        through = segment["through"]
        true = is_integer(through) and through > previous and through <= card["through"]
        through
      end)
    end)
  end

  def save!(path, state) do
    :ok = Shuttle.FS.mkdir_p(Path.dirname(path))
    :ok = Shuttle.FS.write_atomic(path, Jason.encode!(state) <> "\n")
    state
  end

  def list(%{"error" => error}), do: {:error, error}
  def list(state), do: Enum.map(state["cards"], &public/1)

  def append(%{"error" => error}, _, _, _, _), do: raise(error)

  def append(state, launch, offset, target, rows) do
    existing = Enum.find(state["cards"], &same_target?(&1, target))
    source = Jason.encode!([launch, target["fiber_id"], target["origin"]])

    if offset <= Map.get(state["seen"], source, -1) do
      {state, if(existing, do: public(existing))}
    else
      card =
        existing ||
          Map.merge(Map.take(target, ~w(fiber_id origin)), %{
            "id" => Base.url_encode64(:crypto.strong_rand_bytes(12), padding: false),
            "through" => 0,
            "segments" => [],
            "speaker" => nil
          })

      card =
        Enum.reduce(rows, card, fn %{"speaker" => speaker, "text" => text}, card ->
          prefix =
            cond do
              card["segments"] == [] -> speaker <> ": "
              card["speaker"] == speaker -> " "
              true -> "\n" <> speaker <> ": "
            end

          through = card["through"] + 1

          card
          |> Map.put("through", through)
          |> Map.put("speaker", speaker)
          |> Map.update!("segments", &(&1 ++ [%{"through" => through, "text" => prefix <> text}]))
        end)

      next = state |> put_in(["seen", source], offset) |> put_card(card)
      {next, public(card)}
    end
  end

  def edit(state, id, through, text) when is_binary(text) do
    with {:ok, card, prefix, rest} <- split(state, id, through) do
      segment = %{"through" => List.last(prefix)["through"], "text" => text}
      {:ok, put_card(state, Map.put(card, "segments", [segment | rest]))}
    end
  end

  def take(state, id, through) do
    with {:ok, card, prefix, rest} <- split(state, id, through) do
      next =
        if rest == [],
          do: drop_card(state, id),
          else: put_card(state, Map.put(card, "segments", rest))

      {:ok, next, Enum.map_join(prefix, & &1["text"])}
    end
  end

  def target(%{"error" => _}, _target), do: nil
  def target(state, target), do: Enum.find(state["cards"], &same_target?(&1, target))

  defp split(%{"error" => error}, _id, _through), do: {:error, error}

  defp split(state, id, through) when is_binary(id) and is_integer(through) do
    with card when not is_nil(card) <- Enum.find(state["cards"], &(&1["id"] == id)),
         true <- Enum.any?(card["segments"], &(&1["through"] == through)) do
      {prefix, rest} = Enum.split_while(card["segments"], &(&1["through"] <= through))
      {:ok, card, prefix, rest}
    else
      _ -> {:error, :conflict}
    end
  end

  defp split(_, _, _), do: {:error, :conflict}

  defp public(card),
    do:
      card
      |> Map.take(~w(id fiber_id origin through))
      |> Map.put("text", Enum.map_join(card["segments"], & &1["text"]))

  defp same_target?(a, b), do: a["fiber_id"] == b["fiber_id"] and a["origin"] == b["origin"]

  defp put_card(state, card),
    do:
      Map.update!(state, "cards", &(Enum.reject(&1, fn c -> c["id"] == card["id"] end) ++ [card]))

  defp drop_card(state, id),
    do: Map.update!(state, "cards", &Enum.reject(&1, fn c -> c["id"] == id end))
end
