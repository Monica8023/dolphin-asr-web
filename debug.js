const $ = (id) => document.getElementById(id);

const state = {
  ws: null,
  sse: null,
  stream: null,
  audioCtx: null,
  processor: null,
  running: false,
  sentFrames: 0,
  sentBytes: 0,
  pcmBuffer: new Int16Array(0),
  started: false,
  startPrimed: false,
  callId: null,
  uuid: null,
  modelId: null,
};

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const STORAGE_KEY = "asr-debug-form-state";

function logTo(el, text) {
  const now = new Date().toLocaleTimeString();
  el.textContent += `[${now}] ${text}\n`;
  el.scrollTop = el.scrollHeight;
}

function setText(id, text) {
  $(id).textContent = String(text);
}

function saveFormState() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        host: $("host").value,
        port: $("port").value,
        callId: $("callId").value,
        uuid: $("uuid").value,
        modelId: $("modelId").value,
        chunkMs: $("chunkMs").value,
      })
    );
  } catch {}
}

function restoreFormState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    for (const [id, value] of Object.entries(data)) {
      const el = $(id);
      if (el && typeof value === "string") el.value = value;
    }
  } catch {}
}

function wsUrl(host, port, callId, uuid, modelId) {
  return `ws://${host}:${port}/ws/asr?call_id=${encodeURIComponent(callId)}&uuid=${encodeURIComponent(uuid)}&model_id=${encodeURIComponent(modelId)}`;
}

function setControlState({ startDisabled, pauseDisabled, resumeDisabled, stopDisabled }) {
  $("startBtn").disabled = startDisabled;
  $("pauseBtn").disabled = pauseDisabled;
  $("resumeBtn").disabled = resumeDisabled;
  $("stopBtn").disabled = stopDisabled;
}

function sendTextFrame(payload) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    logTo($("asrLog"), `skip text frame (ws not open): ${payload}`);
    return false;
  }
  state.ws.send(payload);
  logTo($("asrLog"), `sent text frame: ${payload}`);
  return true;
}

function buildControlEvent(control) {
  return JSON.stringify({
    call_id: state.callId,
    uuid: state.uuid,
    control,
    model_id: Number(state.modelId),
  });
}

function buildStartEvent() {
  return buildControlEvent("start");
}

function buildPauseEvent() {
  return buildControlEvent("pause");
}

function buildStopEvent() {
  return buildControlEvent("stop");
}

function frameSamples(chunkMs) {
  return Math.floor((SAMPLE_RATE * chunkMs) / 1000);
}

function downmixToMono(input) {
  if (input.numberOfChannels <= 1) return input.getChannelData(0);
  const len = input.getChannelData(0).length;
  const mono = new Float32Array(len);
  for (let c = 0; c < input.numberOfChannels; c += 1) {
    const ch = input.getChannelData(c);
    for (let i = 0; i < len; i += 1) mono[i] += ch[i];
  }
  for (let i = 0; i < len; i += 1) mono[i] /= input.numberOfChannels;
  return mono;
}

function linearResample(mono, srcRate, dstRate) {
  if (srcRate === dstRate) return mono;
  const dstLen = Math.floor((mono.length * dstRate) / srcRate);
  if (dstLen <= 0) return new Float32Array(0);
  const out = new Float32Array(dstLen);
  const ratio = (mono.length - 1) / Math.max(dstLen - 1, 1);
  for (let i = 0; i < dstLen; i += 1) {
    const pos = i * ratio;
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, mono.length - 1);
    const frac = pos - lo;
    out[i] = mono[lo] * (1 - frac) + mono[hi] * frac;
  }
  return out;
}

function floatToInt16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i += 1) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
  }
  return out;
}

