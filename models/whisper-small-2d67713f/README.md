# The speech model

Whisper, for the **Speech to text** panel, committed for the same reason Gemma
is one directory up: there is no download step and no Hugging Face request at
runtime. The first transcription pulls these files from this deployment, the
service worker keeps them, and every one after that works offline.

`manifest.json` is the machine-readable copy of the facts below.
`lib/whisper-worker.js` reads it, fetches the chunks in order, checks every
chunk's SHA-256 as it arrives, and stitches them back into the two ONNX files
byte for byte before the runtime sees them.

## Where it came from

| | |
|---|---|
| Model | [Whisper small](https://huggingface.co/openai/whisper-small), multilingual, 244 million parameters, from OpenAI |
| Conversion | ONNX, by Xenova: [`Xenova/whisper-small`](https://huggingface.co/Xenova/whisper-small) |
| Quantization | 8-bit (`q8`, the `*_quantized.onnx` files) |
| Pinned revision | [`2d67713f`](https://huggingface.co/Xenova/whisper-small/tree/2d67713f236afa48a18992566e7647f6ca848e13) |

| File | Bytes | SHA-256 |
|---|---|---|
| `onnx/encoder_model_quantized.onnx` | 92,324,809 | `969f5ac12974340386bf7a02ea6626003e5e2dee396ffc6ab0eec282bf55ba06` |
| `onnx/decoder_model_merged_quantized.onnx` | 156,780,950 | `fcfc6100dc7339e7507e10f8b274350be7c4f8d8b575f0293f94cc0e156d6d24` |

Both digests were computed from the downloaded files and matched against
Hugging Face's own `X-Linked-ETag` for them, which for a large file is its
SHA-256.

The five JSON files beside the weights (`config.json`,
`generation_config.json`, `preprocessor_config.json`, `tokenizer.json`,
`tokenizer_config.json`) are that revision's, unchanged. They are the five the
runtime asks for; the repository's other tokenizer files are never requested
and are not here.

## The chunks

Sixty-four mebibytes apart, like Gemma's and for the same reason: GitHub
refuses files over 100 MB. They are transport parts of one file each and carry
no headers of their own.

| Path | Bytes | SHA-256 |
|---|---|---|
| `onnx/encoder_model_quantized.part1` | 67,108,864 | `c5c45f9b22c7481583169009c142ca097e028709489e3452b0f84652d28f3942` |
| `onnx/encoder_model_quantized.part2` | 25,215,945 | `9ee217850dd5730ace67a9c44ffc1a8eb8c43263ef2e5acd0ef93f5853638f74` |
| `onnx/decoder_model_merged_quantized.part1` | 67,108,864 | `7443fded2774bc46a371dba463da1c16b7587dfddc14983af9fbed4b18de0dac` |
| `onnx/decoder_model_merged_quantized.part2` | 67,108,864 | `cd92d475a1f2e54c7850fed1f1ca2d1cf21b7aece1dfa7787e41c5a8352ded1a` |
| `onnx/decoder_model_merged_quantized.part3` | 22,563,222 | `67ff18e1754707ea95ac7a659227ec1ba16bc28caca99be0680fd0e01fafe533` |

```sh
cat models/whisper-small-2d67713f/onnx/encoder_model_quantized.part* | shasum -a 256
# 969f5ac12974340386bf7a02ea6626003e5e2dee396ffc6ab0eec282bf55ba06
cat models/whisper-small-2d67713f/onnx/decoder_model_merged_quantized.part* | shasum -a 256
# fcfc6100dc7339e7507e10f8b274350be7c4f8d8b575f0293f94cc0e156d6d24
```

`tests/unit/whisper.test.js` makes both checks, chunk by chunk and whole, on
every run.

## Why the revision is in the directory name

The service worker answers `/models/` cache-first from a cache that is never
versioned, so that a release does not throw 500 MB of weights away. Gemma's
chunk names carry their version; `config.json` and `tokenizer.json` cannot.
The directory does it for them: a different model, or a different revision of
this one, goes in a **new directory**, and `MODEL` in `lib/whisper-worker.js`
is pointed at it. Never replace a file here in place - a browser that has
seen the old one will keep it.

## Licence

Apache-2.0, as the model cards of both
[`openai/whisper-small`](https://huggingface.co/openai/whisper-small) and
[`Xenova/whisper-small`](https://huggingface.co/Xenova/whisper-small) state;
the text is `LICENSE` in this directory. (OpenAI's
[code repository](https://github.com/openai/whisper) for Whisper is MIT; the
weights are published under the model card's licence.) The repository's own
MIT licence does not cover this directory. The chunks are the published files
split on byte boundaries and nothing else; the weights are not modified.

## Regenerating

```sh
REV=2d67713f236afa48a18992566e7647f6ca848e13
for f in encoder_model_quantized decoder_model_merged_quantized; do
  curl -L -o $f.onnx https://huggingface.co/Xenova/whisper-small/resolve/$REV/onnx/$f.onnx
  shasum -a 256 $f.onnx   # must print the digest in the table above
done
```

then split each on 64 MiB boundaries (`split -b 67108864`, renamed to
`.part1`, `.part2`, …), hash each part, and rewrite `manifest.json` in the
shape it already has. Chunk names and their hashes are a pair: renaming one
without rehashing it fails the loader's per-chunk check on purpose.
