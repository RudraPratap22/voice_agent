import assemblyai as aai
from app.utils.config import ASSEMBLY_API_KEY

aai.settings.api_key = ASSEMBLY_API_KEY

def transcribe_bytes(audio_bytes: bytes, model: str = "slam_1") -> str:
    transcriber = aai.Transcriber()
    config = aai.TranscriptionConfig(speech_model=getattr(aai.SpeechModel, model))
    transcript = transcriber.transcribe(audio_bytes, config)
    if transcript.status == aai.TranscriptStatus.error:
        raise RuntimeError(f"Transcription failed: {transcript.error}")
    return transcript.text
