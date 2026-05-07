import asyncio
import json
import logging
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse

BASE_DIR = Path(__file__).resolve().parent
logger = logging.getLogger(__name__)

app = FastAPI(title="asr-web-bridge")


class EventBus:
    def __init__(self) -> None:
        self._subs: set[asyncio.Queue[dict[str, Any]]] = set()
        self._lock = asyncio.Lock()

    async def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=300)
        async with self._lock:
            self._subs.add(q)
        return q

    async def unsubscribe(self, q: asyncio.Queue[dict[str, Any]]) -> None:
        async with self._lock:
            self._subs.discard(q)

    async def publish(self, event: dict[str, Any]) -> None:
        async with self._lock:
            subscribers = list(self._subs)

        stale: list[asyncio.Queue[dict[str, Any]]] = []
        for q in subscribers:
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                stale.append(q)

        if stale:
            async with self._lock:
                for q in stale:
                    self._subs.discard(q)


bus = EventBus()


class CallStore:
    def __init__(self, max_messages: int = 200) -> None:
        self._sessions: dict[str, dict[str, Any]] = {}
        self._lock = asyncio.Lock()
        self._next_event_id = 1
        self._max_messages = max_messages

    def _build_summary(self, session: dict[str, Any]) -> dict[str, Any]:
        return {
            "call_id": session["call_id"],
            "uuid": session.get("uuid"),
            "created_at": session["created_at"],
            "updated_at": session["updated_at"],
            "event_count": session["event_count"],
            "caller_turns": session["caller_turns"],
            "callee_turns": session["callee_turns"],
            "last_intent_text": session.get("last_intent_text"),
            "last_asr_text": session.get("last_asr_text"),
        }

    async def append(self, event: dict[str, Any]) -> dict[str, Any]:
        async with self._lock:
            call_id = str(event.get("call_id") or "unknown")
            session = self._sessions.get(call_id)
            if session is None:
                session = {
                    "call_id": call_id,
                    "uuid": event.get("uuid"),
                    "created_at": event["timestamp"],
                    "updated_at": event["timestamp"],
                    "event_count": 0,
                    "caller_turns": 0,
                    "callee_turns": 0,
                    "last_intent_text": None,
                    "last_asr_text": None,
                    "messages": [],
                }
                self._sessions[call_id] = session

            enriched = dict(event)
            enriched["event_id"] = self._next_event_id
            self._next_event_id += 1

            session["updated_at"] = enriched["timestamp"]
            session["event_count"] += 1
            if not session.get("uuid") and enriched.get("uuid"):
                session["uuid"] = enriched["uuid"]

            text = str(enriched.get("text") or "").strip() or None
            speaker = enriched.get("speaker")

            if speaker == "caller":
                session["caller_turns"] += 1
                if text:
                    session["last_intent_text"] = text
            elif speaker == "callee":
                session["callee_turns"] += 1
                if text:
                    session["last_asr_text"] = text

            session["messages"].append(enriched)
            if len(session["messages"]) > self._max_messages:
                session["messages"] = session["messages"][-self._max_messages :]

            return enriched

    async def list_calls(self) -> list[dict[str, Any]]:
        async with self._lock:
            sessions = sorted(self._sessions.values(), key=lambda item: item["updated_at"], reverse=True)
            return [self._build_summary(session) for session in sessions]

    async def get_call(self, call_id: str) -> dict[str, Any] | None:
        async with self._lock:
            session = self._sessions.get(str(call_id))
            if session is None:
                return None
            return {
                **self._build_summary(session),
                "messages": list(session["messages"]),
            }


store = CallStore()


def resolve_call_id(payload: dict[str, Any]) -> str:
    value = payload.get("call_id") or payload.get("session_id") or payload.get("uuid") or "unknown"
    return str(value)


def extract_text(payload: dict[str, Any]) -> str | None:
    for key in ("transcript", "text", "sentence", "content", "answer", "query", "message"):
        value = payload.get(key)
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return None