function concatInt16(a, b) {
  const out = new Int16Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function int16ToArrayBuffer(int16) {
  return int16.buffer.slice(int16.byteOffset, int16.byteOffset + int16.byteLength);
}

function setCurrentTranscript(text) {
  const el = $("transcriptLog");
  const value = String(text ?? "").trim();
  if (!value) {
    el.innerHTML = '<span class="transcript-empty">等待语音输入...</span>';
    return;
  }

  const empty = el.querySelector(".transcript-empty");
  if (empty) empty.remove();

  const line = document.createElement("div");
  line.textContent = value;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;

  while (el.children.length > 120) {
    el.removeChild(el.firstChild);
  }
}

function appendEventHit(eventType, intentId) {
  const container = $("eventLog");
  const item = document.createElement("div");
  item.className = "event-item";

  const name = document.createElement("span");
  name.className = "event-name";
  name.textContent = String(eventType || "unknown");

  const badge = document.createElement("span");
  badge.className = "intent-tag";
  const value = intentId == null || String(intentId).trim() === "" ? "-" : String(intentId);
  badge.append("意图ID ");
  const highlight = document.createElement("span");
  highlight.className = "intent-value";
  highlight.textContent = value;
  badge.appendChild(highlight);

  item.appendChild(name);
  item.appendChild(badge);
  container.prepend(item);

  while (container.children.length > 80) {
    container.removeChild(container.lastChild);
  }
}

function appendEventFallback(text) {
  const container = $("eventLog");
  const item = document.createElement("div");
  item.className = "event-item";

  const name = document.createElement("span");
  name.className = "event-name";
  name.textContent = String(text ?? "unknown event");

  const badge = document.createElement("span");
  badge.className = "intent-tag";
  badge.append("意图ID ");
  const highlight = document.createElement("span");
  highlight.className = "intent-value";
  highlight.textContent = "-";
  badge.appendChild(highlight);

  item.appendChild(name);
  item.appendChild(badge);
  container.prepend(item);

  while (container.children.length > 80) {
    container.removeChild(container.lastChild);
  }
}

function startSSE(callId) {
  if (state.sse) {
    state.sse.close();
    state.sse = null;
  }

  const expectedCallId = String(callId ?? "").trim();
  const sse = new EventSource("/events");
  state.sse = sse;
  setText("sseState", "CONNECTING");

  sse.onopen = () => {
    setText("sseState", "CONNECTED");
    logTo($("asrLog"), `sse connected: /events (expected call_id=${expectedCallId || "*"})`);
  };
  sse.onerror = () => {
    setText("sseState", "ERROR");
    logTo($("asrLog"), "sse error");
  };
  sse.onmessage = (evt) => {
    try {
      const data = JSON.parse(evt.data);
      const eventType = data.type ?? data.event ?? data.raw?.event ?? null;
      const text = data.transcript ?? data.text ?? data.raw?.text ?? data.raw?.sentence ?? null;
      const eventCallId = String(data.call_id ?? data.raw?.call_id ?? "").trim();

      if (eventCallId && expectedCallId && eventCallId !== expectedCallId) {
        return;
      }

      if (eventType === "asr" || eventType === "transcript") {
        logTo($("asrLog"), `transcript event received: call_id=${eventCallId || "-"} text=${String(text ?? "")}`);
        setCurrentTranscript(text);
        return;
      }

      appendEventHit(eventType, data.intent_id ?? data.raw?.intent_id ?? null);
    } catch {
      appendEventFallback(evt.data);
    }
  };
}

function stopSSE() {
  if (state.sse) {
    state.sse.close();
    state.sse = null;
  }
  setText("sseState", "IDLE");
}

async function startStreaming() {
  if (state.running || state.started) return;

  const host = $("host").value.trim();
  const port = $("port").value.trim();
  const callId = $("callId").value.trim();
  const uuid = $("uuid").value.trim();
  const modelId = $("modelId").value.trim() || "1";
  const chunkMs = Number($("chunkMs").value.trim() || "60");
  const samplesPerFrame = frameSamples(chunkMs);

  const url = wsUrl(host, port, callId, uuid, modelId);
  logTo($("asrLog"), `connect params: host=${host} port=${port} call_id=${callId} uuid=${uuid} model_id=${modelId} chunk_ms=${chunkMs}`);
  logTo($("asrLog"), `connect url: ${url}`);
  state.sentFrames = 0;
  state.sentBytes = 0;
  state.pcmBuffer = new Int16Array(0);
  state.started = false;
  state.callId = callId;
  state.uuid = uuid;
  state.modelId = modelId;
  setText("frames", 0);
  setText("bytes", 0);

  state.ws = new WebSocket(url);
  state.ws.binaryType = "arraybuffer";
  state.startPrimed = false;

  state.ws.addEventListener("message", (evt) => {
    logTo($("asrLog"), `ws message: ${typeof evt.data === "string" ? evt.data : "[binary]"}`);
  });

  state.ws.addEventListener("open", () => {
    logTo($("asrLog"), `ws open: readyState=${state.ws?.readyState}`);
  });

  state.ws.addEventListener("close", (evt) => {
    logTo($("asrLog"), `ws close event: code=${evt.code} reason=${evt.reason || "-"} wasClean=${evt.wasClean}`);
  });

  state.ws.onopen = async () => {
    setText("wsState", "CONNECTED");
    startSSE(callId);

    const startPayload = buildStartEvent();
    state.startPrimed = sendTextFrame(startPayload);
    state.started = state.startPrimed;
    state.running = true;
    setControlState({ startDisabled: true, pauseDisabled: false, resumeDisabled: true, stopDisabled: false });

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
      logTo($("asrLog"), `mic error: ${err?.message || err}`);
      state.running = false;
      state.started = false;
      setControlState({ startDisabled: false, pauseDisabled: true, resumeDisabled: true, stopDisabled: true });
      state.ws.close();
      return;
    }

    state.stream = stream;
    state.audioCtx = new AudioContext();
    const source = state.audioCtx.createMediaStreamSource(state.stream);
    const processor = state.audioCtx.createScriptProcessor(4096, source.channelCount, 1);
    state.processor = processor;

    processor.onaudioprocess = (e) => {
      if (!state.running || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;

      const mono = downmixToMono(e.inputBuffer);
      const resampled = linearResample(mono, state.audioCtx.sampleRate, SAMPLE_RATE);
      const int16 = floatToInt16(resampled);

      state.pcmBuffer = concatInt16(state.pcmBuffer, int16);

      while (state.pcmBuffer.length >= samplesPerFrame) {
        const frame = state.pcmBuffer.slice(0, samplesPerFrame);
        state.pcmBuffer = state.pcmBuffer.slice(samplesPerFrame);
        const ab = int16ToArrayBuffer(frame);
        state.ws.send(ab);
        state.sentFrames += 1;
        state.sentBytes += samplesPerFrame * BYTES_PER_SAMPLE;
        if (state.sentFrames <= 3) {
          logTo($("asrLog"), `sent binary frame#${state.sentFrames}: bytes=${ab.byteLength}`);
        }
      }

      setText("frames", state.sentFrames);
      setText("bytes", state.sentBytes);
    };

    source.connect(processor);
    processor.connect(state.audioCtx.destination);
    logTo($("asrLog"), `connected ${url}`);
  };

  state.ws.onerror = () => {
    setText("wsState", "ERROR");
    logTo($("asrLog"), "websocket error");
  };

  state.ws.onclose = () => {
    setText("wsState", "DISCONNECTED");
    setControlState({ startDisabled: false, pauseDisabled: true, resumeDisabled: true, stopDisabled: true });
    logTo($("asrLog"), "websocket closed");
  };
}

async function pauseStreaming() {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN || !state.running) return;
  const pausePayload = buildPauseEvent();
  sendTextFrame(pausePayload);
  state.running = false;
  setControlState({ startDisabled: true, pauseDisabled: true, resumeDisabled: false, stopDisabled: false });
}

