const statusEl = document.querySelector("#status");
const statusText = document.querySelector("#status-text");
const recordBtn = document.querySelector("#record");
const recordLabel = recordBtn.querySelector("[data-label]");
const timerEl = document.querySelector("#timer");
const timerText = document.querySelector("#timer-text");
const recordError = document.querySelector("#record-error");
const preview = document.querySelector("#preview");
const previewAudio = document.querySelector("#preview-audio");
const sampleLanguage = document.querySelector("#sample-language");
const scriptEl = document.querySelector("#script");
const voiceName = document.querySelector("#voice-name");
const ownVoice = document.querySelector("#own-voice");
const saveBtn = document.querySelector("#save-voice");
const discardBtn = document.querySelector("#discard");
const uploadInput = document.querySelector("#upload");
const voiceList = document.querySelector("#voice-list");
const samplePlayer = document.querySelector("#sample-player");
const voiceSelect = document.querySelector("#voice-select");
const transcriptEl = document.querySelector("#transcript");
const transcriptText = document.querySelector("#transcript-text");
const textEl = document.querySelector("#text");
const countEl = document.querySelector("#count");
const speedEl = document.querySelector("#speed");
const speakBtn = document.querySelector("#speak");
const speakError = document.querySelector("#speak-error");
const resultAudio = document.querySelector("#result");

const MAX_RECORD_MS = 20000;
let mediaStream = null;
let recorder = null;
let chunks = [];
let recordStarted = 0;
let timerHandle = 0;
let pendingBlob = null;
let voices = [];
let modelReady = false;

function showError(el, message) {
  const text = el.querySelector("[data-alert-text]");
  el.hidden = !message;
  text.textContent = message || "";
}

function setStatus(text, kind) {
  statusText.textContent = text;
  statusEl.className = "pf-v6-c-label pf-m-outline pf-m-compact";
  if (kind === "ready") statusEl.classList.add("pf-m-green");
  else if (kind === "bad") statusEl.classList.add("pf-m-red");
  else statusEl.classList.add("pf-m-blue");
}

function setButtonBusy(button, busy, busyText, idleText) {
  const label = button.querySelector("[data-label]");
  label.textContent = busy ? busyText : idleText;
  button.classList.toggle("pf-m-in-progress", busy);
  button.setAttribute("aria-busy", busy ? "true" : "false");
}

function setRecordingUi(recording) {
  recordLabel.textContent = recording ? "Stop" : "Record";
  recordBtn.classList.toggle("pf-m-danger", recording);
  timerEl.hidden = !recording;
}

async function readError(response) {
  try {
    const body = await response.json();
    return body.detail || "Something went wrong.";
  } catch (_err) {
    return "Something went wrong.";
  }
}

async function refreshStatus() {
  try {
    const response = await fetch("/api/status");
    const body = await response.json();
    modelReady = Boolean(body.ready);
    if (body.error) {
      setStatus("Model failed to load", "bad");
      showError(speakError, body.error);
    } else if (body.ready) {
      setStatus("Ready — running locally", "ready");
    } else {
      setStatus("Loading the speech model…");
    }
  } catch (_err) {
    setStatus("Cannot reach Voxpod", "bad");
  }
  if (!speakBtn.classList.contains("pf-m-in-progress")) speakBtn.disabled = !modelReady;
  if (!saveBtn.classList.contains("pf-m-in-progress")) saveBtn.disabled = !modelReady;
}

async function refreshVoices() {
  const response = await fetch("/api/voices");
  const body = await response.json();
  voices = body.voices || [];
  const selected = voiceSelect.value;
  voiceSelect.replaceChildren();
  if (!voices.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No voice yet";
    voiceSelect.append(option);
  }
  for (const voice of voices) {
    const option = document.createElement("option");
    option.value = voice.id;
    option.textContent = voice.name;
    voiceSelect.append(option);
  }
  if (voices.some((voice) => voice.id === selected)) {
    voiceSelect.value = selected;
  } else if (voices.length) {
    voiceSelect.value = voices[0].id;
  }
  renderVoiceList();
  showTranscript();
}

