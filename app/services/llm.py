from groq import Groq
from app.utils.config import GROQ_API_KEY

client = Groq(api_key=GROQ_API_KEY)

SYSTEM_MSG = (
    "You are a helpful AI assistant. Answer succinctly in your own words. "
    "Do not repeat the user's question. Keep responses under 3000 characters when possible."
)

def chat(prompt: str, model: str = "llama-3.3-70b-versatile", temperature: float = 0.7, max_tokens: int = 1024) -> str:
    out = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": SYSTEM_MSG},
            {"role": "user", "content": prompt},
        ],
        temperature=temperature,
        max_tokens=max_tokens,
    )
    return out.choices[0].message.content