async function resumeStreaming() {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN || state.running) return;
  const resumePayload = buildStartEvent();
  const sent = sendTextFrame(resumePayload);
  state.running = sent;
  state.started = sent;
  setControlState({ startDisabled: true, pauseDisabled: !sent, resumeDisabled: sent, stopDisabled: false });
}

async function stopStreaming() {
  const shouldSendStop = Boolean(state.started);
  state.running = false;
  setControlState({ startDisabled: false, pauseDisabled: true, resumeDisabled: true, stopDisabled: true });

  if (state.processor) {
    state.processor.disconnect();
    state.processor.onaudioprocess = null;
    state.processor = null;
  }

  if (state.audioCtx) {
    await state.audioCtx.close();
    state.audioCtx = null;
  }

  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }

  if (state.ws) {
    try {
      if (shouldSendStop && state.ws.readyState === WebSocket.OPEN) {
        const stopPayload = buildStopEvent();
        sendTextFrame(stopPayload);
      }
      state.ws.close();
    } catch {}
    state.ws = null;
  }

  state.started = false;
  state.pcmBuffer = new Int16Array(0);
  stopSSE();
  logTo($("asrLog"), "stream stopped");
}

function clearLogs() {
  $("asrLog").textContent = "";
  $("eventLog").innerHTML = "";
  setCurrentTranscript("");
}

$("startBtn").addEventListener("click", async () => {
  try {
    await startStreaming();
  } catch (err) {
    logTo($("asrLog"), `start failed: ${err?.message || err}`);
    setText("wsState", "ERROR");
  }
});

$("pauseBtn").addEventListener("click", async () => {
  await pauseStreaming();
});

$("resumeBtn").addEventListener("click", async () => {
  await resumeStreaming();
});

$("stopBtn").addEventListener("click", async () => {
  await stopStreaming();
});

$("clearBtn").addEventListener("click", clearLogs);

for (const id of ["host", "port", "callId", "uuid", "modelId", "chunkMs"]) {
  $(id).addEventListener("input", saveFormState);
}

restoreFormState();
