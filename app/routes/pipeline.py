from typing import Optional
from fastapi import APIRouter, UploadFile, File, Body, HTTPException
from pydantic import BaseModel
from app.services.asr import transcribe_bytes
from app.services.llm import chat
from app.services.murf import tts_chunked
from app.utils.config import DEFAULT_VOICE

router = APIRouter()

class LLMQueryRequest(BaseModel):
    prompt: str
    voiceId: Optional[str] = None

@router.post("/llm/query")
async def llm_query(
    file: Optional[UploadFile] = File(None),
    prompt: Optional[str] = None,
    json_body: Optional[LLMQueryRequest] = Body(None),
):
    if prompt is None and json_body is not None:
        prompt = json_body.prompt
        voice_id = json_body.voiceId or DEFAULT_VOICE
    else:
        voice_id = DEFAULT_VOICE

    transcribed_text = None
    if file is not None:
        audio_bytes = await file.read()
        transcribed_text = transcribe_bytes(audio_bytes)

    user_text = prompt or transcribed_text
    if not user_text or not user_text.strip():
        raise HTTPException(status_code=400, detail="Provide an audio file or a non-empty prompt")

    llm_text = chat(user_text)
    audio_urls = tts_chunked(llm_text, voice_id=voice_id)
    return {"transcript": transcribed_text, "llm_text": llm_text, "audio_urls": audio_urls}
