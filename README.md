# Voxpod

Local text-to-speech in a Podman container. Record a short sample of your own voice, save it as a voice profile, then type text and hear it spoken in that voice.

The speech model is downloaded while the image is built and stored inside the image. Running the app does not contact the network for model files. The image is based on Red Hat Hardened Images Python 3.11 and starts as user 65532, with no shell and no package manager.

A saved voice is a profile built from your recording (a reference clip plus the features the model needs). It is not a gradient fine-tune of the neural net, which would need a GPU and a large dataset. One clear sample is enough to speak new text in that voice.

Use only a voice you have the right to use.

## Build

The build needs network access once.

```sh
podman build -t voxpod -f Containerfile .
```

The image is large (PyTorch, LuxTTS, and Whisper tiny). Give the Podman machine several gigabytes of disk and at least 6 GB of RAM.

## Run

```sh
podman volume create voxpod-data
podman run -d --name voxpod \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
  --tmpfs /opt/hf/hub/.locks:rw,nosuid,nodev,mode=1777 \
  -p 127.0.0.1:8085:8085 \
  -v voxpod-data:/data:U \
  localhost/voxpod
```

Open http://127.0.0.1:8085 . The first start loads the model on CPU and can take a minute. The page says when it is ready.

Voice profiles stay in the `voxpod-data` volume. `:U` gives that volume to the container user (65532), which keeps an existing volume writable after this image change.

The root filesystem is read-only. The process can write voice files on the volume, temporary files on `/tmp`, and cache locks under `/opt/hf/hub/.locks`. Model weights stay read-only. The image sets `HF_HUB_OFFLINE=1`, so it does not download models. Publish the port on localhost only.

## Use

1. Read the sample line for about 8–15 seconds, in a quiet room, or upload a wav/mp3 of that length.
2. Name the voice and save it. Saving transcribes the clip locally and stores the voice profile.
3. Select that voice, type up to 500 characters, and press Speak.

Choose English or Chinese to match the recording. The model reads those two languages. A sentence usually comes back faster than realtime on CPU; the first request after startup is slower.

## What is inside

- [LuxTTS](https://github.com/ysharma3501/LuxTTS) (`YatharthS/LuxTTS`, Apache-2.0) for cloning and speech
- [Whisper tiny](https://huggingface.co/openai/whisper-tiny) to transcribe the sample on this machine
- A small web app in `app/`
