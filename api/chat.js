"use strict";

const { EventEmitter } = require("events");

const MESSAGE_KEY = "bc:msgs";
const SEQUENCE_KEY = "bc:seq";
const ONLINE_KEY = "bc:online";
const IMAGE_PREFIX = "bc:img:";
const RATE_PREFIX = "bc:rl:";

const MESSAGE_TTL_SECONDS = 86400;
const ONLINE_TTL_SECONDS = 600;
const ONLINE_WINDOW_MS = 90000;
const MAX_STORED_MESSAGES = 80;
const HISTORY_LIMIT = 40;
const FETCH_LIMIT = 100;
const MAX_TEXT_LENGTH = 2000;
const MAX_IMAGE_BYTES = 1000000;
const MAX_BODY_BYTES = 2000000;
const MAX_POSTS_PER_WINDOW = 12;
const RATE_WINDOW_SECONDS = 60;
const STORAGE_TIMEOUT_MS = 5000;
const STREAM_MAX_MS = 50000;
const HEARTBEAT_MS = 15000;
const POLL_MIN_MS = 3000;
const POLL_MAX_MS = 9000;

const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.-]{1,23}$/;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

const hub = new EventEmitter();
hub.setMaxListeners(0);

const hubState = {
  streams: new Set(),
  fetchedSeq: 0,
  timer: null,
  intervalMs: POLL_MIN_MS,
  idleRounds: 0,
  polling: false
};

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function getStorageConfig() {
  const restUrl = process.env.KV_REST_API_URL;
  const restToken = process.env.KV_REST_API_TOKEN;
  if (restUrl && restToken) {
    return { url: restUrl.replace(/\/+$/, ""), token: restToken };
  }
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    try {
      const parsed = new URL(redisUrl);
      const token = decodeURIComponent(parsed.password || "");
      if (token) {
        return { url: `${parsed.protocol}//${parsed.host}`, token };
      }
    } catch {
      return null;
    }
  }
  return null;
}

