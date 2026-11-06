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

            Map.update(state, "attempts", %{}, fn attempts ->
              Map.new(attempts, fn {id, attempt} ->
                {id,
                 if(attempt["status"] == "pending",
                   do: Map.merge(attempt, %{"status" => "unconfirmed", "at" => timestamp()}),
                   else: attempt
                 )}
              end)
            end)

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
      after_prefix = Map.get(card, "after", 0)
      true = is_integer(after_prefix) and after_prefix >= 0 and after_prefix < card["through"]
      true = is_binary(card["speaker"])
      true = is_list(card["segments"]) and card["segments"] != []

      Enum.reduce(card["segments"], 0, fn segment, previous ->
        true = is_binary(segment["text"]) and is_binary(segment["speaker"])
        through = segment["through"]
        true = is_integer(through) and through > previous and through <= card["through"]
        through
      end)

      true = is_map(card["checkpoints"])

      true =
        Enum.all?(card["checkpoints"], fn {source, through} ->
          is_binary(source) and is_integer(through) and through > 0 and through <= card["through"]
        end)
    end)

    true = is_map(Map.get(state, "attempts", %{}))

    Enum.each(Map.get(state, "attempts", %{}), fn {id, attempt} ->
      true = is_binary(id) and is_map(attempt)
      true = Enum.all?(~w(fiber_id text at), &is_binary(attempt[&1]))
      true = attempt["status"] in ~w(pending failed unconfirmed)
      {:ok, _, _} = DateTime.from_iso8601(attempt["at"])
    end)
  end

  def save!(path, state) do
    :ok = Shuttle.FS.mkdir_p(Path.dirname(path))
    :ok = Shuttle.FS.write_atomic(path, Jason.encode!(state) <> "\n")
    state
  end

  def list(%{"error" => error}), do: {:error, error}
  def list(state), do: Enum.map(state["cards"], &public/1)

  def lookup(%{"error" => error}, _, _, _), do: {:error, error}

  def lookup(_state, _launch, offset, _target) when not is_integer(offset) or offset < 0,
    do: {:error, "invalid held source offset"}

  def lookup(state, launch, offset, target) do
    source = Jason.encode!([launch, target["fiber_id"], target["origin"]])

    if offset <= Map.get(state["seen"], source, -1) do
      card = target(state, target)
      through = card && get_in(card, ["checkpoints", Jason.encode!([launch, offset])])

      checkpoint =
        if through && Enum.any?(card["segments"], &(&1["through"] == through)),
          do: public(card) |> Map.put("through", through)

      {:seen, checkpoint}
    else
      :unseen
    end
  end

  def append(%{"error" => error}, _, _, _, _), do: raise(error)

  def append(_state, _launch, offset, _target, _rows) when not is_integer(offset) or offset < 0,
    do: raise(ArgumentError, "invalid held source offset")

  def append(state, launch, offset, target, rows) do
    existing = Enum.find(state["cards"], &same_target?(&1, target))
    source = Jason.encode!([launch, target["fiber_id"], target["origin"]])

    if offset <= Map.get(state["seen"], source, -1) do
      {:seen, checkpoint} = lookup(state, launch, offset, target)
      {state, checkpoint}
    else
      card =
        existing ||
          Map.merge(Map.take(target, ~w(fiber_id origin)), %{
            "id" => Base.url_encode64(:crypto.strong_rand_bytes(12), padding: false),
            "through" => 0,
            "after" => 0,
            "segments" => [],
            "speaker" => nil,
            "checkpoints" => %{}
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
          |> Map.update!(
            "segments",
            &(&1 ++ [%{"through" => through, "text" => prefix <> text, "speaker" => speaker}])
          )
        end)

      card = put_in(card, ["checkpoints", Jason.encode!([launch, offset])], card["through"])
      next = state |> put_in(["seen", source], offset) |> put_card(card)
      {next, public(card)}
    end
  end

  def boundary(state, id, after_prefix) do
    if Enum.any?(
         Map.get(state, "cards", []),
         &(&1["id"] == id and Map.get(&1, "after", 0) == after_prefix)
       ),
       do: :ok,
       else: {:error, :conflict}
  end

  def edit(state, id, through, text) when is_binary(text) do
    with {:ok, card, prefix, rest} <- split(state, id, through) do
      segment = %{
        "through" => List.last(prefix)["through"],
        "text" => text,
        "speaker" => List.first(prefix)["speaker"]
      }

      {:ok, put_card(state, Map.put(card, "segments", [segment | rest]))}
    end
  end

  def take(state, id, through) do
    with {:ok, card, prefix, rest} <- split(state, id, through) do
      next =
        if rest == [],
          do: drop_card(state, id),
          else:
            put_card(
              state,
              card |> Map.put("segments", label_first(rest)) |> Map.put("after", through)
            )

      {:ok, next, Enum.map_join(prefix, & &1["text"])}
    end
  end

  def remember(state, message) do
    attempt = %{
      "fiber_id" => message.fiber_id,
      "origin" => message.origin,
      "text" => message.text,
      "status" => "pending",
      "at" => timestamp()
    }

    Map.update(
      state,
      "attempts",
      %{message.message_id => attempt},
      &Map.put(&1, message.message_id, attempt)
    )
  end

  def finish(state, id, outcome) do
    attempts = Map.get(state, "attempts", %{})

    case attempts[id] do
      nil ->
        state

      _ when outcome == :delivered ->
        Map.put(state, "attempts", Map.delete(attempts, id))

      attempt ->
        Map.put(
          state,
          "attempts",
          Map.put(
            attempts,
            id,
            Map.merge(attempt, %{"status" => Atom.to_string(outcome), "at" => timestamp()})
          )
        )
    end
  end

  def recovery(state) do
    state
    |> Map.get("attempts", %{})
    |> Map.values()
    |> Enum.filter(&(&1["status"] in ["failed", "unconfirmed"]))
    |> Enum.max_by(& &1["at"], fn -> nil end)
    |> case do
      nil ->
        nil

      attempt ->
        Map.take(attempt, ~w(fiber_id at status))
        |> Map.put(
          "detail",
          "Your edited voice draft is retained. Copy it into the composer to send it again:\n\n" <>
            attempt["text"]
        )
    end
  end

  defp label_first([first | rest]) do
    text = first["text"]

    first =
      if String.starts_with?(text, " "),
        do: Map.put(first, "text", first["speaker"] <> ": " <> String.trim_leading(text)),
        else: first

    [first | rest]
  end

  defp timestamp, do: DateTime.to_iso8601(DateTime.utc_now())

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
      |> Map.put("after", Map.get(card, "after", 0))
      |> Map.put("text", Enum.map_join(card["segments"], & &1["text"]))

  defp same_target?(a, b), do: a["fiber_id"] == b["fiber_id"] and a["origin"] == b["origin"]

  defp put_card(state, card),
    do:
      Map.update!(state, "cards", &(Enum.reject(&1, fn c -> c["id"] == card["id"] end) ++ [card]))

  defp drop_card(state, id),
    do: Map.update!(state, "cards", &Enum.reject(&1, fn c -> c["id"] == id end))
end
