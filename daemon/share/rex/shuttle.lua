-- shuttle: native Rex palette for Shuttle threads, channels, Desk, and
-- focused-thread lifecycle actions (requires Rex API revision 17+).
--
-- Install with `shuttle rex-setup`, or add to ~/.config/rex/init.lua:
--
--   require("shuttle").setup{}
--
-- Options, with their defaults:
--
--   require("shuttle").setup{
--     key = "cmd+p",                  -- shortcut; false for no binding (Rex's built-in palette is shift+cmd+p)
--     url = "http://127.0.0.1:4000",  -- local Shuttle daemon base URL
--     curl = "curl",                  -- curl executable
--     timeout = 5,                    -- HTTP timeout in seconds
--   }

local M = {}

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

function M.setup(opts)
  opts = opts or {}
  for k, v in pairs(defaults) do
    if opts[k] == nil then opts[k] = v end
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
    local view = rex.session.view{ session_id = ctx.session_id }
    if type(view) == "table" and type(view.active_window_id) == "string" then
      return view.active_window_id
    end
    return nil
  end

  local function dispatch_item(item)
    if item.kind == "desk" then
      http_post_json("/api/v1/go", { target = "desk" })
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
        http_post_json("/api/v1/lifecycle", {
          action = "rest",
          fiber = item.fiber_id,
          origin = item.origin,
        })
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

  rex.action{
    name = "shuttle_palette",
    title = "Shuttle: Jump & Actions…",
    description = "Jump to Desk, a channel, or a thread, or run a lifecycle action on the focused thread.",
    category = "Shuttle",
    keywords = "shuttle palette jump thread channel desk temper review rest discard session",
    run = function(ctx)
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

      local pick_items = {}
      local by_id = {}
      for _, item in ipairs(data.items) do
        if type(item) == "table" and type(item.id) == "string" and item.id ~= "" then
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

      local choice, err = rex.ui.pick{
        title = "Shuttle",
        placeholder = "Jump to a thread, channel, or action…",
        items = pick_items,
      }
      if choice == nil then
        if err ~= nil then error("shuttle: " .. tostring(err), 0) end
        return
      end

      local selected = by_id[choice]
      if selected ~= nil then
        dispatch_item(selected)
      end
    end,
  }

  if opts.key then
    rex.bind(opts.key, "shuttle_palette")
  end
end

return M
