# The vision model

MiniCPM-V 4.7 1B, the **Model → MiniCPM-V 4.7 1B** choice in the Writing tools
panel, and the only one of the three that reads images: with it picked, the
panel adds **Describe image** and **Read text from image**. It is committed for
the same reason as Gemma one directory up: there is no download step and no
Hugging Face request at runtime.

Two files make it up, and the manifest lists them in the order the engine is
handed them: the language model, then the image projector that turns a
picture into tokens it can read. wllama runs both on WebGPU when the browser
has it and on the CPU otherwise.

## Where it came from

| | |
|---|---|
| Model | [MiniCPM-V 4.7 1B](https://huggingface.co/openbmb/MiniCPM-V-4.7-1B) by OpenBMB. The link the request named, [`MiniCPM-V-4.7-1B-int4`](https://huggingface.co/openbmb/MiniCPM-V-4.7-1B-int4), is the same model in bitsandbytes 4-bit, which only runs under PyTorch on CUDA |
| Quantization | Q4_K_M language model and an f16 projector (4× visual-token compression), in GGUF, OpenBMB's own: [`openbmb/MiniCPM-V-4.7-1B-gguf`](https://huggingface.co/openbmb/MiniCPM-V-4.7-1B-gguf) |
| Pinned revision | [`9684c734`](https://huggingface.co/openbmb/MiniCPM-V-4.7-1B-gguf/tree/9684c734cfb2e6aaccb0bb52ba58afa9aae92d90) |

| File | Bytes | SHA-256 |
|---|---|---|
| `MiniCPM-V-4_7-1B-Q4_K_M.gguf` | 672,003,680 | `588c6c94c82f756b86dba35c42ed9ba9ec187d65824eb52f039c347df563e63d` |
| `mmproj-model-f16-4x.gguf` | 901,033,888 | `1e0ab439877e6896ded59ff24cdd242fdffb236394f6fc4a5b019cbd60bb5f4a` |

Both digests were computed from the downloaded files and match the LFS object
ids Hugging Face publishes for them. `manifest.json` lists every 64 MiB
transport part with its own SHA-256.

It needs wllama built from `master` (see `vendor/README.md`): the 3.8.1
release does not know this projector.

## Licence

Apache-2.0, from OpenBMB; the full text is in `LICENSE`. The repository's MIT
licence does not cover this directory. The chunks are the published GGUFs
split on byte boundaries; the weights are not modified.