function actionButton(label, variant, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pf-v6-c-button pf-m-small " + variant;
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function renderVoiceList() {
  voiceList.replaceChildren();
  if (!voices.length) {
    const empty = document.createElement("div");
    empty.className = "pf-v6-c-empty-state pf-m-sm";
    const content = document.createElement("div");
    content.className = "pf-v6-c-empty-state__content";
    const icon = document.createElement("div");
    icon.className = "pf-v6-c-empty-state__icon";
    const iconGlyph = document.createElement("i");
    iconGlyph.className = "fas fa-microphone";
    iconGlyph.setAttribute("aria-hidden", "true");
    icon.append(iconGlyph);
    const title = document.createElement("h2");
    title.className = "pf-v6-c-empty-state__title-text";
    title.textContent = "No saved voices yet.";
    const body = document.createElement("div");
    body.className = "pf-v6-c-empty-state__body";
    body.textContent = "Record a sample or upload a recording to keep a voice on this computer.";
    content.append(icon, title, body);
    empty.append(content);
    voiceList.append(empty);
    return;
  }

  const list = document.createElement("ul");
  list.className = "pf-v6-c-data-list";
  list.setAttribute("role", "list");
  list.setAttribute("aria-label", "Saved voices");
  for (const voice of voices) {
    const nameId = "voice-label-" + voice.id;
    const item = document.createElement("li");
    item.className = "pf-v6-c-data-list__item";
    item.setAttribute("aria-labelledby", nameId);

    const row = document.createElement("div");
    row.className = "pf-v6-c-data-list__item-row";
    const itemContent = document.createElement("div");
    itemContent.className = "pf-v6-c-data-list__item-content";

    const nameCell = document.createElement("div");
    nameCell.className = "pf-v6-c-data-list__cell";
    nameCell.id = nameId;
    const nameText = document.createElement("span");
    nameText.className = "pf-v6-c-data-list__cell-text";
    nameText.textContent = voice.name;
    const metaText = document.createElement("div");
    metaText.className = "voxpod-voice-meta";
    metaText.textContent = voice.duration_sec + "s";
    nameCell.append(nameText, metaText);
    itemContent.append(nameCell);

    const itemAction = document.createElement("div");
    itemAction.className = "pf-v6-c-data-list__item-action";
    const actions = document.createElement("div");
    actions.className = "voxpod-actions";
    actions.append(
      actionButton("Use", "pf-m-secondary", () => {
        voiceSelect.value = voice.id;
        showTranscript();
        textEl.focus();
      }),
      actionButton("Sample", "pf-m-link", () => {
        samplePlayer.hidden = false;
        samplePlayer.src = "/api/voices/" + voice.id + "/sample";
        samplePlayer.play();
      }),
      actionButton("Delete", "pf-m-link voxpod-danger", async () => {
        if (!window.confirm("Delete " + voice.name + "?")) return;
        const response = await fetch("/api/voices/" + voice.id, { method: "DELETE" });
        if (!response.ok) {
          showError(recordError, await readError(response));
          return;
        }
        await refreshVoices();
      })
    );
    itemAction.append(actions);
    row.append(itemContent, itemAction);
    item.append(row);
    list.append(item);
  }
  voiceList.append(list);
}

function showTranscript() {
  const voice = voices.find((item) => item.id === voiceSelect.value);
  if (!voice || !voice.transcript) {
    transcriptEl.hidden = true;
    transcriptText.textContent = "";
    return;
  }
  transcriptEl.hidden = false;
  transcriptText.textContent = voice.transcript;
}

const themeToggle = document.querySelector("#theme-toggle");
const themeLabel = document.querySelector("#theme-label");

function applyTheme(dark) {
  document.documentElement.classList.toggle("pf-v6-theme-dark", dark);
  themeToggle.checked = dark;
  themeToggle.setAttribute("aria-checked", dark ? "true" : "false");
  themeLabel.textContent = dark ? "Light mode" : "Dark mode";
  try {
    localStorage.setItem("voxpod-theme", dark ? "dark" : "light");
  } catch (_err) {}
}

themeToggle.addEventListener("change", () => applyTheme(themeToggle.checked));
applyTheme(document.documentElement.classList.contains("pf-v6-theme-dark"));

function stopTracks() {
  if (mediaStream) {
    for (const track of mediaStream.getTracks()) track.stop();
  }
  mediaStream = null;
}

function resetPreview() {
  pendingBlob = null;
  preview.hidden = true;
  previewAudio.removeAttribute("src");
  previewAudio.load();
  voiceName.value = "";
  ownVoice.checked = false;
  uploadInput.value = "";
}

function showPreview(blob) {
  pendingBlob = blob;
  preview.hidden = false;
  previewAudio.src = URL.createObjectURL(blob);
  showError(recordError, "");
}

function formatTimer(ms) {
  const seconds = Math.floor(ms / 1000);
  return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
}

async function startRecording() {
  showError(recordError, "");
  resetPreview();
  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  chunks = [];
  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "";
  recorder = new MediaRecorder(mediaStream, mime ? { mimeType: mime } : undefined);
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size) chunks.push(event.data);
  });
  recorder.addEventListener("stop", () => {
    stopTracks();
    const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
    showPreview(blob);
    setRecordingUi(false);
    window.clearInterval(timerHandle);
  });
  recorder.start();
  recordStarted = Date.now();
  setRecordingUi(true);
  timerText.textContent = "0:00";
  timerHandle = window.setInterval(() => {
    const elapsed = Date.now() - recordStarted;
    timerText.textContent = formatTimer(elapsed);
    if (elapsed >= MAX_RECORD_MS && recorder && recorder.state === "recording") {
      recorder.stop();
    }
  }, 200);
}