def normalize_event(
    payload: dict[str, Any],
    event_type: str | None = None,
    speaker: str | None = None,
) -> dict[str, Any]:
    if event_type is None:
        event_type = str(payload.get("event") or "intent")

    if speaker is None:
        speaker = str(payload.get("speaker") or "system")

    text = extract_text(payload)
    call_id = resolve_call_id(payload)

    return {
        "type": event_type,
        "speaker": speaker,
        "call_id": call_id,
        "intent_id": payload.get("intent_id"),
        "uuid": payload.get("uuid"),
        "text": text,
        "transcript": text,
        "timestamp": int(payload.get("timestamp") or int(time.time() * 1000)),
        "raw": payload,
    }


async def publish_monitor_event(event: dict[str, Any]) -> dict[str, Any]:
    enriched = await store.append(event)
    await bus.publish(enriched)
    return enriched


@app.get("/", response_class=HTMLResponse)
async def home() -> FileResponse:
    return FileResponse(BASE_DIR / "index.html")


@app.get("/app.js")
async def app_js() -> FileResponse:
    return FileResponse(BASE_DIR / "app.js", media_type="application/javascript")


@app.get("/debug", response_class=HTMLResponse)
async def debug_page() -> FileResponse:
    return FileResponse(BASE_DIR / "debug.html")


@app.get("/debug.js")
async def debug_js() -> FileResponse:
    return FileResponse(BASE_DIR / "debug.js", media_type="application/javascript")


@app.post("/internal/v1/callback")
async def callback(request: Request) -> JSONResponse:
    payload = await request.json()
    event = normalize_event(payload, speaker="caller")
    event = await publish_monitor_event(event)
    return JSONResponse({"ok": True, "event": event})


@app.post("/monitor-intent")
async def monitor_intent(request: Request) -> JSONResponse:
    payload = await request.json()
    event = normalize_event(payload, event_type="intent", speaker="caller")
    event = await publish_monitor_event(event)
    return JSONResponse({"ok": True, "event": event})


@app.post("/interrupt")
async def interrupt(request: Request) -> JSONResponse:
    payload = await request.json()
    event = normalize_event(payload, event_type="interrupt", speaker="system")
    event = await publish_monitor_event(event)
    return JSONResponse({"ok": True, "event": event})


@app.post("/monitor-asr")
async def monitor_asr(request: Request) -> JSONResponse:
    payload = await request.json()
    event = normalize_event(payload, event_type="asr", speaker="callee")
    logger.info("monitor asr received: call_id=%s text=%r", event.get("call_id"), event.get("text"))
    event = await publish_monitor_event(event)
    return JSONResponse({"ok": True, "event": event})


@app.post("/monitor-event")
async def monitor_event(request: Request) -> JSONResponse:
    payload = await request.json()
    event_type = str(payload.get("event") or payload.get("type") or "system")
    event = normalize_event(payload, event_type=event_type, speaker="system")
    logger.info(
        "monitor event received: call_id=%s event=%s text=%r",
        event.get("call_id"),
        event.get("type"),
        event.get("text"),
    )
    event = await publish_monitor_event(event)
    return JSONResponse({"ok": True, "event": event})


@app.post("/transcript")
async def transcript_compat(request: Request) -> JSONResponse:
    payload = await request.json()
    event = normalize_event(payload, event_type="asr", speaker="callee")
    logger.info("transcript compat received: call_id=%s text=%r", event.get("call_id"), event.get("text"))
    event = await publish_monitor_event(event)
    return JSONResponse({"ok": True, "event": event})


@app.get("/monitor/calls")
async def monitor_calls() -> JSONResponse:
    calls = await store.list_calls()
    return JSONResponse({"ok": True, "items": calls})


@app.get("/monitor/calls/{call_id}")
async def monitor_call_detail(call_id: str) -> JSONResponse:
    call = await store.get_call(call_id)
    if call is None:
        return JSONResponse({"ok": False, "error": "call_not_found"}, status_code=404)
    return JSONResponse({"ok": True, "item": call})


@app.get("/events")
async def events(call_id: str | None = None) -> StreamingResponse:
    queue = await bus.subscribe()

    async def gen():
        last_heartbeat = time.monotonic()
        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=5.0)
                    if call_id is None or str(event.get("call_id")) == call_id:
                        yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                except asyncio.TimeoutError:
                    now = time.monotonic()
                    if now - last_heartbeat >= 5.0:
                        yield ": ping\n\n"
                        last_heartbeat = now
        finally:
            await bus.unsubscribe(queue)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
