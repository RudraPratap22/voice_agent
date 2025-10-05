import asyncio
import websockets
import json
import base64
from typing import AsyncGenerator
from app.utils.config import MURF_API_KEY, DEFAULT_VOICE


async def murf_websocket_tts(text: str, voice_id: str = DEFAULT_VOICE, context_id: str = "static_context") -> AsyncGenerator[str, None]:
    """
    Stream text to Murf WebSocket API and yield base64 encoded audio chunks.
    Uses static context_id to avoid context limit errors as per Day 20 requirements.
    """
    if not MURF_API_KEY:
        raise Exception("Murf API key not configured")
    
    # Correct Murf WebSocket URL with query parameters
    uri = f"wss://api.murf.ai/v1/speech/stream-input?api-key={MURF_API_KEY}&sample_rate=44100&channel_type=MONO&format=WAV"
    
    try:
        # Connect to Murf WebSocket
        async with websockets.connect(uri) as websocket:
            # Send voice configuration first
            voice_config = {
                "voice_config": {
                    "voiceId": voice_id,
                    "style": "Conversational",
                    "rate": 0,
                    "pitch": 0,
                    "variation": 1
                }
            }
            await websocket.send(json.dumps(voice_config))
            
            # Send text to synthesize
            text_msg = {
                "text": text,
                "end": True
            }
            await websocket.send(json.dumps(text_msg))
            
            # Receive audio chunks
            first_chunk = True
            async for message in websocket:
                try:
                    data = json.loads(message)
                    
                    if "audio" in data:
                        # Extract base64 audio data from Murf response
                        audio_data = data["audio"]
                        if audio_data:
                            # Collect chunks without spamming console
                            yield audio_data
                    
                    elif data.get("error"):
                        error_msg = data.get("error", "Unknown error")
                        print(f"Murf WebSocket Error: {error_msg}")
                        raise Exception(f"Murf error: {error_msg}")
                    
                    elif data.get("final"):
                        print("=== Murf TTS Complete ===")
                        break
                        
                except json.JSONDecodeError:
                    print(f"Invalid JSON from Murf: {message}")
                    continue
                    
    except websockets.exceptions.ConnectionClosed:
        print("Murf WebSocket connection closed")
        raise Exception("Murf WebSocket connection closed")
    except Exception as e:
        print(f"Murf WebSocket error: {str(e)}")
        raise Exception(f"Murf WebSocket error: {str(e)}")


async def stream_llm_to_murf_with_client_forwarding(llm_text: str, send_to_client, voice_id: str = DEFAULT_VOICE) -> None:
    """
    Stream LLM text to Murf and collect all base64 audio chunks.
    This function will be called after LLM streaming completes.
    """
    try:
        print(f"\n=== Sending to Murf TTS ===")
        print(f"Text: {llm_text}")
        print(f"Voice: {voice_id}")
        print("=============================")
        
        audio_chunks = []
        chunk_count = 0
        
        
        print(f"\n=== Day 22: Streaming Audio to Client ===")
        print(f"Starting audio stream to client for real-time playback...")
        
        async for base64_audio in murf_websocket_tts(llm_text, voice_id):
            audio_chunks.append(base64_audio)
            chunk_count += 1
            
            # Day 21: Stream each chunk to client immediately
            await send_to_client({
                "type": "audio_chunk", 
                "data": base64_audio,
                "chunk_number": chunk_count,
                "size": len(base64_audio)
            })
            
            # Print client acknowledgement
            print(f"Chunk {chunk_count}: Sent {len(base64_audio)} chars to client for playback")
        
        # Send completion signal to client
        await send_to_client({
            "type": "audio_complete",
            "total_chunks": len(audio_chunks),
            "total_size": sum(len(chunk) for chunk in audio_chunks)
        })
        
        print(f"\n=== Day 22: Audio Streaming & Playback Complete ===")
        print(f"Total chunks sent to client: {len(audio_chunks)}")
        print(f"Total audio data length: {sum(len(chunk) for chunk in audio_chunks)} characters")
        print(f"Client playback: Seamless streaming enabled")
        print(f"First chunk preview: {audio_chunks[0][:100] if audio_chunks else 'No data'}...")
        print("=====================================================")
        
    except Exception as e:
        print(f"Murf TTS Error: {str(e)}")


# Keep the old function for backward compatibility
async def stream_llm_to_murf(llm_text: str, voice_id: str = DEFAULT_VOICE) -> None:
    """
    Legacy function - now calls the new client-forwarding version with a no-op send function
    """
    async def no_op_send(data):
        pass
    
    await stream_llm_to_murf_with_client_forwarding(llm_text, no_op_send, voice_id)
