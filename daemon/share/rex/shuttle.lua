-- shuttle: native Rex palette, direct hotkeys, and multi-step flows for
-- Shuttle threads, channels, Desk, Fleet Map, and focused-thread lifecycle
-- actions (requires Rex API revision 17+).
--
-- Install with `shuttle rex-setup`, or add to ~/.config/rex/init.lua:
--
--   require("shuttle").setup{}
--
-- Options, with their defaults:
--
--   require("shuttle").setup{
--     key = "cmd+p",                  -- palette shortcut; false for no binding (Rex's built-in palette is shift+cmd+p)
--     keys = {                        -- direct hotkeys (set keys = false or any entry = false to disable)
--       desk = "alt+cmd+1",
--       map = "alt+cmd+2",
--       temper = "alt+cmd+t",
--       review = "alt+cmd+a",
--       rest = "alt+cmd+s",
--       discard = "alt+cmd+x",
--       new_session = "alt+cmd+n",
--     },
--     url = "http://127.0.0.1:4000",  -- local Shuttle daemon base URL
--     curl = "curl",                  -- curl executable
--     timeout = 5,                    -- HTTP timeout in seconds
--   }

local M = {}

local default_keys = {
  desk = "alt+cmd+1",
  map = "alt+cmd+2",
  temper = "alt+cmd+t",
  review = "alt+cmd+a",
  rest = "alt+cmd+s",
  discard = "alt+cmd+x",
  new_session = "alt+cmd+n",
}

local defaults = {
  key = "cmd+p",
  url = "http://127.0.0.1:4000",
  curl = "curl",
  timeout = 5,
}

local function url_encode(value)
  return (tostring(value):gsub("([^%w%-_%.~])", function(c)
    return string.format("%%%02X", string.byte(c))
  end))
end

local function build_query(params)
  local parts = {}
  for _, pair in ipairs(params) do
    local k, v = pair[1], pair[2]
    if type(v) == "string" and v ~= "" then
      parts[#parts + 1] = url_encode(k) .. "=" .. url_encode(v)
    end
  end
  if #parts == 0 then return "" end
  return "?" .. table.concat(parts, "&")
end

local function strip_trailing_slash(url)
  return (tostring(url):gsub("/+$", ""))
end

local function non_empty_string(v)
  return type(v) == "string" and v ~= "" and v or nil
end

local function trim(s)
  return (tostring(s):gsub("^%s+", ""):gsub("%s+$", ""))
end

-- Calendar helpers anchored at local noon so DST shifts never skip a day.
local function local_noon(offset_days)
  local now = os.date("*t")
  return os.time({
    year = now.year,
    month = now.month,
    day = now.day + (offset_days or 0),
    hour = 12,
    min = 0,
    sec = 0,
  })
end

local function iso_day(ts)
  return os.date("%Y-%m-%d", ts)
end

local function pretty_day(ts)
  return (os.date("%a, %b %d", ts):gsub(" 0(%d)", " %1"))
end

local function days_in_month(year, month)
  return os.date("*t", os.time({ year = year, month = month + 1, day = 0, hour = 12 })).day
end

local function add_months_clamped(year, month, day, delta)
  local total = (year * 12 + (month - 1)) + delta
  local y = math.floor(total / 12)
  local m = (total % 12) + 1
  local max_d = days_in_month(y, m)
  local d = math.min(day, max_d)
  return os.time({ year = y, month = m, day = d, hour = 12 })
end

local function pick_month_and_day(label)
  local today = os.date("*t", local_noon(0))
  local months = {}
  local month_meta = {}
  for i = 0, 11 do
    local total = (today.year * 12 + (today.month - 1)) + i
    local y = math.floor(total / 12)
    local m = (total % 12) + 1
    local first_ts = os.time({ year = y, month = m, day = 1, hour = 12 })
    local id = string.format("%04d-%02d", y, m)
    month_meta[id] = { year = y, month = m }
    months[#months + 1] = {
      id = id,
      title = os.date("%B %Y", first_ts),
      detail = id,
      icon = "clock",
    }
  end

  local month_id, err = rex.ui.pick({
    title = "Rest " .. label .. " — choose month",
    placeholder = "Filter month…",
    items = months,
  })
  if month_id == nil then
    if err ~= nil and err ~= "cancelled" then error("shuttle: " .. tostring(err), 0) end
    return nil
  end

  local meta = month_meta[month_id]
  if not meta then return nil end

  local start_day = 1
  if meta.year == today.year and meta.month == today.month then
    start_day = today.day + 1
  end
  local last_day = days_in_month(meta.year, meta.month)
  local today_noon = local_noon(0)
  local day_items = {}
  for d = start_day, last_day do
    local ts = os.time({ year = meta.year, month = meta.month, day = d, hour = 12 })
    local diff = math.floor((ts - today_noon) / 86400 + 0.5)
    local sub = nil
    if diff == 1 then
      sub = "Tomorrow"
    elseif diff > 1 and diff <= 60 then
      sub = "In " .. tostring(diff) .. " days"
    end
    local iso = iso_day(ts)
    day_items[#day_items + 1] = {
      id = iso,
      title = pretty_day(ts),
      subtitle = sub,
      detail = iso,
      icon = "clock",
    }
  end

  if #day_items == 0 then
    return nil
  end

  local day_id, day_err = rex.ui.pick({
    title = "Rest " .. label .. " — choose day",
    placeholder = "Filter day (e.g. Mon, 15)…",
    items = day_items,
  })
  if day_id == nil then
    if day_err ~= nil and day_err ~= "cancelled" then error("shuttle: " .. tostring(day_err), 0) end
    return nil
  end
  return day_id
end

local function pick_rest_until(label)
  local today = os.date("*t", local_noon(0))
  local items = {}
  local seen = {}

  local function add_date_preset(title, ts)
    local iso = iso_day(ts)
    if seen[iso] then return end
    seen[iso] = true
    items[#items + 1] = {
      id = iso,
      title = title,
      subtitle = pretty_day(ts),
      detail = iso,
      icon = "clock",
    }
  end

  add_date_preset("Tomorrow", local_noon(1))
  add_date_preset("In 2 days", local_noon(2))
  add_date_preset("In 3 days", local_noon(3))

  -- Next Monday (Lua wday: 1 = Sun, 2 = Mon, ..., 7 = Sat).
  local days_to_mon = (9 - today.wday) % 7
  if days_to_mon == 0 then days_to_mon = 7 end
  add_date_preset("Next Monday", local_noon(days_to_mon))

  add_date_preset("In 1 week", local_noon(7))
  add_date_preset("In 2 weeks", local_noon(14))
  add_date_preset("In 1 month", add_months_clamped(today.year, today.month, today.day, 1))

  items[#items + 1] = {
    id = "undated",
    title = "Undated",
    subtitle = "Rest without a return date",
    detail = "indefinite",
    icon = "document",
  }
  items[#items + 1] = {
    id = "pick_date",
    title = "Choose date…",
    subtitle = "Pick month, then day",
    detail = "calendar",
    icon = "clock",
  }
  items[#items + 1] = {
    id = "until_text",
    title = "Until a fiber or note…",
    subtitle = "Type a fiber slug or blocker note",
    detail = "text",
    icon = "tag",
  }

  local choice, err = rex.ui.pick({
    title = "Rest " .. label .. " until…",
    placeholder = "Pick a date, or type YYYY-MM-DD / fiber / note…",
    items = items,
    allow_other = true,
  })
  if choice == nil then
    if err ~= nil and err ~= "cancelled" then error("shuttle: " .. tostring(err), 0) end
    return nil
  end

  if type(choice) == "table" then
    return trim(choice.text or "")
  end
  if choice == "undated" then
    return ""
  end
  if choice == "pick_date" then
    return pick_month_and_day(label)
  end
  if choice == "until_text" then
    local text, in_err = rex.ui.input({
      title = "Rest " .. label .. " until…",
      placeholder = "YYYY-MM-DD, fiber slug, or blocker note",
      confirm = "Rest",
    })
    if text == nil then
      if in_err ~= nil and in_err ~= "cancelled" then error("shuttle: " .. tostring(in_err), 0) end
      return nil
    end
    return trim(text)
  end

  return choice
end

function M.setup(opts)
  opts = opts or {}
  for k, v in pairs(defaults) do
    if opts[k] == nil then opts[k] = v end
  end

  local keys = {}
  if opts.keys ~= false then
    for k, v in pairs(default_keys) do keys[k] = v end
    if type(opts.keys) == "table" then
      for k, v in pairs(opts.keys) do keys[k] = v end
    end
  end

  local base_url = strip_trailing_slash(opts.url)
  local curl = tostring(opts.curl)
  local timeout = tonumber(opts.timeout) or defaults.timeout

  local function http_get(path)
    local res, err = rex.exec(
      { curl, "-fsS", "--max-time", tostring(timeout), base_url .. path },
      { timeout = timeout + 2 }
    )
    if res == nil or not res.ok then
      local detail = (res and non_empty_string(res.stderr)) or tostring(err or "request failed")
      error("shuttle: GET " .. path .. " failed: " .. detail, 0)
    end
    return res.stdout or ""
  end

  local function http_post_json(path, payload)
    local body = rex.json.encode(payload)
    local res, err = rex.exec(
      {
        curl, "-fsS", "--max-time", tostring(timeout),
        "-X", "POST",
        "-H", "Content-Type: application/json",
        "-d", body,
        base_url .. path,
      },
      { timeout = timeout + 2 }
    )
    if res == nil or not res.ok then
      local detail = (res and (non_empty_string(res.stderr) or non_empty_string(res.stdout)))
        or tostring(err or "request failed")
      error("shuttle: POST " .. path .. " failed: " .. detail, 0)
    end
    return res.stdout or ""
  end

  local function active_window_id(ctx)
    if type(ctx.session_id) ~= "string" or ctx.session_id == "" then return nil end
    local view = rex.session.view({ session_id = ctx.session_id })
    if type(view) == "table" and type(view.active_window_id) == "string" then
      return view.active_window_id
    end
    return nil
  end

  local function fetch_palette(ctx)
    local query = build_query({
      { "session_id", ctx.session_id },
      { "window_id", active_window_id(ctx) },
      { "block_id", ctx.block_id },
    })
    local raw = http_get("/api/v1/palette" .. query)
    local data = rex.json.decode(raw)
    if type(data) ~= "table" or type(data.items) ~= "table" then
      error("shuttle: unexpected /api/v1/palette response", 0)
    end
    return data
  end

  local function dispatch_item(item, extra)
    if item.kind == "desk" then
      http_post_json("/api/v1/go", { target = "desk" })
      return
    end

    if item.kind == "map" then
      http_post_json("/api/v1/go", { target = "map" })
      return
    end

    if item.kind == "thread" or item.kind == "channel" then
      http_post_json("/api/v1/go", {
        fiber_id = item.fiber_id,
        origin = item.origin,
      })
      return
    end

    if item.kind == "action" then
      local act = item.action
      if act == "temper" then
        http_post_json("/api/v1/transition", {
          fiber_id = item.fiber_id,
          target = "tempered",
          origin = item.origin,
        })
      elseif act == "review" then
        http_post_json("/api/v1/transition", {
          fiber_id = item.fiber_id,
          target = "awaitingReview",
          origin = item.origin,
        })
      elseif act == "discard" then
        http_post_json("/api/v1/transition", {
          fiber_id = item.fiber_id,
          target = "composted",
          origin = item.origin,
        })
      elseif act == "rest" then
        local payload = {
          action = "rest",
          fiber = item.fiber_id,
          origin = item.origin,
        }
        if not item.standing then
          local until_val = extra and extra.until_val
          if until_val == nil then
            local label = non_empty_string(item.focused_title) or non_empty_string(item.subtitle) or "thread"
            until_val = pick_rest_until(label)
            if until_val == nil then return end
          end
          payload["until"] = until_val
        end
        http_post_json("/api/v1/lifecycle", payload)
      elseif act == "new_session" then
        http_post_json("/api/v1/dispatch", {
          fiber_id = item.fiber_id,
          origin = item.origin,
          force = true,
          resume_mode = "fresh",
        })
      end
    end
  end

  local function run_focused_action(ctx, action_name, extra)
    local data = fetch_palette(ctx)
    for _, item in ipairs(data.items) do
      if type(item) == "table" and item.kind == "action" and item.action == action_name then
        if type(data.focused) == "table" then
          item.focused_title = non_empty_string(data.focused.title)
        end
        dispatch_item(item, extra)
        return
      end
    end
  end

  rex.action({
    name = "shuttle_palette",
    title = "Shuttle: Jump & Actions…",
    description = "Jump to Desk, Fleet Map, a channel, or a thread, or run a lifecycle action on the focused thread.",
    category = "Shuttle",
    keywords = "shuttle palette jump thread channel desk map temper review rest discard session",
    run = function(ctx)
      local data = fetch_palette(ctx)

      local pick_items = {}
      local by_id = {}
      for _, item in ipairs(data.items) do
        if type(item) == "table" and type(item.id) == "string" and item.id ~= "" then
          if type(data.focused) == "table" then
            item.focused_title = non_empty_string(data.focused.title)
          end
          by_id[item.id] = item
          pick_items[#pick_items + 1] = {
            id = item.id,
            title = non_empty_string(item.title) or item.id,
            subtitle = non_empty_string(item.subtitle),
            detail = non_empty_string(item.detail),
            icon = non_empty_string(item.icon),
          }
        end
      end

      if #pick_items == 0 then return end

      local choice, err = rex.ui.pick({
        title = "Shuttle",
        placeholder = "Jump to a thread, channel, or action…",
        items = pick_items,
      })
      if choice == nil then
        if err ~= nil and err ~= "cancelled" then error("shuttle: " .. tostring(err), 0) end
        return
      end

      local selected = by_id[choice]
      if selected ~= nil then
        dispatch_item(selected)
      end
    end,
  })

  rex.action({
    name = "shuttle_desk",
    title = "Shuttle: Go to Desk",
    description = "Jump to the Shuttle Desk tab.",
    category = "Shuttle",
    keywords = "shuttle desk board",
    run = function()
      http_post_json("/api/v1/go", { target = "desk" })
    end,
  })

  rex.action({
    name = "shuttle_map",
    title = "Shuttle: Go to Fleet Map",
    description = "Jump to the Shuttle Fleet Map tab.",
    category = "Shuttle",
    keywords = "shuttle map fleet archipelago",
    run = function()
      http_post_json("/api/v1/go", { target = "map" })
    end,
  })

  rex.action({
    name = "shuttle_temper",
    title = "Shuttle: Temper Focused Thread",
    description = "Temper the currently focused Shuttle thread.",
    category = "Shuttle",
    keywords = "shuttle temper done complete",
    run = function(ctx)
      run_focused_action(ctx, "temper")
    end,
  })

  rex.action({
    name = "shuttle_review",
    title = "Shuttle: Send Focused Thread to Review",
    description = "Move the currently focused Shuttle thread to Awaiting review.",
    category = "Shuttle",
    keywords = "shuttle review close awaiting",
    run = function(ctx)
      run_focused_action(ctx, "review")
    end,
  })

  rex.action({
    name = "shuttle_rest",
    title = "Shuttle: Rest Focused Thread…",
    description = "Rest the currently focused Shuttle thread, with a return date or blocker.",
    category = "Shuttle",
    keywords = "shuttle rest snooze stash date calendar until",
    args = { until_date = "string?" },
    run = function(ctx, args)
      local extra = nil
      if type(args) == "table" and type(args.until_date) == "string" then
        extra = { until_val = trim(args.until_date) }
      end
      run_focused_action(ctx, "rest", extra)
    end,
  })

  rex.action({
    name = "shuttle_discard",
    title = "Shuttle: Discard Focused Thread",
    description = "Discard the currently focused Shuttle thread.",
    category = "Shuttle",
    keywords = "shuttle discard compost retire",
    run = function(ctx)
      run_focused_action(ctx, "discard")
    end,
  })

  rex.action({
    name = "shuttle_new_session",
    title = "Shuttle: New Session on Focused Thread",
    description = "Start a fresh worker session on the currently focused Shuttle thread.",
    category = "Shuttle",
    keywords = "shuttle new session fresh worker",
    run = function(ctx)
      run_focused_action(ctx, "new_session")
    end,
  })

  if opts.key then
    rex.bind(opts.key, "shuttle_palette")
  end

  local action_bindings = {
    { keys.desk, "shuttle_desk" },
    { keys.map, "shuttle_map" },
    { keys.temper, "shuttle_temper" },
    { keys.review, "shuttle_review" },
    { keys.rest, "shuttle_rest" },
    { keys.discard, "shuttle_discard" },
    { keys.new_session, "shuttle_new_session" },
  }
  for _, pair in ipairs(action_bindings) do
    if non_empty_string(pair[1]) then
      rex.bind(pair[1], pair[2])
    end
  end
end

return M
