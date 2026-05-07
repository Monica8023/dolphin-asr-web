const $ = (id) => document.getElementById(id);

const state = {
  sse: null,
  calls: [],
  callMap: new Map(),
  selectedCallId: null,
  selectedCall: null,
  selectedMessageIds: new Set(),
  rawLines: [],
  lastRefreshAt: null,
};

const RAW_LOG_LIMIT = 120;
const STORAGE_KEY = "asr-monitor-ui-state";

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = String(text);
}

function saveUiState() {
  try {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        selectedCallId: state.selectedCallId,
        callSearch: $("callSearch")?.value ?? "",
        rawLines: state.rawLines.slice(-RAW_LOG_LIMIT),
      })
    );
  } catch {}
}

function loadUiState() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    state.selectedCallId = data.selectedCallId ? normalizeCallId(data.selectedCallId) : null;
    state.rawLines = Array.isArray(data.rawLines) ? data.rawLines.slice(-RAW_LOG_LIMIT) : [];
    if ($("callSearch") && typeof data.callSearch === "string") {
      $("callSearch").value = data.callSearch;
    }
  } catch {}
}

function formatTime(ts) {
  const value = Number(ts);
  if (!Number.isFinite(value) || value <= 0) return "-";
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function truncate(text, max = 54) {
  const value = String(text ?? "").trim();
  if (!value) return "-";
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

function normalizeCallId(value) {
  const text = String(value ?? "").trim();
  return text || "unknown";
}

function getEventText(event) {
  return String(event?.text ?? event?.transcript ?? event?.raw?.text ?? event?.raw?.sentence ?? "").trim();
}

function getEventKey(event) {
  return String(
    event?.event_id ??
      `${normalizeCallId(event?.call_id)}|${event?.type}|${event?.speaker}|${event?.timestamp}|${getEventText(event)}`
  );
}

function getSpeakerLabel(speaker, type) {
  if (speaker === "caller") return "主叫问法";
  if (speaker === "callee") return "被叫回答";
  if (type === "interrupt") return "中断事件";
  return "系统事件";
}

function getTagClass(speaker) {
  if (speaker === "caller") return "caller";
  if (speaker === "callee") return "callee";
  return "system";
}

function setMonitorState(text) {
  setText("monitorState", text);
}

function rebuildCallMap(items) {
  state.calls = items.map((item) => ({ ...item }));
  state.callMap = new Map(state.calls.map((item) => [normalizeCallId(item.call_id), item]));
  sortCalls();
}

function sortCalls() {
  state.calls.sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0));
}

function getSelectedSummary() {
  if (!state.selectedCallId) return null;
  return state.callMap.get(normalizeCallId(state.selectedCallId)) || state.selectedCall;
}

function renderSummary() {
  setText("callCount", state.calls.length);
  setText("selectedCallId", state.selectedCallId || "-");
  setText("lastRefresh", state.lastRefreshAt ? formatTime(state.lastRefreshAt) : "-");

  const badge = $("selectedBadge");
  const summary = getSelectedSummary();
  if (!badge) return;

  if (!summary) {
    badge.className = "tag system";
    badge.textContent = "未选择";
    $("selectedMeta").textContent = "选择左侧某个会话后，这里展示左右气泡式对话流。";
    return;
  }

  badge.className = "tag caller";
  badge.textContent = `callId ${normalizeCallId(summary.call_id)}`;
  $("selectedMeta").textContent =
    `UUID ${summary.uuid || "-"} · 最近更新 ${formatTime(summary.updated_at)} · 主叫 ${summary.caller_turns || 0} 条 · 被叫 ${summary.callee_turns || 0} 条`;
  saveUiState();
}

function createEmptyListNode(text) {
  const empty = document.createElement("div");
  empty.className = "conversation-empty";
  empty.style.minHeight = "160px";
  empty.style.height = "auto";
  empty.textContent = text;
  return empty;
}

function renderCallList() {
  const container = $("callList");
  if (!container) return;

  const query = $("callSearch").value.trim().toLowerCase();
  const items = state.calls.filter((item) => {
    if (!query) return true;
    const haystack = [
      item.call_id,
      item.uuid,
      item.last_intent_text,
      item.last_asr_text,
    ]
      .map((value) => String(value ?? "").toLowerCase())
      .join("\n");
    return haystack.includes(query);
  });

  container.innerHTML = "";
  if (!items.length) {
    container.appendChild(createEmptyListNode(query ? "没有匹配的会话" : "当前还没有收到任何会话"));
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const item of items) {
    const node = document.createElement("div");
    node.className = "session-item";
    if (normalizeCallId(item.call_id) === normalizeCallId(state.selectedCallId)) {
      node.classList.add("active");
    }

    const top = document.createElement("div");
    top.className = "session-top";

    const id = document.createElement("div");
    id.className = "session-id";
    id.textContent = `callId: ${normalizeCallId(item.call_id)}`;

    const time = document.createElement("div");
    time.className = "session-time";
    time.textContent = formatTime(item.updated_at);

    top.appendChild(id);
    top.appendChild(time);

    const meta = document.createElement("div");
    meta.className = "session-meta";
    for (const label of [
      `UUID ${item.uuid || "-"}`,
      `主叫 ${item.caller_turns || 0}`,
      `被叫 ${item.callee_turns || 0}`,
      `事件 ${item.event_count || 0}`,
    ]) {
      const span = document.createElement("span");
      span.textContent = label;
      meta.appendChild(span);
    }

    const intentSnippet = document.createElement("div");
    intentSnippet.className = "session-snippet";
    intentSnippet.textContent = `主叫: ${truncate(item.last_intent_text, 72)}`;

    const asrSnippet = document.createElement("div");
    asrSnippet.className = "session-snippet";
    asrSnippet.textContent = `被叫: ${truncate(item.last_asr_text, 72)}`;

    node.appendChild(top);
    node.appendChild(meta);
    node.appendChild(intentSnippet);
    node.appendChild(asrSnippet);
    node.addEventListener("click", () => {
      void selectCall(item.call_id);
    });
    fragment.appendChild(node);
  }

  container.appendChild(fragment);
}

