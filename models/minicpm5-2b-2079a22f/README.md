# The writing model

MiniCPM5 2B, the **Model → MiniCPM5 2B** choice in the Writing tools panel. It
is committed for the same reason as Gemma one directory up: there is no
download step and no Hugging Face request at runtime. The first **Run** with it
pulls these chunks from this deployment, the service worker keeps them, and
every run after that works offline.

It is the strongest of the three writing models, and at 1.56 GB the largest
download. wllama runs it on WebGPU when the browser has it (about 13 tokens a
second on an Apple M-series GPU) and on the CPU otherwise (about 8).

## Where it came from

| | |
|---|---|
| Model | [MiniCPM5 2B](https://huggingface.co/openbmb/MiniCPM5-2B) by OpenBMB, a Llama-architecture model |
| Quantization | Q4_K_M in GGUF, OpenBMB's own: [`openbmb/MiniCPM5-2B-GGUF`](https://huggingface.co/openbmb/MiniCPM5-2B-GGUF) |
| Pinned revision | [`2079a22f`](https://huggingface.co/openbmb/MiniCPM5-2B-GGUF/tree/2079a22f3beaa4e306449978533478fe0522f4b3) |
| File | `MiniCPM5-2B-Q4_K_M.gguf`, 1,561,318,368 bytes |
| SHA-256 | `ec2d5801640099e97d8d7e8003ad4d81f336e757811f03a26173dddf386602fd` |

The digest was computed from the downloaded file and matches the LFS object id
Hugging Face publishes for it. `manifest.json` lists the 24 transport parts
(64 MiB apart, like Gemma's) with a SHA-256 each, which the loader checks as
they arrive.

The model reasons out loud before it answers unless its chat template is told
`enable_thinking: false`; `lib/gemma.js` always says so.

## Licence

Apache-2.0, from OpenBMB; the full text is in `LICENSE`. The repository's MIT
licence does not cover this directory. The chunks are the published GGUF split
on byte boundaries; the weights are not modified.
