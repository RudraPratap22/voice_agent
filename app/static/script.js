document.addEventListener("DOMContentLoaded", () => {
  // Elements
  const chatBody = document.getElementById("chat-body"); // new target for bubbles
  const statusContainer = document.getElementById("status-container"); // kept for compatibility but unused for bubbles
  const composer = document.getElementById("composer-input");
  const sendBtn = document.getElementById("send-btn");

  const startRecordBtn = document.getElementById("start-record-btn");
  const stopRecordBtn = document.getElementById("stop-record-btn");

  // Legacy waveform refs (no-op but kept)
  const waveformLeft = document.getElementById("waveform-left");
  const waveformRight = document.getElementById("waveform-right");

  let mediaRecorder;
  let audioChunks = [];
  let ws; // websocket for streaming
  let isStreaming = false;
  let audioContext;
  let sourceNode;
  let processorNode;

  // Session handling via URL ?session_id=
  function getOrCreateSessionId() {
    const url = new URL(window.location);
    let sid = url.searchParams.get("session_id");
    if (!sid) {
      sid = crypto.randomUUID();
      url.searchParams.set("session_id", sid);
      window.history.replaceState({}, "", url);
    }
    return sid;
  }
  let SESSION_ID = getOrCreateSessionId();

  // Helpers (waveforms - optional)
  function populateWaveform(container) {
    if (!container) return;
    container.innerHTML = "";
    for (let i = 0; i < 25; i++) {
      const bar = document.createElement("div");
      bar.classList.add("waveform-bar");
      bar.style.animationDelay = `${Math.random() * -1.2}s`;
      container.appendChild(bar);
    }
  }
  function clearWaveforms() {
    if (waveformLeft) waveformLeft.innerHTML = "";
    if (waveformRight) waveformRight.innerHTML = "";
  }

  // Chat bubble helpers
  function appendBubble(text, role) {
    const el = document.createElement("div");
    el.className = `bubble ${role === "user" ? "bubble--user" : "bubble--bot"}`;
    el.textContent = text;
    chatBody.appendChild(el);
    chatBody.scrollTop = chatBody.scrollHeight;
    return el;
  }
  function appendTyping() {
    const el = document.createElement("div");
    el.className = "bubble bubble--bot";
    el.innerHTML =
      '<span class="typing"><span></span><span></span><span></span></span>';
    chatBody.appendChild(el);
    chatBody.scrollTop = chatBody.scrollHeight;
    return el;
  }
  function renderMessages(messages = []) {
    chatBody.innerHTML = "";
    messages.forEach((m) => appendBubble(m.content, m.role));
  }

  // Load existing history for this session
  async function loadHistory() {
    try {
      const r = await fetch(`/agent/chat/${SESSION_ID}/history`);
      const data = await r.json();
      renderMessages(data.messages || []);
    } catch {
      // ignore
    }
  }
  loadHistory();

  // Composer autosize
  if (composer) {
    const autosize = () => {
      composer.style.height = "auto";
      composer.style.height = Math.min(180, composer.scrollHeight) + "px";
    };
    composer.addEventListener("input", autosize);
    autosize();

    composer.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (sendBtn) sendBtn.click();
      }
    });
  }

  // Text send flow (kept: uses /llm/query)
  if (sendBtn && composer) {
    sendBtn.addEventListener("click", async () => {
      const prompt = (composer.value || "").trim();
      if (!prompt) return;

      appendBubble(prompt, "user");
      composer.value = "";
      composer.dispatchEvent(new Event("input"));

      const typingEl = appendTyping();
      try {
        const response = await fetch("/llm/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt }),
        });
        const data = await response.json();
        typingEl.remove();
        if (!response.ok) throw new Error(data.detail || "Failed");

        const llmText = (data.llm_text || "").trim();
        if (llmText) appendBubble(llmText, "bot");

        const urls = data.audio_urls || [];
        if (urls.length > 0) {
          for (const u of urls) {
            await new Promise((resolve, reject) => {
              const a = new Audio(u);
              a.addEventListener("ended", resolve);
              a.addEventListener("error", () =>
                reject(new Error("Audio playback error"))
              );
              a.play().catch(reject);
            });
          }
        }
      } catch (err) {
        typingEl.remove();
        appendBubble(`Error: ${err.message || "Request failed"}`, "bot");
      }
    });
  }

  // Helpers for PCM16 streaming
  function downsampleBuffer(buffer, inSampleRate, outSampleRate) {
    if (outSampleRate === inSampleRate) return buffer;
    if (outSampleRate > inSampleRate) throw new Error("Downsampling rate should be smaller than original");
    const sampleRateRatio = inSampleRate / outSampleRate;
    const newLength = Math.round(buffer.length / sampleRateRatio);
    const result = new Float32Array(newLength);
    let offsetResult = 0;
    let offsetBuffer = 0;
    while (offsetResult < result.length) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
      let accum = 0;
      let count = 0;
      for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
        accum += buffer[i];
        count++;
      }
      result[offsetResult] = accum / count;
      offsetResult++;
      offsetBuffer = nextOffsetBuffer;
    }
    return result;
  }

  function floatTo16BitPCM(float32Array) {
    const output = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      let s = Math.max(-1, Math.min(1, float32Array[i]));
      output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return output;
  }

  // Voice streaming over WebSocket (Day 17 - AssemblyAI Realtime)
  if (startRecordBtn) {
    startRecordBtn.addEventListener("click", async () => {
      if (isStreaming) return;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const scheme = location.protocol === "https:" ? "wss" : "ws";
        const url = `${scheme}://${location.host}/ws/transcribe`;

        ws = new WebSocket(url);
        ws.binaryType = "arraybuffer";

        ws.onopen = () => {
          appendBubble("Transcription started…", "bot");
        };
        ws.onmessage = (ev) => {
          try {
            const data = JSON.parse(ev.data);
            if (data && data.type === "ready") {
              appendBubble("Session ready.", "bot");
            } else if (data && (data.type === "partial" || data.type === "final")) {
              const role = data.type === "final" ? "bot" : "bot";
              appendBubble(`${data.type}: ${data.text}`, role);
            } else if (data && data.type === "turn_end") {
              appendBubble(`Turn ended: ${data.text}`, "bot");
            } else if (data && data.type === "llm_chunk") {
              // Stream LLM response chunks
              if (!window.currentLLMBubble) {
                window.currentLLMBubble = appendBubble("", "bot");
                window.currentLLMBubble.classList.add("llm-streaming");
              }
              window.currentLLMBubble.textContent += data.text;
            } else if (data && data.type === "llm_complete") {
              // Finalize LLM response
              if (window.currentLLMBubble) {
                window.currentLLMBubble.classList.remove("llm-streaming");
                window.currentLLMBubble = null;
              }
              appendBubble(`LLM Response: ${data.text}`, "bot");
              
              // Day 21: Initialize audio chunks array for this response
              window.currentAudioChunks = [];
              appendBubble("🎵 Starting audio stream...", "bot");
              
            } else if (data && data.type === "audio_chunk") {
              // Day 22: Play streaming audio chunks in real-time
              if (!window.currentAudioChunks) {
                window.currentAudioChunks = [];
                window.audioContext = null;
                window.audioQueue = [];
                window.isPlaying = false;
              }
              
              window.currentAudioChunks.push(data.data);
              appendBubble(`🎵 Audio chunk ${data.chunk_number}: ${data.size} chars`, "bot");
              
              // Day 22: Play audio chunk immediately with error handling
              try {
                playAudioChunk(data.data);
              } catch (error) {
                console.error("Error playing audio chunk:", error);
                appendBubble(`🔇 Audio chunk ${data.chunk_number} failed`, "bot");
              }
              
            } else if (data && data.type === "audio_complete") {
              // Day 22: Audio streaming complete - trigger final playback
              const totalChunks = data.total_chunks;
              const totalSize = data.total_size;
              appendBubble(`🎵 Audio complete! ${totalChunks} chunks, ${totalSize.toLocaleString()} chars`, "bot");
              appendBubble(`🔊 Playing complete audio seamlessly...`, "bot");
              
              // Trigger final concatenated playback
              if (window.audioChunks && window.audioChunks.length > 0) {
                setTimeout(() => {
                  playConcatenatedAudio();
                }, 100);
              }
              
              // Log to console as required by Day 21 & 22
              console.log("=== Day 22: Streaming Audio Playback Complete ===");
              console.log(`Total chunks received: ${totalChunks}`);
              console.log(`Total audio data: ${totalSize} characters`);
              console.log(`Audio playback: Concatenated seamless streaming`);
              console.log(`First chunk preview: ${window.currentAudioChunks[0]?.substring(0, 100)}...`);
              console.log("=================================================");
              
              window.currentAudioChunks = null;
              
            } else if (data && data.type === "error") {
              appendBubble(`error: ${data.detail || "unknown"}`, "bot");
            }
          } catch (_) {
            // ignore non-JSON
          }
        };
        ws.onerror = () => {
          appendBubble("WebSocket error.", "bot");
        };
        ws.onclose = () => {
          appendBubble("Transcription stopped.", "bot");
        };

        // Setup WebAudio capture -> PCM16 @16kHz (working approach)
        audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        sourceNode = audioContext.createMediaStreamSource(stream);
        
        // Use ScriptProcessorNode with larger buffer size to meet AssemblyAI requirements
        const bufferSize = 4096; // Larger buffer for longer duration
        processorNode = audioContext.createScriptProcessor(bufferSize, 1, 1);
        
        // Buffer audio data to send larger chunks
        let audioBuffer = [];
        const targetDuration = 100; // 100ms chunks
        
        processorNode.onaudioprocess = (e) => {
          try {
            if (!ws || ws.readyState !== WebSocket.OPEN) return;
            
            const input = e.inputBuffer.getChannelData(0);
            const resampled = downsampleBuffer(input, audioContext.sampleRate, 16000);
            const pcm16 = floatTo16BitPCM(resampled);
            
            // Add to buffer
            audioBuffer.push(pcm16);
            
            // Send when we have enough data for target duration
            if (audioBuffer.length >= 3) { // ~100ms worth of data
              const combinedBuffer = new Int16Array(audioBuffer.length * audioBuffer[0].length);
              let offset = 0;
              for (const chunk of audioBuffer) {
                combinedBuffer.set(chunk, offset);
                offset += chunk.length;
              }
              
              ws.send(combinedBuffer.buffer);
              audioBuffer = []; // Reset buffer
            }
          } catch (error) {
            console.warn("Audio processing warning:", error);
          }
        };
        
        sourceNode.connect(processorNode);
        processorNode.connect(audioContext.destination);

        isStreaming = true;
        startRecordBtn.disabled = true;
        if (stopRecordBtn) stopRecordBtn.disabled = false;
      } catch (error) {
        console.error("Error accessing microphone:", error);
        alert("Microphone access is required. Please allow access and refresh the page.");
      }
    });
  }

  if (stopRecordBtn) {
    stopRecordBtn.addEventListener("click", () => {
      try { if (processorNode) processorNode.disconnect(); } catch {}
      try { if (sourceNode) sourceNode.disconnect(); } catch {}
      try { if (audioContext) audioContext.close(); } catch {}
      try { if (ws && ws.readyState === WebSocket.OPEN) ws.send("close"); } catch {}
      try { if (ws) ws.close(); } catch {}
      if (startRecordBtn) startRecordBtn.disabled = false;
      if (stopRecordBtn) stopRecordBtn.disabled = true;
      isStreaming = false;
    });
  }
});

