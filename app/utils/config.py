import os
from dotenv import load_dotenv

load_dotenv()

MURF_API_KEY = os.getenv("MURFAI_API_KEY")
ASSEMBLY_API_KEY = os.getenv("ASSEMBLYAI_API_KEY")
GROQ_API_KEY = os.getenv("GROQ_API_KEY")

MAX_MURF_CHARS = 3000
DEFAULT_VOICE = "en-US-natalie"
STATIC_DIR = os.getenv("STATIC_DIR", "app/static")