function storageError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function storageRequest(path, body) {
  const config = getStorageConfig();
  if (!config) {
    throw storageError("storage-not-configured", "storage-not-configured");
  }
  let response;
  try {
    response = await fetch(`${config.url}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS)
    });
  } catch (error) {
    throw storageError(`storage-unreachable: ${error && error.message}`, "storage-unreachable");
  }
  if (!response.ok) {
    throw storageError(`storage-http-${response.status}`, "storage-http");
  }
  return response.json();
}

async function redisCommand(args) {
  const payload = await storageRequest("", args);
  if (payload && payload.error) {
    throw storageError(String(payload.error), "storage-error");
  }
  return payload ? payload.result : null;
}

async function redisPipeline(commands) {
  const payload = await storageRequest("/pipeline", commands);
  if (!Array.isArray(payload)) {
    throw storageError("storage-bad-pipeline", "storage-error");
  }
  return payload.map((entry) => {
    if (entry && entry.error) {
      return { error: String(entry.error) };
    }
    return { result: entry ? entry.result : null };
  });
}

function unwrap(entry) {
  if (entry && entry.error) {
    throw storageError(entry.error, "storage-error");
  }
  return entry ? entry.result : null;
}

function normalizeMessage(parsed) {
  return {
    id: Number(parsed.i) || 0,
    username: typeof parsed.u === "string" ? parsed.u : "Guest",
    text: typeof parsed.t === "string" ? parsed.t : "",
    imageId: Number.isFinite(Number(parsed.m)) && Number(parsed.m) > 0 ? Number(parsed.m) : null,
    createdAt: Number(parsed.s) || 0
  };
}

function parseMessages(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  const messages = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      continue;
    }
    try {
      const parsed = JSON.parse(entry);
      if (parsed && Number(parsed.i) > 0) {
        messages.push(normalizeMessage(parsed));
      }
    } catch {
      continue;
    }
  }
  return messages;
}

function readCommand(since) {
  if (since > 0) {
    return ["ZRANGEBYSCORE", MESSAGE_KEY, `(${since}`, "+inf", "LIMIT", "0", String(FETCH_LIMIT)];
  }
  return ["ZRANGE", MESSAGE_KEY, String(-HISTORY_LIMIT), "-1"];
}

async function pollStorage(clientIds, sinceOverride) {
  const now = Date.now();
  const since = typeof sinceOverride === "number" ? sinceOverride : hubState.fetchedSeq;
  const commands = [readCommand(since)];
  if (clientIds.length > 0) {
    commands.push(["ZADD", ONLINE_KEY, String(now)].concat(clientIds));
  }
  commands.push(["ZREMRANGEBYSCORE", ONLINE_KEY, "-inf", String(now - ONLINE_WINDOW_MS)]);
  commands.push(["ZCARD", ONLINE_KEY]);

  const results = await redisPipeline(commands);
  const messages = parseMessages(unwrap(results[0]));
  const online = Number(unwrap(results[results.length - 1])) || 0;
  return { messages, online };
}

function writeRaw(res, text) {
  try {
    if (!res.writableEnded) {
      res.write(text);
    }
  } catch {
    return;
  }
}

function writeEvent(res, event, data) {
  writeRaw(res, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function dispatch(messages) {
  if (!messages.length) {
    return;
  }
  for (const stream of Array.from(hubState.streams)) {
    const pending = messages.filter((message) => message.id > stream.lastSeq);
    if (!pending.length) {
      continue;
    }
    stream.lastSeq = pending[pending.length - 1].id;
    writeEvent(stream.res, "message", { messages: pending });
  }
}

function broadcastPresence(online) {
  for (const stream of Array.from(hubState.streams)) {
    writeEvent(stream.res, "presence", { online });
  }
}

function scheduleTick() {
  if (hubState.timer) {
    clearTimeout(hubState.timer);
  }
  hubState.timer = setTimeout(runTick, hubState.intervalMs);
  if (typeof hubState.timer.unref === "function") {
    hubState.timer.unref();
  }
}

function stopTicker() {
  if (hubState.timer) {
    clearTimeout(hubState.timer);
    hubState.timer = null;
  }
}

async function runTick() {
  hubState.timer = null;
  if (hubState.streams.size === 0) {
    return;
  }
  if (!hubState.polling) {
    hubState.polling = true;
    try {
      const clientIds = [];
      for (const stream of hubState.streams) {
        if (stream.clientId) {
          clientIds.push(stream.clientId);
        }
      }
      const { messages, online } = await pollStorage(clientIds);
      if (messages.length) {
        for (const message of messages) {
          if (message.id > hubState.fetchedSeq) {
            hubState.fetchedSeq = message.id;
          }
        }
        hubState.idleRounds = 0;
        hubState.intervalMs = POLL_MIN_MS;
        dispatch(messages);
      } else {
        hubState.idleRounds += 1;
        if (hubState.idleRounds >= 2 && hubState.intervalMs < POLL_MAX_MS) {
          hubState.intervalMs = Math.min(POLL_MAX_MS, Math.round(hubState.intervalMs * 1.5));
        }
      }
      broadcastPresence(online);
    } catch (error) {
      hubState.intervalMs = POLL_MAX_MS;
      console.error("BOOT Chat poll failed", { code: error && error.code, message: error && error.message });
    } finally {
      hubState.polling = false;
    }
  }
  if (hubState.streams.size > 0) {
    scheduleTick();
  }
}

function sanitizeClientId(value) {
  const candidate = typeof value === "string" ? value.trim() : "";
  return CLIENT_ID_PATTERN.test(candidate) ? candidate : "";
}

function parseSeq(value) {
  const parsed = Number.parseInt(typeof value === "string" ? value : "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) {
    return true;
  }
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  if (!host) {
    return false;
  }
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function getBody(req) {
  if (req.body && typeof req.body === "object") {
    return req.body;
  }
  if (typeof req.body === "string") {
    if (!req.body) {
      return {};
    }
    try {
      return JSON.parse(req.body);
    } catch {
      throw new Error("Invalid JSON body");
    }
  }
  if (Buffer.isBuffer(req.body)) {
    try {
      return JSON.parse(req.body.toString("utf8"));
    } catch {
      throw new Error("Invalid JSON body");
    }
  }
  return {};
}

function getEstimatedBodySize(req) {
  const contentLength = Number.parseInt(req.headers["content-length"] || "0", 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return contentLength;
  }
  try {
    if (typeof req.body === "string") {
      return Buffer.byteLength(req.body, "utf8");
    }
    if (Buffer.isBuffer(req.body)) {
      return req.body.length;
    }
  } catch {
    return MAX_BODY_BYTES + 1;
  }
  return contentLength > 0 ? contentLength : 0;
}

function normalizeUsername(value) {
  if (typeof value !== "string") {
    return "";
  }
  const name = value.trim().replace(/\s+/g, " ");
  return USERNAME_PATTERN.test(name) ? name : "";
}

function detectImageType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return "";
}

function validateImage(image) {
  if (!image || typeof image !== "object") {
    return null;
  }
  const mime = typeof image.mime === "string" ? image.mime.toLowerCase() : "";
  const base64 = typeof image.base64 === "string" ? image.base64.replace(/\s+/g, "") : "";
  if (!ALLOWED_IMAGE_TYPES.has(mime) || !base64) {
    throw new Error("Pictures must be JPG, PNG or WebP");
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new Error("That picture could not be read");
  }
  let bytes;
  try {
    bytes = Buffer.from(base64, "base64");
  } catch {
    throw new Error("That picture could not be read");
  }
  if (bytes.length === 0) {
    throw new Error("That picture could not be read");
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error("Pictures must be 1 MB or less");
  }
  if (detectImageType(bytes) !== mime) {
    throw new Error("That file is not a valid JPG, PNG or WebP picture");
  }
  return { mime, base64, bytes };
}

async function handleStream(req, res, url) {
  const clientId = sanitizeClientId(url.searchParams.get("client"));
  const since = parseSeq(url.searchParams.get("since"));

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }
  writeRaw(res, "retry: 2500\n\n");

  const stream = { res, clientId, lastSeq: since, closed: false, timer: null, heartbeat: null };

  const finish = () => {
    if (stream.closed) {
      return;
    }
    stream.closed = true;
    hubState.streams.delete(stream);
    if (stream.timer) {
      clearTimeout(stream.timer);
    }
    if (stream.heartbeat) {
      clearInterval(stream.heartbeat);
    }
    if (hubState.streams.size === 0) {
      stopTicker();
    }
    try {
      res.end();
    } catch {
      return;
    }
  };

  stream.timer = setTimeout(finish, STREAM_MAX_MS);
  if (typeof stream.timer.unref === "function") {
    stream.timer.unref();
  }
  stream.heartbeat = setInterval(() => writeRaw(res, ": ping\n\n"), HEARTBEAT_MS);
  if (typeof stream.heartbeat.unref === "function") {
    stream.heartbeat.unref();
  }

  req.on("close", finish);
  req.on("aborted", finish);
  res.on("close", finish);

  hubState.streams.add(stream);
  scheduleTick();

  try {
    const { messages, online } = await pollStorage(clientId ? [clientId] : [], stream.lastSeq);
    for (const message of messages) {
      if (message.id > hubState.fetchedSeq) {
        hubState.fetchedSeq = message.id;
      }
    }
    const pending = messages.filter((message) => message.id > stream.lastSeq);
    if (pending.length) {
      stream.lastSeq = pending[pending.length - 1].id;
    }
    writeEvent(res, "message", { messages: pending, history: true });
    writeEvent(res, "presence", { online });
  } catch (error) {
    console.error("BOOT Chat stream init failed", { code: error && error.code, message: error && error.message });
    writeEvent(res, "stream-error", { message: "Could not load the room yet." });
  }
}

async function handlePoll(res, url) {
  const clientId = sanitizeClientId(url.searchParams.get("client"));
  const since = parseSeq(url.searchParams.get("since"));
  const results = await redisPipeline([
    readCommand(since),
    ...(clientId ? [["ZADD", ONLINE_KEY, String(Date.now()), clientId]] : []),
    ["ZCARD", ONLINE_KEY]
  ]);
  const messages = parseMessages(unwrap(results[0]));
  const online = Number(unwrap(results[results.length - 1])) || 0;
  const latest = messages.length ? messages[messages.length - 1].id : since;
  sendJson(res, 200, { messages, online, latest });
}

async function handleImage(res, rawId) {
  const id = parseSeq(rawId);
  let raw = null;
  try {
    raw = await redisCommand(["GET", `${IMAGE_PREFIX}${id}`]);
  } catch (error) {
    console.error("BOOT Chat image read failed", { code: error && error.code });
    sendJson(res, 503, { error: "Pictures are temporarily unavailable." });
    return;
  }
  if (typeof raw !== "string") {
    sendJson(res, 404, { error: "That picture is no longer available." });
    return;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed.d !== "string" || !ALLOWED_IMAGE_TYPES.has(parsed.m)) {
    sendJson(res, 404, { error: "That picture is no longer available." });
    return;
  }
  const bytes = Buffer.from(parsed.d, "base64");
  res.statusCode = 200;
  res.setHeader("Content-Type", parsed.m);
  res.setHeader("Content-Length", String(bytes.length));
  res.setHeader("Cache-Control", "public, max-age=86400, immutable");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(bytes);
}

async function consumePostRateLimit(clientId) {
  const bucket = Math.floor(Date.now() / 1000 / RATE_WINDOW_SECONDS);
  const key = `${RATE_PREFIX}${clientId}:${bucket}`;
  const results = await redisPipeline([
    ["INCR", key],
    ["EXPIRE", key, String(RATE_WINDOW_SECONDS * 2)]
  ]);
  const count = Number(unwrap(results[0])) || 0;
  return count <= MAX_POSTS_PER_WINDOW;
}

async function handlePost(req, res) {
  if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    sendJson(res, 415, { error: "Content-Type must be application/json" });
    return;
  }
  if (getEstimatedBodySize(req) > MAX_BODY_BYTES) {
    sendJson(res, 413, { error: "That message is too large" });
    return;
  }

  let body;
  try {
    body = getBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid request" });
    return;
  }
  if (!body || typeof body !== "object") {
    sendJson(res, 400, { error: "Invalid request" });
    return;
  }

  const username = normalizeUsername(body.username);
  if (!username) {
    sendJson(res, 400, { error: "Choose a username between 2 and 24 characters" });
    return;
  }

  const clientId = sanitizeClientId(body.clientId);
  if (!clientId) {
    sendJson(res, 400, { error: "This browser session is not recognised. Reload the page." });
    return;
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (text.length > MAX_TEXT_LENGTH) {
    sendJson(res, 400, { error: `Messages must be ${MAX_TEXT_LENGTH} characters or less` });
    return;
  }

  let image = null;
  try {
    image = validateImage(body.image);
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid request" });
    return;
  }

  if (!text && !image) {
    sendJson(res, 400, { error: "Type a message or attach a picture" });
    return;
  }

  let allowed = true;
  try {
    allowed = await consumePostRateLimit(clientId);
  } catch (error) {
    console.error("BOOT Chat rate limit failed", { code: error && error.code });
    sendJson(res, 503, { error: "Chat is busy right now. Please try again." });
    return;
  }
  if (!allowed) {
    res.setHeader("Retry-After", String(RATE_WINDOW_SECONDS));
    sendJson(res, 429, { error: "You are sending messages too quickly. Take a breather." });
    return;
  }

  let seq;
  try {
    seq = Number(await redisCommand(["INCR", SEQUENCE_KEY]));
  } catch (error) {
    console.error("BOOT Chat sequence failed", { code: error && error.code, message: error && error.message });
    sendJson(res, 503, { error: "Chat is busy right now. Please try again." });
    return;
  }
  if (!Number.isFinite(seq) || seq <= 0) {
    sendJson(res, 503, { error: "Chat is busy right now. Please try again." });
    return;
  }

  const record = { i: seq, u: username, t: text, m: image ? seq : 0, s: Math.floor(Date.now() / 1000) };
  const commands = [
    ["ZADD", MESSAGE_KEY, String(seq), JSON.stringify(record)],
    ["ZREMRANGEBYRANK", MESSAGE_KEY, "0", String(-(MAX_STORED_MESSAGES + 1))],
    ["EXPIRE", MESSAGE_KEY, String(MESSAGE_TTL_SECONDS)],
    ["EXPIRE", SEQUENCE_KEY, String(MESSAGE_TTL_SECONDS)]
  ];
  if (image) {
    commands.push([
      "SET",
      `${IMAGE_PREFIX}${seq}`,
      JSON.stringify({ m: image.mime, d: image.base64 }),
      "EX",
      String(MESSAGE_TTL_SECONDS)
    ]);
  }

  try {
    const results = await redisPipeline(commands);
    results.forEach(unwrap);
  } catch (error) {
    console.error("BOOT Chat write failed", { code: error && error.code, message: error && error.message });
    sendJson(res, 503, { error: "Could not send that message. Please try again." });
    return;
  }

  if (seq > hubState.fetchedSeq) {
    hubState.fetchedSeq = seq;
  }
  hubState.idleRounds = 0;
  if (hubState.intervalMs !== POLL_MIN_MS) {
    hubState.intervalMs = POLL_MIN_MS;
  }
  dispatch([normalizeMessage(record)]);

  sendJson(res, 201, { ok: true, id: seq, message: normalizeMessage(record) });
}

module.exports = async function handler(req, res) {
  if (!isSameOrigin(req)) {
    sendJson(res, 403, { error: "Cross-origin requests are not allowed" });
    return;
  }

  let url;
  try {
    url = new URL(req.url || "/api/chat", "http://localhost");
  } catch {
    sendJson(res, 400, { error: "Invalid request" });
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    if (url.searchParams.has("image")) {
      await handleImage(res, url.searchParams.get("image"));
      return;
    }
    if (url.searchParams.get("mode") === "poll") {
      try {
        await handlePoll(res, url);
      } catch (error) {
        console.error("BOOT Chat poll request failed", { code: error && error.code });
        sendJson(res, 503, { error: "Chat is busy right now. Please try again." });
      }
      return;
    }
    await handleStream(req, res, url);
    return;
  }

  if (req.method === "POST") {
    await handlePost(req, res);
    return;
  }

  res.setHeader("Allow", "GET, POST");
  sendJson(res, 405, { error: "Method not allowed" });
};