// Day 22: Audio playback functions for streaming audio
async function playAudioChunk(base64Data) {
  try {
    // Initialize audio system
    if (!window.audioChunks) {
      window.audioChunks = [];
      window.isPlaying = false;
      window.currentAudio = null;
    }
    
    // Add chunk to collection
    window.audioChunks.push(base64Data);
    
    // If this is the first chunk, start playing immediately
    if (!window.isPlaying) {
      window.isPlaying = true;
      playConcatenatedAudio();
    }
    
  } catch (error) {
    console.error("Audio playback error:", error);
    appendBubble(`🔇 Audio error: ${error.message}`, "bot");
  }
}

async function playConcatenatedAudio() {
  try {
    console.log("Starting concatenated audio playback...");
    
    // Wait a bit for more chunks to arrive
    await new Promise(resolve => setTimeout(resolve, 500));
    
    console.log(`Processing ${window.audioChunks.length} audio chunks`);
    
    // Decode each chunk individually and concatenate binary data
    const allBinaryData = [];
    let totalSize = 0;
    
    for (let i = 0; i < window.audioChunks.length; i++) {
      try {
        const chunkBase64 = window.audioChunks[i];
        const binaryString = atob(chunkBase64);
        const bytes = new Uint8Array(binaryString.length);
        for (let j = 0; j < binaryString.length; j++) {
          bytes[j] = binaryString.charCodeAt(j);
        }
        allBinaryData.push(bytes);
        totalSize += bytes.length;
        console.log(`Processed chunk ${i + 1}: ${bytes.length} bytes`);
      } catch (error) {
        console.error(`Error processing chunk ${i + 1}:`, error);
        // Skip this chunk and continue
      }
    }
    
    console.log(`Total binary data: ${totalSize} bytes from ${allBinaryData.length} chunks`);
    
    // Concatenate all binary data
    const finalBytes = new Uint8Array(totalSize);
    let offset = 0;
    for (const bytes of allBinaryData) {
      finalBytes.set(bytes, offset);
      offset += bytes.length;
    }
    
    // Create blob and play
    const blob = new Blob([finalBytes], { type: 'audio/wav' });
    const audioUrl = URL.createObjectURL(blob);
    const audio = new Audio(audioUrl);
    
    audio.volume = 1.0;
    audio.preload = 'auto';
    
    // Play the concatenated audio
    audio.oncanplay = () => {
      audio.play().then(() => {
        console.log("Concatenated audio playing successfully");
      }).catch(error => {
        console.error("Audio play error:", error);
      });
    };
    
    audio.onended = () => {
      URL.revokeObjectURL(audioUrl);
      window.isPlaying = false;
      console.log("Audio playback complete");
    };
    
    audio.onerror = (error) => {
      console.error("Audio error:", error);
      URL.revokeObjectURL(audioUrl);
      window.isPlaying = false;
    };
    
    audio.load();
    
  } catch (error) {
    console.error("Concatenated audio error:", error);
    window.isPlaying = false;
  }
}

// Legacy function removed - using concatenated playback instead