function renderConversation() {
  const container = $("conversation");
  if (!container) return;

  container.innerHTML = "";

  if (!state.selectedCallId) {
    const empty = document.createElement("div");
    empty.id = "conversationEmpty";
    empty.className = "conversation-empty";
    empty.innerHTML = "选择左侧某个 <code>callId</code> 查看详情。<br />左侧固定显示主叫问法，右侧固定显示被叫回答。";
    container.appendChild(empty);
    return;
  }

  const messages = state.selectedCall?.messages || [];
  if (!messages.length) {
    const empty = document.createElement("div");
    empty.id = "conversationEmpty";
    empty.className = "conversation-empty";
    empty.textContent = "该会话暂时还没有收到对话消息。";
    container.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const message of messages) {
    const speaker = message.speaker || "system";
    const row = document.createElement("div");
    row.className = `turn ${speaker === "caller" ? "left" : speaker === "callee" ? "right" : "center"}`;

    const bubble = document.createElement("div");
    bubble.className = `bubble ${speaker}`;

    const meta = document.createElement("div");
    meta.className = "bubble-meta";

    const role = document.createElement("div");
    role.className = "bubble-role";
    role.textContent = getSpeakerLabel(speaker, message.type);

    const time = document.createElement("div");
    const intentId = message.intent_id == null || String(message.intent_id).trim() === "" ? "-" : String(message.intent_id);
    time.textContent =
      speaker === "caller"
        ? `${formatTime(message.timestamp)} · intent ${intentId}`
        : formatTime(message.timestamp);

    const text = document.createElement("div");
    text.className = "bubble-text";
    text.textContent = getEventText(message) || `[${message.type || "event"}]`;

    meta.appendChild(role);
    meta.appendChild(time);
    bubble.appendChild(meta);
    bubble.appendChild(text);
    row.appendChild(bubble);
    fragment.appendChild(row);
  }

  container.appendChild(fragment);
  container.scrollTop = container.scrollHeight;
}

function appendRawEvent(event) {
  const line =
    `[${formatTime(event.timestamp)}] ` +
    `call_id=${normalizeCallId(event.call_id)} ` +
    `type=${event.type || "-"} ` +
    `speaker=${event.speaker || "-"} ` +
    `text=${getEventText(event) || "-"}`;

  state.rawLines.push(line);
  if (state.rawLines.length > RAW_LOG_LIMIT) {
    state.rawLines = state.rawLines.slice(-RAW_LOG_LIMIT);
  }

  $("rawEventLog").textContent = state.rawLines.join("\n");
  $("rawEventLog").scrollTop = $("rawEventLog").scrollHeight;
  saveUiState();
}

function upsertCallFromEvent(event) {
  const callId = normalizeCallId(event.call_id);
  let item = state.callMap.get(callId);
  if (!item) {
    item = {
      call_id: callId,
      uuid: event.uuid || null,
      created_at: event.timestamp || Date.now(),
      updated_at: event.timestamp || Date.now(),
      event_count: 0,
      caller_turns: 0,
      callee_turns: 0,
      last_intent_text: null,
      last_asr_text: null,
    };
    state.calls.push(item);
    state.callMap.set(callId, item);
  }

  item.uuid = item.uuid || event.uuid || null;
  item.updated_at = event.timestamp || item.updated_at || Date.now();
  item.event_count = Number(item.event_count || 0) + 1;

  const text = getEventText(event);
  if (event.speaker === "caller") {
    item.caller_turns = Number(item.caller_turns || 0) + 1;
    if (text) item.last_intent_text = text;
  } else if (event.speaker === "callee") {
    item.callee_turns = Number(item.callee_turns || 0) + 1;
    if (text) item.last_asr_text = text;
  }

  sortCalls();
}

