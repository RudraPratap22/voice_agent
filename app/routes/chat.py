from typing import Dict, List, Optional
from datetime import datetime
from fastapi import APIRouter, UploadFile, File, HTTPException, Form
from pydantic import BaseModel

from app.services.asr import transcribe_bytes
from app.services.llm import chat as llm_chat
from app.services.murf import tts_chunked
from app.utils.config import DEFAULT_VOICE

router = APIRouter()

# In-memory store: { session_id: [ {role, content, ts} ] }
ChatStore: Dict[str, List[Dict]] = {}
MAX_HISTORY = 20

class ChatMessage(BaseModel):
    role: str  # "user" | "assistant"
    content: str
    ts: float

class ChatResponse(BaseModel):
    session_id: str
    transcript: Optional[str]
    llm_text: str
    audio_urls: List[str]
    messages_tail: List[ChatMessage]
    playback_done_hint: bool = True

@router.post("/agent/chat/{session_id}", response_model=ChatResponse)
async def chat_with_history(
    session_id: str,
    file: UploadFile = File(...),
    voiceId: Optional[str] = Form(None),
):
    # 1) Transcribe audio
    audio_bytes = await file.read()
    transcript = transcribe_bytes(audio_bytes)
    user_text = (transcript or "").strip()
    if not user_text:
        raise HTTPException(status_code=400, detail="Transcription produced empty text")

    # 2) Init store
    if session_id not in ChatStore:
        ChatStore[session_id] = []

    # 3) Append user message
    ChatStore[session_id].append({"role": "user", "content": user_text, "ts": datetime.now().timestamp()})

    # 4) Build prompt for LLM using history
    # Simple history passing: join last messages with role headers
    
    history = ChatStore[session_id][-MAX_HISTORY:]
    prompt_with_history = []
    for m in history:
        prefix = "User:" if m["role"] == "user" else "Assistant:"
        prompt_with_history.append(f"{prefix} {m['content']}")
    # Add current user turn is already in history; ask LLM to continue
    joined = "\n".join(prompt_with_history) + "\nAssistant:"

    llm_text = llm_chat(joined)

    # 5) Append assistant message
    ChatStore[session_id].append({"role": "assistant", "content": llm_text, "ts": datetime.now().timestamp()})

    # 6) TTS
    urls = tts_chunked(llm_text, voice_id=(voiceId or DEFAULT_VOICE))

    # 7) Tail for UI
    tail = ChatStore[session_id][-10:]
    return ChatResponse(
        session_id=session_id,
        transcript=transcript,
        llm_text=llm_text,
        audio_urls=urls,
        messages_tail=[ChatMessage(**m) for m in tail],
        playback_done_hint=True,
    )

@router.get("/agent/chat/{session_id}/history")
def get_history(session_id: str):
    return {"messages": ChatStore.get(session_id, [])}