const SCRIPTS = {
  en: "The quick brown fox jumps over the lazy dog. I am recording this sample so this computer can speak new sentences in my voice, with the same pace and tone.",
  zh: "今天天气很好。我在录一段自己的声音，让这台电脑以后用我的声音读出新的句子。",
};

document.querySelector("#voice-form").addEventListener("submit", (event) => event.preventDefault());
document.querySelector("#speak-form").addEventListener("submit", (event) => event.preventDefault());

sampleLanguage.addEventListener("change", () => {
  scriptEl.textContent = SCRIPTS[sampleLanguage.value] || SCRIPTS.en;
});

recordBtn.addEventListener("click", async () => {
  showError(recordError, "");
  if (recorder && recorder.state === "recording") {
    recorder.stop();
    return;
  }
  try {
    await startRecording();
  } catch (_err) {
    setRecordingUi(false);
    showError(recordError, "Microphone access was blocked. Allow it for this page, or upload a file.");
  }
});

discardBtn.addEventListener("click", () => {
  resetPreview();
  showError(recordError, "");
});

document.querySelector("#upload-trigger").addEventListener("click", () => uploadInput.click());

uploadInput.addEventListener("change", () => {
  const file = uploadInput.files && uploadInput.files[0];
  if (!file) return;
  showPreview(file);
});

saveBtn.addEventListener("click", async () => {
  showError(recordError, "");
  if (!pendingBlob) {
    showError(recordError, "Record or upload a sample first.");
    return;
  }
  if (!ownVoice.checked) {
    showError(recordError, "Confirm this is your voice, or a voice you have permission to use.");
    return;
  }
  const name = voiceName.value.trim();
  if (!name) {
    showError(recordError, "Give the voice a name.");
    return;
  }
  const body = new FormData();
  body.append("name", name);
  body.append("language", sampleLanguage.value);
  const filename = pendingBlob.name || "sample.webm";
  body.append("audio", pendingBlob, filename);
  saveBtn.disabled = true;
  setButtonBusy(saveBtn, true, "Saving…", "Save voice");
  try {
    const response = await fetch("/api/voices", { method: "POST", body });
    if (!response.ok) {
      showError(recordError, await readError(response));
      return;
    }
    const saved = await response.json();
    resetPreview();
    await refreshVoices();
    voiceSelect.value = saved.id;
    showTranscript();
  } catch (_err) {
    showError(recordError, "Could not save the voice.");
  } finally {
    setButtonBusy(saveBtn, false, "Saving…", "Save voice");
    saveBtn.disabled = !modelReady;
  }
});

voiceSelect.addEventListener("change", showTranscript);

textEl.addEventListener("input", () => {
  countEl.textContent = String(textEl.value.length);
});

speakBtn.addEventListener("click", speak);
textEl.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") speak();
});

async function speak() {
  showError(speakError, "");
  if (!voiceSelect.value) {
    showError(speakError, "Save a voice first.");
    return;
  }
  const text = textEl.value.trim();
  if (!text) {
    showError(speakError, "Enter some text to speak.");
    return;
  }
  speakBtn.disabled = true;
  setButtonBusy(speakBtn, true, "Speaking…", "Speak");
  try {
    const response = await fetch("/api/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        voice_id: voiceSelect.value,
        text,
        speed: Number(speedEl.value),
      }),
    });
    if (!response.ok) {
      showError(speakError, await readError(response));
      return;
    }
    const blob = await response.blob();
    resultAudio.hidden = false;
    resultAudio.src = URL.createObjectURL(blob);
    await resultAudio.play();
  } catch (_err) {
    showError(speakError, "Could not play the speech.");
  } finally {
    setButtonBusy(speakBtn, false, "Speaking…", "Speak");
    speakBtn.disabled = !modelReady;
  }
}

refreshStatus();
refreshVoices().catch(() => showError(recordError, "Could not load saved voices."));
window.setInterval(refreshStatus, 2000);
