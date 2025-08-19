from fastapi import APIRouter
from pydantic import BaseModel
from typing import Optional
from app.services.murf import murf_generate
from app.utils.config import DEFAULT_VOICE

router = APIRouter()

class TTSRequest(BaseModel):
    text: str
    voiceId: Optional[str] = None

@router.post("/generate-audio/")
async def generate_audio(req: TTSRequest):
    voice = req.voiceId or DEFAULT_VOICE
    url = murf_generate(req.text, voice_id=voice)
    return {"audio_file": url}
