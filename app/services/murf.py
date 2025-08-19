import requests
from fastapi import HTTPException
from app.utils.config import MURF_API_KEY, MAX_MURF_CHARS, DEFAULT_VOICE

def split_for_tts(text: str, max_len: int = MAX_MURF_CHARS):
    import re
    chunks, current, cur_len = [], [], 0
    sentences = re.split(r'(?<=[.!?])\s+', text.strip())
    for s in sentences:
        if not s:
            continue
        if len(s) > max_len:
            for i in range(0, len(s), max_len):
                chunks.append(s[i:i+max_len])
            continue
        add = 1 if cur_len else 0
        if cur_len + len(s) + add <= max_len:
            current.append(s); cur_len += len(s) + add
        else:
            chunks.append(" ".join(current)); current=[s]; cur_len=len(s)
    if current:
        chunks.append(" ".join(current))
    return chunks

def murf_generate(text: str, voice_id: str = DEFAULT_VOICE) -> str:
    if not MURF_API_KEY:
        raise HTTPException(status_code=500, detail="Murf API key not configured")
    url = "https://api.murf.ai/v1/speech/generate"
    headers = {"Content-Type": "application/json", "api-key": MURF_API_KEY}
    payload = {"text": text, "voiceId": voice_id}
    r = requests.post(url, headers=headers, json=payload, timeout=45)
    try:
        r.raise_for_status()
    except requests.exceptions.RequestException as e:
        raise HTTPException(status_code=502, detail=f"Murf API error: {e}")
    audio_file = r.json().get("audioFile")
    if not audio_file:
        raise HTTPException(status_code=500, detail="No audioFile returned by Murf")
    return audio_file

def tts_chunked(text: str, voice_id: str = DEFAULT_VOICE):
    return [murf_generate(ch, voice_id) for ch in split_for_tts(text)]
