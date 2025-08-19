from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from app.routes import tts, pipeline
from app.utils.config import STATIC_DIR

app = FastAPI()

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.include_router(tts.router)
app.include_router(pipeline.router)

@app.get("/")
async def root():
    return FileResponse(f"{STATIC_DIR}/index.html")
