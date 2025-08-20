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

  // Voice flow (uses chat-history endpoint)
  if (startRecordBtn) {
    startRecordBtn.addEventListener("click", async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];

        mediaRecorder.addEventListener("dataavailable", (event) => {
          audioChunks.push(event.data);
        });

        mediaRecorder.addEventListener("stop", async () => {
          const audioBlob = new Blob(audioChunks, { type: "audio/wav" });
          const formData = new FormData();
          formData.append("file", audioBlob, "recording.wav");

          const typingEl = appendTyping();
          try {
            const response = await fetch(`/agent/chat/${SESSION_ID}`, {
              method: "POST",
              body: formData,
            });
            const data = await response.json();
            typingEl.remove();
            if (!response.ok) throw new Error(data.detail || "Pipeline failed");

            // server returns messages_tail; render as authoritative thread
            if (Array.isArray(data.messages_tail)) {
              renderMessages(data.messages_tail);
            } else {
              // fallback: append items if tail not present
              const transcript = (data.transcript || "").trim();
              const llmText = (data.llm_text || "").trim();
              if (transcript) appendBubble(transcript, "user");
              if (llmText) appendBubble(llmText, "bot");
            }

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
            appendBubble(`Error: ${err.message || "Pipeline failed"}`, "bot");
          }
        });

        mediaRecorder.start();
        startRecordBtn.disabled = true;
        if (stopRecordBtn) stopRecordBtn.disabled = false;
      } catch (error) {
        console.error("Error accessing microphone:", error);
        alert(
          "Microphone access is required. Please allow access and refresh the page."
        );
      }
    });
  }

  if (stopRecordBtn) {
    stopRecordBtn.addEventListener("click", () => {
      if (mediaRecorder && mediaRecorder.state === "recording") {
        mediaRecorder.stop();
      }
      if (startRecordBtn) startRecordBtn.disabled = false;
      if (stopRecordBtn) stopRecordBtn.disabled = true;
    });
  }
});
