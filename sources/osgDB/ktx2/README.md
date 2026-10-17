# msc_basis_transcoder

Basis Universal transcoder used by `osgDB/KTX2Reader` to turn the ETC1S/BasisLZ and UASTC 4x4
payloads of a `.ktx2` file into a format the WebGL context supports (BC7/BPTC, ASTC 4x4,
DXT/S3TC, ETC2, or RGBA32 as a fallback).

## Files

| File | What it is |
| --- | --- |
| `msc_basis_transcoder.js` | Upstream emscripten glue, unmodified. Reference copy, not imported. |
| `msc_basis_transcoder.wasm` | Upstream wasm module, unmodified. Reference copy, not imported. |
| `mscBasisTranscoderInlined.js` | **Generated.** The two files above as JavaScript strings. |
| `generateInlined.js` | Regenerates `mscBasisTranscoderInlined.js`. |
| `mscBasisTranscoder.js` | Instantiates the module on the main thread, and hands out the pieces the workers need. |
| `ktx2Core.js` | Container parsing and transcoding. Self contained, see below. |
| `ktx2Worker.js` | The pool of workers that transcodes off the main thread. |

## Provenance

Taken from the `KTX-Software-<version>-Web-msc_basis_transcoder` release archive of
<https://github.com/KhronosGroup/KTX-Software/releases>.

Currently vendored: **KTX-Software 4.4.2**.

## Why the transcoder is inlined instead of loaded from a URL

* The upstream glue uses optional chaining and optional catch binding, which the webpack
  version that builds `OSG.js` cannot parse. It therefore has to reach the browser as a string
  that is evaluated at runtime.
* Inlining the wasm as base64 keeps `OSG.js` a single self contained file. swea, the main
  consumer, is embedded into third party pages, so requiring an extra `.wasm` asset to be
  deployed next to the bundle and its URL to be configured would be a deployment burden.

The transcoder needs the `unsafe-eval` content security policy either way: embind builds its
method invokers with `new Function`.

## Where the transcoding runs

Transcoding is the expensive part, a few hundred milliseconds for an 8192x8192 texture, so it
happens in a pool of workers rather than on the main thread. There is no separate worker script
to deploy: `ktx2Worker.js` builds the worker source by gluing three pieces of text together.

1. `MSC_BASIS_TRANSCODER_JS`, the emscripten glue, which is a string already.
2. `createKtx2Core` from `ktx2Core.js`, stringified with `toString()`.
3. `workerMain` from `ktx2Worker.js`, stringified the same way.

The wasm binary is not part of that source, each worker receives it in its init message.

Two consequences for anyone editing `ktx2Core.js` or `workerMain`:

* **Their bodies must be self contained.** No imports, no module scope references, no `notify`,
  nothing from the DOM or WebGL. What the bundler cannot see, it cannot bundle.
* **They must not name an import binding.** The bundler rewrites references to imports, and the
  rewrite ends up inside the text `toString()` returns, leaving the worker with an identifier
  that means nothing to it. That is why `workerMain` reaches the core as `self.createKtx2Core`.
  `tests/osgDB/ktx2Worker.js` guards against this by running the real worker source.

`osgDB/KTX2Reader.js` keeps everything that needs a WebGL context: it decides which transcode
targets are acceptable, passes them to the worker by name, and maps the name that comes back to
a GL enum. It transcodes on the main thread instead when the browser has no workers, when
`KTX2Reader.setWorkerCount(0)` has been called, or when the workers fail to come up.

## Updating the transcoder

1. Download the new `KTX-Software-<version>-Web-msc_basis_transcoder` archive.
2. Replace `msc_basis_transcoder.js` and `msc_basis_transcoder.wasm` with the ones from it.
3. Run `node sources/osgDB/ktx2/generateInlined.js`.
4. Bump the version mentioned above.
5. Rebuild `OSG.js`.

If the transcoder's JS API changes, `ktx2Core.js` is the only place that talks to it.

## Authoring .ktx2 files for osgjs

Neither compressed blocks nor plain array data are affected by `UNPACK_FLIP_Y_WEBGL`, so the
mipmaps are uploaded exactly as stored. A `.ktx2` file therefore has to be authored with the
same origin as the `.png`/`.jpg` it replaces, that is top left, which is what `ktx create`
writes unless told otherwise.

Only the `none` and `BasisLZ` supercompression schemes are supported; Zstandard and ZLIB
supercompressed files are rejected with a message saying so. Cubemaps, texture arrays and 3D
textures are not supported either.

```
# ETC1S, small files, transcodes fast
ktx create --format R8G8B8A8_UNORM --generate-mipmap --encode basis-lz --qlevel 192 in.png out.ktx2

# UASTC, larger files, better quality
ktx create --format R8G8B8A8_UNORM --generate-mipmap --encode uastc in.png out.ktx2
```
