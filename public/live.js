const TARGET_RATE = 24000;

export function startLive({ sessionId, onEvent }) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/api/interview/live/socket?sessionId=${encodeURIComponent(sessionId)}`);
  socket.binaryType = "arraybuffer";
  const audio = new AudioContext();
  let nextTime = 0;
  let stream;
  let closed = false;

  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    const type = String(payload.type ?? "");
    if (type.includes("audio") && type.endsWith("delta") && payload.delta) {
      playPcm16(audio, payload.delta, () => nextTime, (value) => {
        nextTime = value;
      });
    }
    if (payload.type === "hireme.await_playback") {
      const waitMs = Math.max(0, (nextTime - audio.currentTime) * 1000) + 300;
      setTimeout(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "hireme.playback_done" }));
      }, waitMs);
    }
    onEvent(payload);
  });

  socket.addEventListener("open", () => {
    void attachMic(socket, audio).then((opened) => {
      stream = opened;
    }).catch((error) => {
      onEvent({ type: "hireme.error", message: error instanceof Error ? error.message : "Microphone unavailable." });
    });
  });

  return {
    stop() {
      if (closed) return;
      closed = true;
      socket.close();
      stream?.getTracks().forEach((track) => track.stop());
      void audio.close();
    },
  };
}

async function attachMic(socket, audio) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  const source = audio.createMediaStreamSource(stream);
  const url = URL.createObjectURL(new Blob([workletSource()], { type: "application/javascript" }));
  await audio.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const node = new AudioWorkletNode(audio, "hireme-capture");
  const mute = audio.createGain();
  mute.gain.value = 0;
  node.port.onmessage = (event) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    const floats = downsample(event.data, audio.sampleRate, TARGET_RATE);
    socket.send(floatToPcm16(floats).buffer);
  };
  source.connect(node);
  node.connect(mute);
  mute.connect(audio.destination);
  return stream;
}

function workletSource() {
  return `class HiremeCapture extends AudioWorkletProcessor {
    process(inputs) {
      const channel = inputs[0] && inputs[0][0];
      if (channel) this.port.postMessage(channel);
      return true;
    }
  }
  registerProcessor("hireme-capture", HiremeCapture);`;
}

function downsample(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const length = Math.floor(input.length / ratio);
  const output = new Float32Array(length);
  for (let i = 0; i < length; i++) output[i] = input[Math.floor(i * ratio)] ?? 0;
  return output;
}

function floatToPcm16(floats) {
  const pcm = new Int16Array(floats.length);
  for (let i = 0; i < floats.length; i++) {
    const sample = Math.max(-1, Math.min(1, floats[i]));
    pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return pcm;
}

function playPcm16(audio, base64, getNext, setNext) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const view = bytes.byteLength % 2 === 0 ? bytes : bytes.slice(0, bytes.byteLength - 1);
  const pcm = new Int16Array(view.buffer, view.byteOffset, Math.floor(view.byteLength / 2));
  const floats = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) floats[i] = pcm[i] / 32768;
  const buffer = audio.createBuffer(1, floats.length, TARGET_RATE);
  buffer.copyToChannel(floats, 0);
  const node = audio.createBufferSource();
  node.buffer = buffer;
  node.connect(audio.destination);
  const start = Math.max(audio.currentTime + 0.05, getNext());
  node.start(start);
  setNext(start + buffer.duration);
}