function appendSelectedMessage(event) {
  if (normalizeCallId(event.call_id) !== normalizeCallId(state.selectedCallId)) {
    return;
  }

  if (!state.selectedCall) {
    state.selectedCall = {
      call_id: normalizeCallId(event.call_id),
      uuid: event.uuid || null,
      created_at: event.timestamp || Date.now(),
      updated_at: event.timestamp || Date.now(),
      messages: [],
    };
  }

  const key = getEventKey(event);
  if (state.selectedMessageIds.has(key)) return;

  if (!Array.isArray(state.selectedCall.messages)) {
    state.selectedCall.messages = [];
  }

  state.selectedCall.updated_at = event.timestamp || state.selectedCall.updated_at;
  state.selectedCall.messages.push(event);
  state.selectedMessageIds.add(key);
  renderConversation();
}

function ingestEvent(event) {
  if (!event || !event.call_id) return;
  upsertCallFromEvent(event);
  appendSelectedMessage(event);
  appendRawEvent(event);
  renderCallList();
  renderSummary();
}

async function loadCalls({ preserveSelection = true } = {}) {
  const response = await fetch("/monitor/calls");
  if (!response.ok) {
    throw new Error(`load calls failed: ${response.status}`);
  }

  const data = await response.json();
  rebuildCallMap(data.items || []);
  state.lastRefreshAt = Date.now();

  const current = preserveSelection ? normalizeCallId(state.selectedCallId) : "";
  const hasCurrent = current && state.callMap.has(current);

  renderCallList();
  renderSummary();

  if (hasCurrent) {
    await loadCallDetail(current);
    return;
  }

  if (!preserveSelection && state.calls.length) {
    await selectCall(state.calls[0].call_id);
    return;
  }

  if (!state.calls.length) {
    state.selectedCallId = null;
    state.selectedCall = null;
    state.selectedMessageIds = new Set();
    renderConversation();
    renderSummary();
  }
}

async function loadCallDetail(callId) {
  const normalized = normalizeCallId(callId);
  const response = await fetch(`/monitor/calls/${encodeURIComponent(normalized)}`);
  if (response.status === 404) {
    if (normalizeCallId(state.selectedCallId) === normalized) {
      state.selectedCall = null;
      state.selectedMessageIds = new Set();
      renderConversation();
      renderSummary();
    }
    return;
  }

  if (!response.ok) {
    throw new Error(`load call detail failed: ${response.status}`);
  }

  const data = await response.json();
  if (normalizeCallId(state.selectedCallId) !== normalized) return;

  state.selectedCall = data.item || null;
  state.selectedMessageIds = new Set((state.selectedCall?.messages || []).map(getEventKey));
  renderConversation();
  renderSummary();
  saveUiState();
}

async function selectCall(callId) {
  const normalized = callId ? normalizeCallId(callId) : null;
  state.selectedCallId = normalized;
  state.selectedCall = null;
  state.selectedMessageIds = new Set();
  renderCallList();
  renderConversation();
  renderSummary();
  saveUiState();

  if (!normalized) return;
  await loadCallDetail(normalized);
}

function connectEventStream() {
  if (state.sse) {
    state.sse.close();
    state.sse = null;
  }

  setMonitorState("CONNECTING");
  const sse = new EventSource("/events");
  state.sse = sse;

  sse.onopen = () => {
    setMonitorState("CONNECTED");
  };

  sse.onerror = () => {
    setMonitorState("ERROR");
  };

  sse.onmessage = (evt) => {
    try {
      const event = JSON.parse(evt.data);
      ingestEvent(event);
    } catch (error) {
      appendRawEvent({
        call_id: "unknown",
        type: "parse-error",
        speaker: "system",
        timestamp: Date.now(),
        text: `invalid event payload: ${error}`,
      });
    }
  };
}

async function refreshCalls() {
  try {
    await loadCalls({ preserveSelection: true });
  } catch (error) {
    setMonitorState("ERROR");
    appendRawEvent({
      call_id: "unknown",
      type: "refresh-error",
      speaker: "system",
      timestamp: Date.now(),
      text: String(error?.message || error),
    });
  }
}

$("refreshBtn").addEventListener("click", () => {
  void refreshCalls();
});

$("selectLatestBtn").addEventListener("click", () => {
  if (!state.calls.length) return;
  void selectCall(state.calls[0].call_id);
});

$("clearSelectionBtn").addEventListener("click", () => {
  void selectCall(null);
});

$("callSearch").addEventListener("input", () => {
  renderCallList();
  saveUiState();
});

window.addEventListener("beforeunload", () => {
  if (state.sse) state.sse.close();
});

async function bootstrap() {
  loadUiState();
  $("rawEventLog").textContent = "等待监控事件...\n";
  if (state.rawLines.length) {
    $("rawEventLog").textContent = state.rawLines.join("\n");
  }
  connectEventStream();

  try {
    await loadCalls({ preserveSelection: Boolean(state.selectedCallId) });
    if (!state.selectedCallId && state.calls.length) {
      await selectCall(state.calls[0].call_id);
    }
  } catch (error) {
    setMonitorState("ERROR");
    appendRawEvent({
      call_id: "unknown",
      type: "bootstrap-error",
      speaker: "system",
      timestamp: Date.now(),
      text: String(error?.message || error),
    });
  }
}

void bootstrap();
