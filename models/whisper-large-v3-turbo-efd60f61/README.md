# The large speech model

Whisper large v3 turbo, the **Model → Large v3 turbo** choice in the Speech
to text panel. It's committed for the same reason as
`../whisper-small-2d67713f/`: there is no download step and no Hugging Face
request at runtime. The first transcription with it pulls these files from
this deployment, the service worker keeps them, and every one after that
works offline.

It runs on the GPU and nowhere else. The encoder is half precision, so the
panel offers turbo only where `navigator.gpu` gives an adapter with
`shader-f16`. Everywhere else the option is shown, but disabled, and small is
used.

## Where it came from

| | |
|---|---|
| Model | [Whisper large v3 turbo](https://huggingface.co/openai/whisper-large-v3-turbo), multilingual, from OpenAI |
| Conversion | ONNX for transformers.js on WebGPU, by striimit: [`striimit/whisper-large-v3-turbo-webgpu`](https://huggingface.co/striimit/whisper-large-v3-turbo-webgpu) |
| Precision | encoder fp16, merged decoder 4-bit (`q4`, MatMulNBits); the repository's fp16 decoder is not shipped |
| Pinned revision | [`efd60f61`](https://huggingface.co/striimit/whisper-large-v3-turbo-webgpu/tree/efd60f6118de900bd94a445e43c99c934022b8ec) |

| File | Bytes | SHA-256 |
|---|---|---|
| `onnx/encoder_model_fp16.onnx` | 1,274,469,541 | `9148e5e04ed62668746358e17da135f4cff4941677a91779dbedede4d18d7000` |
| `onnx/decoder_model_merged_q4.onnx` | 375,485,638 | `af0c2e79f9ddf1b1a3d354ef37d112c8524de9548b9fc8201f10d2fe63e95a37` |

Both digests were computed from the downloaded files and match the LFS
object ids Hugging Face publishes for them. The five JSON files beside the
weights are that revision's, unchanged. They are the five the runtime asks
for.

## The chunks

There are 64 MiB parts, 19 for the encoder and 6 for the decoder, because
GitHub refuses files over 100 MB. Their names, sizes and SHA-256s are in
`manifest.json`, which `lib/whisper-worker.js` reads. It checks every chunk
as it arrives, and stitches each file back together only when the runtime
asks for it.

```sh
cat models/whisper-large-v3-turbo-efd60f61/onnx/encoder_model_fp16.part{1..19} | shasum -a 256
# 9148e5e04ed62668746358e17da135f4cff4941677a91779dbedede4d18d7000
cat models/whisper-large-v3-turbo-efd60f61/onnx/decoder_model_merged_q4.part{1..6} | shasum -a 256
# af0c2e79f9ddf1b1a3d354ef37d112c8524de9548b9fc8201f10d2fe63e95a37
```

(`part{1..19}` and not `part*`: the shell sorts `part10` before `part2`.)
`tests/unit/whisper.test.js` makes both checks, chunk by chunk and whole, on
every run. `WHISPER_MODEL=turbo npm run check:whisper` transcribes with it
for real, on a WebGPU adapter.

## Licence

MIT, from OpenAI. `openai/whisper-large-v3-turbo` and the striimit
conversion both state it, and the text is `LICENSE` in this directory. The
repository's own MIT licence doesn't cover this directory. The chunks are the
published files, split on byte boundaries and otherwise unmodified.

## Regenerating

```sh
REV=efd60f6118de900bd94a445e43c99c934022b8ec
for f in encoder_model_fp16 decoder_model_merged_q4; do
  curl -L -o $f.onnx https://huggingface.co/striimit/whisper-large-v3-turbo-webgpu/resolve/$REV/onnx/$f.onnx
  shasum -a 256 $f.onnx   # must print the digest in the table above
done
```

Then split each on 64 MiB boundaries into `.part1`, `.part2`, and so on,
hash each part, and rewrite `manifest.json` in the shape it already has. A
different revision goes in a **new directory**. The service worker's
`/models/` cache is cache-first and never versioned, as
`../whisper-small-2d67713f/README.md` explains.
