
--Start listening for the Alchemy65 connection

local socket = require("socket.core")
local PORT = 4064
local FAST = 0.0001
local server = nil
local connection = nil
local isPaused = false
local breakpoints = {}

function tablelength(T)
  local count = 0
  for _ in pairs(T) do count = count + 1 end
  return count
end

function split(s, delimiter)
  local result = {};
  for match in (s..delimiter):gmatch("(.-)"..delimiter) do
      table.insert(result, match);
  end
  return result;
end

function log(c)
  emu.displayMessage("Alchemy65 Debug Host", c)
end

function onEndFrame()
  isPaused = false
  alchemy65()
end

function onWhilePaused()
  isPaused = true
  alchemy65()
end

function memcallback(address)
        connection:send("isPaused true\n")
        log("breakpoint! " .. tostring(address))
        emu.breakExecution()
        return
end
function xmemcallback(address)
  --check if pc / prg is in the callback table
  local prg = emu.getPrgRomOffset(address)
  if prg ~= -1 then
    if breakpoints["prg-" .. tostring(prg)] ~= nil then
        connection:send("isPaused true\n")
        log("prg breakpoint!")
        emu.breakExecution()
    end
    return -- we know it's in prg space and we didn't find it so don't check cpu
  end
  if breakpoints["cpu-" .. tostring(address)] ~= nil then
        connection:send("isPaused true\n")
        log("cpu breakpoint!")
        emu.breakExecution()
    return
  end
  log("memcallback " .. tostring(address))
  return
end

function clearbreakpoints()
  for k,ab in pairs(breakpoints) do
    local address = ab.a
    log("clearing " .. tostring(k) .. " " .. tostring(address))
    emu.removeMemoryCallback(ab.b,emu.memCallbackType.cpuExec,ab.a)
    breakpoints[k] = nil
  end
end

function setbreakpoint(cpuaddress, prgaddress)
  local ab = {}
  ab.a = cpuaddress
  ab.b = emu.addMemoryCallback(memcallback, emu.memCallbackType.cpuExec, cpuaddress)
  if prgaddress == -1 then
    breakpoints["cpu-" .. tostring(cpuaddress)] = ab
  else
    breakpoints["prg-" .. tostring(prgaddress)] = ab
  end
  log("sb " .. tostring(ab.b) .. " " .. tostring(cpuaddress))
  return
end

function alchemy65()
  if connection == nil then
    local client, err = server:accept()
    if client ~= nil then
      connection = client
      connection:settimeout(FAST)
      log("Client connected")
      if isPaused then
        connection:send("isPaused true\n")
      else
        connection:send("isPaused false\n")
      end
      connection:send("configurationComplete\n")
    elseif err ~= "timeout" then
      log("accept_err:" .. err)
    end
  end
  if connection ~= nil then
    -- receive any messages?
    local data, err, partial = connection:receive()
    if partial ~= nil and partial ~= "" then
      log("partial: " .. partial)
    end
    
    if err == "timeout" then
      return -- this is fine
    end
    if err == "closed" then
      connection = nil
      log("lost connection")
      return
    end
    if err ~= nil then
      log("err: " .. err)
      return
    end

    if data == nil then
      return
    end 
    local args = split(data, " ")
    local command = args[1]
    --log(command)

    if command == "pause" then
      if isPaused == false then
        emu.breakExecution()
        connection:send("isPaused true\n")
        log("pause")
      else
        log("already paused")
      end
      
      return
    end
    if command == "resume" then
      if isPaused == true then
        emu.resume()
        connection:send("isPaused false\n")
        log("resume")
      else
        log("already resumed")
      end
      return
    end
    if command == "reset" then
      emu.reset()
      log("reset")
      return
    end
    if command == "next" then
      emu.execute(1, emu.executeCountType.cpuInstructions)
      connection:send("stepped\n")
      log("step")
      return
    end
    if command == "getcpuvars" then
      local state = emu.getState()
      local pc_prg = emu.getPrgRomOffset(state.cpu.pc)
      connection:send("cpuvars " .. tostring(state.cpu.status) .. " " .. tostring(state.cpu.a) .. " " .. tostring(state.cpu.x) .. " " .. tostring(state.cpu.y) .. " " .. tostring(state.cpu.pc) .. " " .. tostring(state.cpu.sp) .. " " .. tostring(pc_prg) .. "\n")
      --log("cpuvars")
      return
    end
    if command == "getlabel" then
      local label = args[2]
      local label_address = emu.getLabelAddress(label)
      local label_address_prg = emu.getPrgRomOffset(label_address)
      local label_value = emu.read(label_address, emu.memType.cpuDebug)
      connection:send("label-" .. label .. " " .. tostring(label_address) .. " " .. tostring(label_address_prg) .. " " .. tostring(label_value) .. "\n")
      --log("getlabel " .. label)
      return
    end
    
    if command == "clearbreakpoints" then
      clearbreakpoints()
      log("clearbreakpoints " .. tablelength(breakpoints))
      return
    end
    
    if command == "setbreakpoint" then
      local cpuaddress = tonumber(args[2])
      local prgaddress = tonumber(args[3])
      setbreakpoint(cpuaddress, prgaddress)
      log("setbreakpoint " .. tablelength(breakpoints))
      return
    end
    
    if data ~= nil then
      log("data: " .. data)
    end
  end
end


log("init...")
server = socket.tcp();
server:settimeout(2)

server:bind("127.0.0.1", PORT)
local listen_status, listen_err = server:listen(10)
if listen_err ~= nil then
  log("Listen Error:" .. listen_err)
else
  server:settimeout(FAST) -- make accepts fast

  log("listening on " .. PORT)
  emu.addEventCallback(onEndFrame, emu.eventType.endFrame)
  emu.addEventCallback(onWhilePaused, emu.eventType.whilePaused)
  -- while true do
  --   alchemy65()
  -- end
end

