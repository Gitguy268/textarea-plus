# The model

The point of this directory is that there is no download step: the weights a
reader runs on are committed next to the code that runs them, so a first visit
opens the tools, presses **Run**, and inference starts — offline after
the page has been seen once, with no Hugging Face request and no file picker
anywhere in the flow.

`manifest.json` is the machine-readable copy of the facts below: the loader
reads it, fetches the chunks in order, checks every chunk's SHA-256 as it
arrives, and concatenates them back into the original GGUF byte for byte.

## Where it came from

| | |
|---|---|
| Model | [Gemma 3 270M](https://ai.google.dev/gemma) (instruction tuned) |
| Quantization | Q4_K_M in GGUF — the usual 4-bit k-quant, 241 MiB of weights |
| Source | [`lm-kit/gemma-3-270m-instruct-gguf`](https://huggingface.co/lm-kit/gemma-3-270m-instruct-gguf) |
| Pinned revision | [`9716b81c`](https://huggingface.co/lm-kit/gemma-3-270m-instruct-gguf/tree/9716b81cf25730f7df1aadc7f4e97b900e6ef9c3) |
| File | `gemma-3-270M-it-Q4_K_M.gguf`, 253,114,976 bytes |
| SHA-256 | `e28b323bc75925d6edc8d3f030268830bf53c59c296d77278ac24653403d9d47` |

That digest was computed from the downloaded file and then matched against
Hugging Face's own `X-Linked-ETag` for it, which for a large-file pointer *is*
the SHA-256 — so the bytes here are the bytes the uploader published, not just
the bytes one download happened to produce.

## The chunks

Sixty-four mebibytes apart, because GitHub refuses files over 100 MB and other
hosts are stricter still. These are **transport parts of one file**, not
llama.cpp's split-GGUF format: they carry no headers of their own, and nothing
but the concatenation is ever a valid model.

| Path | Bytes | SHA-256 |
|---|---|---|
| `gemma-3-270M-it-Q4_K_M.part1` | 67,108,864 | `b9c8c9737ad679e7125b39e84e9498a5409df0c6fd94e3a93aa34220c6775030` |
| `gemma-3-270M-it-Q4_K_M.part2` | 67,108,864 | `9ba7cee3cb9e4d3070df958a742e220b4768e30fe467aa0364545c5647536684` |
| `gemma-3-270M-it-Q4_K_M.part3` | 67,108,864 | `45416661d1c66620de29490a6c9fa248655ce483bb45c324f38a1288fa05affa` |
| `gemma-3-270M-it-Q4_K_M.part4` | 51,788,384 | `651e9ac43d0caae41227117f71212478af80cd35f90e2e53daa9ea7b11849113` |

The whole-file digest above is the check that stitching is faithful:

```sh
cat models/*.part* | shasum -a 256
# e28b323bc75925d6edc8d3f030268830bf53c59c296d77278ac24653403d9d47
```

## How the app treats them

The service worker never precaches these — 253 MB of model does not belong in
an install event. They are ordinary same-origin GETs that the SW caches the
first time **Run** pulls them, so the second run works offline; the
chunk filenames carry the version, which is why that cache never has to be
blown away to see a new model.

## Licence

The weights are Gemma 3, from Google, distributed under the
[Gemma Terms of Use](https://ai.google.dev/gemma/terms) — which permit
sharing the model and quantized derivatives of it, including this one, with
attribution. The GGUF conversion is lm-kit's; the terms that govern the
weights follow them back to Google either way. Keep this file next to the
chunks: it is the attribution and the provenance record together.

The repository's MIT licence does not cover this directory. Three files here
are what section 3.1 of the terms asks a redistributor to pass on, and they
must stay beside the chunks wherever the chunks are served from:

| File | What it is |
|---|---|
| `NOTICE` | The notice sentence the terms prescribe, word for word |
| `GEMMA_TERMS.md` | A copy of the Gemma Terms of Use |
| `GEMMA_PROHIBITED_USE_POLICY.md` | The use restrictions of section 3.2, which apply to everyone who uses these weights |

The chunks are the published GGUF split on byte boundaries and nothing else;
the weights themselves are not modified.

## Regenerating

```sh
curl -L -o model.gguf \
  https://huggingface.co/lm-kit/gemma-3-270m-instruct-gguf/resolve/9716b81cf25730f7df1aadc7f4e97b900e6ef9c3/gemma-3-270M-it-Q4_K_M.gguf
shasum -a 256 model.gguf   # must print the whole-file digest above
```

then split on 64 MiB boundaries (`head -c 67108864`, three times, with the
remainder fourth), hash each part, and rewrite `manifest.json` in the shape it
already has. Chunk names and their hashes are a pair: renaming one without
rehashing it will fail the loader's per-chunk check on purpose.
