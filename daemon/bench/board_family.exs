# Run with: mix run --no-start bench/board_family.exs
entries =
  for n <- 0..799 do
    id = if n == 0, do: "work/hub", else: "work/hub/thread-#{n}"

    %{
      felt_store: "/store",
      fiber: %{"id" => id, "slug" => id, "uid" => "uid-#{n}", "name" => id, "shuttle" => %{}}
    }
  end

records =
  for n <- 1..2_000 do
    uid = "uid-#{rem(n, 799) + 1}"

    %{
      "id" => "record-#{n}",
      "timestamp" => n,
      "kind" => "message",
      "fiber" => uid,
      "by" => %{"fiber" => uid},
      "to" => %{"fiber" => uid}
    }
  end

for _ <- 1..3 do
  {us, result} =
    :timer.tc(fn ->
      Shuttle.BoardFamily.compose(entries, records, %{}, "host", %{"fiber" => "uid-0"})
    end)

  IO.puts("#{Float.round(us / 1_000, 2)} ms (#{length(result.records)} records)")
end
