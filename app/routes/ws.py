from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from datetime import datetime, timezone
from pathlib import Path
from app.utils.config import RECORDINGS_DIR
import json
import os
import asyncio
import assemblyai as aai
from app.utils.config import ASSEMBLY_API_KEY
from groq import Groq
from app.utils.config import GROQ_API_KEY
from app.services.murf_ws import stream_llm_to_murf_with_client_forwarding
from assemblyai.streaming.v3.client import (
    StreamingClient,
    StreamingClientOptions,
    StreamingEvents,
    StreamingParameters,
)
from assemblyai.streaming.v3.models import Encoding

router = APIRouter()

@router.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    try:
        while True:
            msg = await ws.receive_text()
            payload = {
                "type": "echo",
                "received": msg,
                "server_time": datetime.now(timezone.utc).isoformat()
            }
            await ws.send_text(json.dumps(payload))
    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await ws.send_text(json.dumps({"type": "error", "detail": str(e)}))
        except Exception:
            pass
        finally:
            await ws.close()


@router.websocket("/ws/stream-audio")
async def stream_audio(ws: WebSocket):
    """
    Receives binary audio frames over a websocket and writes them to a file.
    The client should connect with optional query params:
      - session_id: groups recordings by session
      - container: file extension to use (default: webm)

    Client may send text message "close" to finalize the file.
    """
    session_id = ws.query_params.get("session_id", "session")
    container = (ws.query_params.get("container") or "webm").strip(".")

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    Path(RECORDINGS_DIR).mkdir(parents=True, exist_ok=True)
    filename = f"{session_id}_{timestamp}.{container}"
    file_path = os.path.join(RECORDINGS_DIR, filename)

    await ws.accept()
    await ws.send_text(json.dumps({"type": "ready", "file": filename}))

    f = open(file_path, "wb")
    try:
        while True:
            message = await ws.receive()
            mtype = message.get("type")
            if mtype == "websocket.disconnect":
                break
            if message.get("bytes") is not None:
                f.write(message["bytes"])
                continue
            text = message.get("text")
            if text:
                if text.lower() in {"close", "stop", "end"}:
                    break
                # optional keepalive/metadata ignored
                continue
    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await ws.send_text(json.dumps({"type": "error", "detail": str(e)}))
        except Exception:
            pass
    finally:
        try:
            f.flush()
            f.close()
        except Exception:
            pass
        try:
            await ws.send_text(json.dumps({"type": "saved", "file": filename}))
        except Exception:
            pass
        try:
            await ws.close()
        except Exception:
            pass


@router.websocket("/ws/transcribe")
async def ws_transcribe(ws: WebSocket):
    """
    Receives 16kHz, 16-bit mono PCM frames from the client over websocket and
    streams them to AssemblyAI Realtime, returning partial/final transcripts
    back to the client as JSON messages.
    """
    await ws.accept()

    # Quick validation for missing API key
    if not ASSEMBLY_API_KEY:
        try:
            await ws.send_text(json.dumps({
                "type": "error",
                "detail": "Missing ASSEMBLYAI_API_KEY in environment."
            }))
        finally:
            await ws.close()
        return

    # Configure AssemblyAI Universal Streaming (v3)
    loop = asyncio.get_event_loop()

    async def _send_json(payload: dict) -> None:
        try:
            await ws.send_text(json.dumps(payload))
        except Exception:
            pass

    session_ready = asyncio.Event()

    def on_begin(_client, evt):
        loop.call_soon_threadsafe(session_ready.set)
        asyncio.run_coroutine_threadsafe(_send_json({"type": "ready"}), loop)

    def on_turn(_client, evt):
        text = getattr(evt, "transcript", "")
        is_end = bool(getattr(evt, "end_of_turn", False))
        if is_end:
            # send final transcript
            asyncio.run_coroutine_threadsafe(_send_json({"type": "final", "text": text}), loop)
            # explicit turn-end signal for UI
            asyncio.run_coroutine_threadsafe(_send_json({"type": "turn_end", "text": text}), loop)
            
            # Stream LLM response after turn ends
            if text.strip():
                asyncio.run_coroutine_threadsafe(_stream_llm_response(text), loop)
        else:
            asyncio.run_coroutine_threadsafe(_send_json({"type": "partial", "text": text}), loop)

    async def _stream_llm_response(transcript: str):
        """Stream LLM response and send chunks to client"""
        try:
            groq_client = Groq(api_key=GROQ_API_KEY)
            
            # Build conversation context
            messages = [
                {"role": "system", "content": "You are a helpful AI assistant. Answer succinctly."},
                {"role": "user", "content": transcript}
            ]
            
            # Create streaming completion
            stream = groq_client.chat.completions.create(
                model="llama-3.3-70b-versatile",
                messages=messages,
                stream=True,
                max_tokens=512,
                temperature=0.7
            )
            
            accumulated_text = ""
            
            # Stream chunks to client
            for chunk in stream:
                if chunk.choices[0].delta.content:
                    content = chunk.choices[0].delta.content
                    accumulated_text += content
                    await _send_json({"type": "llm_chunk", "text": content})
            
            # Send completion signal
            await _send_json({"type": "llm_complete", "text": accumulated_text})
            
            # Print to console as requested
            print(f"\n=== LLM Response ===")
            print(f"User: {transcript}")
            print(f"Assistant: {accumulated_text}")
            print("==================\n")
            
            # Day 21: Stream LLM response to Murf and forward audio to client
            try:
                await stream_llm_to_murf_with_client_forwarding(accumulated_text, _send_json)
            except Exception as murf_error:
                print(f"Murf TTS Error: {str(murf_error)}")
                await _send_json({"type": "error", "detail": f"TTS error: {str(murf_error)}"})
            
        except Exception as e:
            await _send_json({"type": "error", "detail": f"LLM error: {str(e)}"})

    def on_error(_client, evt):
        detail = getattr(evt, "error", None) or str(evt)
        asyncio.run_coroutine_threadsafe(_send_json({"type": "error", "detail": detail}), loop)

    client = StreamingClient(StreamingClientOptions(api_key=ASSEMBLY_API_KEY))
    client.on(StreamingEvents.Begin, on_begin)
    client.on(StreamingEvents.Turn, on_turn)
    client.on(StreamingEvents.Error, on_error)

    params = StreamingParameters(sample_rate=16000, encoding=Encoding.pcm_s16le)

    def _connect():
        try:
            client.connect(params)
        except Exception as e:
            asyncio.run_coroutine_threadsafe(_send_json({"type": "error", "detail": str(e)}), loop)

    asyncio.get_running_loop().run_in_executor(None, _connect)

    try:
        while True:
            message = await ws.receive()
            if message.get("type") == "websocket.disconnect":
                break
            if message.get("bytes") is not None:
                if not session_ready.is_set():
                    # Drop audio until the realtime session is ready
                    continue
                # Expect raw PCM16 bytes from client
                try:
                    client.stream(message["bytes"])
                except Exception as e:
                    await _send_json({"type": "error", "detail": str(e)})
                continue
            text = message.get("text")
            if text and text.lower() in {"close", "stop", "end"}:
                break
    except WebSocketDisconnect:
        pass
    finally:
        try:
            client.disconnect(terminate=True)
        except Exception:
            pass
        try:
            await ws.close()
        except Exception:
            pass
