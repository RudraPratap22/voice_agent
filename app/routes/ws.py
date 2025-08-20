from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from datetime import datetime, timezone
import json

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
