<p><img src="assets/logo.svg" width="48" height="48" alt="Permute logo"></p>

# Permute

Convert files in your browser without uploading them.

**Live:** [permute.mohitupawar.com](https://permute.mohitupawar.com/)

Drop a HEIC photo, a Word document, a spreadsheet or a video onto the page, pick what it should become, and save the result. The conversion runs inside the browser tab. No file is ever sent anywhere.

## Using it

1. Drop files anywhere on the page, click **Choose files**, or paste an image.
2. The headline reads as a sentence: *Turn photo.heic into JPG*. Click the format to pick a different one. With several files, each row can have its own format too.
3. Adjust the options that apply (quality, size, page size, PDF sharpness, video size, audio quality, GIF length).
4. Click **Convert**, then save each file or **Save all** as one ZIP.

Several images or PDFs going to PDF can be combined into one file. The site is dark by default, with a light theme behind the button in the top right that remembers your choice.

## What it converts

| From | To |
| --- | --- |
| **Images**: HEIC, JPG, PNG, WebP, AVIF, GIF, TIFF, BMP, SVG, ICO | JPG, PNG, WebP, AVIF\*, GIF, TIFF, BMP, ICO, PDF. Resize and set quality. Several images can become one PDF. |
| **PDF** | JPG or PNG per page (72/150/300 dpi), Word (text only), plain text, one PDF per page, merge PDFs and images into one PDF |
| **Documents**: Word (.docx), Markdown, HTML, plain text | PDF, Word, HTML, Markdown, plain text |
| **Spreadsheets and data**: Excel (.xlsx, .xls), OpenDocument (.ods), CSV, TSV, JSON, YAML, XML | Each other. JSON, YAML and XML keep their nesting when converted to each other; nested data is flattened into columns for spreadsheets. Every sheet in a workbook is exported. |
| **Audio**: MP3, WAV, M4A, AAC, FLAC, Ogg, Opus | MP3, WAV, M4A\*, Ogg\* |
| **Video**: MP4, MOV, WebM, MKV | MP4 (H.264/AAC), WebM, MOV, MKV, an animated GIF, or just the sound as MP3, WAV or M4A\*. Optional downscale to 1080p, 720p or 480p. |
| **ZIP** | Extract the files, or pack any files into one ZIP |

\* Depends on the browser's built-in encoders. Permute checks what your browser can do and only offers formats it can actually produce.

## The privacy property, stated precisely

- **No upload.** Files are read into memory by JavaScript in the tab, converted there, and offered back as a download from a local `blob:` URL.
- **No third-party code at runtime.** Every library is served from this site (`vendor/`). No CDNs, no analytics, no web fonts from elsewhere.
- **Enforced, not promised.** The page ships a Content Security Policy (`default-src 'self'`, `connect-src 'self' data: blob:`), so the page itself can't open a connection to any other host even if a library tried. On Netlify the same policy is also sent as a header, along with `frame-ancestors 'none'`, `X-Frame-Options`, `nosniff`, `no-referrer` and a restrictive `Permissions-Policy` (see `_headers`).
- **Checkable.** Open the network panel and convert something: you'll see no request carrying your file. Or load the page, turn off Wi‑Fi, and keep converting. A service worker caches the app so it also works offline after the first visit.

## Trust boundaries

With a server-side converter, the trust boundary breaks the moment the upload starts: from then on you are trusting someone else's servers, retention policy and staff. With Permute the boundary is the browser tab. You trust the browser sandbox, which every browser vendor hardens heavily, and the page's JavaScript, which you can read. That is a smaller and more visible trust surface.

Untrusted input is handled defensively too:

- PDFs are rendered by pdf.js with `isEvalSupported: false` (the CVE-2024-4367 class of bugs).
- HTML, Markdown and Word content is sanitised with DOMPurify and parsed into inert documents. Scripts, event handlers, forms and iframes are stripped, and only `http(s):` and `mailto:` links survive into the output.
- SVGs are rasterised through `<img>`, which never runs scripts inside them or loads what they link to.
- HTML files Permute generates carry their own Content Security Policy, so they can't run scripts, embed frames or submit forms wherever they're opened later.
- CSV and TSV output neutralises spreadsheet formula injection: text cells starting with `=`, `+`, `-`, `@`, tab or CR get a leading `'` so Excel doesn't run them. Plain numbers such as `-5` are untouched.
- ZIPs are checked before extraction and refused if they would unpack to more than 1 GB or 10,000 files (ZIP bombs).
- YAML alias expansion is capped (billion-laughs style files are refused), and XML external entities are never resolved.
- ZIP entry paths are reduced to file names, so `../` entries can't point anywhere else.
- WebAssembly is allowed (`'wasm-unsafe-eval'`) but JavaScript `eval` is not.

### How this was tested

Every conversion was run against real files, then against hostile ones: a file named `"><img src=x onerror=…>.jpg`, SVG and HTML with scripts, event handlers, iframes, forms and remote resources, Markdown with `javascript:` and `data:` links, XXE and entity-expansion XML, a YAML alias bomb, JSON with `__proto__` keys and formula payloads, a path-traversal ZIP, a 1.3 GB ZIP bomb and a corrupt PDF. Nothing executed in the page, and no request left the site's own origin. The only console noise is the browser reporting the policy blocking those payloads.

## How it works

No build step and no framework. Plain ES modules plus vendored libraries, loaded only when a file needs them:

```
index.html            page shell and Content Security Policy
assets/app.css        all styles; dark (default) and light themes
assets/logo.svg       logo (also favicon.svg)
assets/fonts/         IBM Plex Sans and Mono, self-hosted
js/theme.js           applies the saved theme before first paint
js/app.js             interface: sentence, format menu, queue, options, saving
js/formats.js         which formats can become which
js/convert.js         routes a file to an engine; ZIP in and out
js/engines/image.js   decode (incl. HEIC, TIFF, SVG) and encode images
js/engines/pdf.js     render, extract text, split, merge
js/engines/document.js  Word/Markdown/HTML/text to blocks, then to PDF/Word/HTML/Markdown/text
js/engines/data.js    spreadsheets, CSV, JSON, YAML, XML
js/engines/media.js   audio and video through WebCodecs
sw.js                 offline cache
_headers              security headers for Netlify
manifest.webmanifest  install as an app
vendor/               third-party libraries, unmodified
```

## Run it locally

Any static file server works. Modules need `http://`, not `file://`.

```bash
python3 -m http.server 5173
```

Then open http://localhost:5173.

## Deploying

It's a static site: upload the folder as-is to any static host (Netlify, GitHub Pages, Cloudflare Pages). There is no build command, and the publish directory is the repository root. HTTPS is needed for the offline cache.

On Netlify: link the site to this GitHub repository (Site configuration → Build & deploy → Link repository), branch `main`, leave the build command empty and set the publish directory to `/`. `_headers` is picked up automatically. On other hosts, copy those headers into the host's own config.

When you change anything in `vendor/`, bump `VERSION` at the top of `sw.js` so returning visitors get the new library files. App code (`js/`, `assets/app.css`, `index.html`) is fetched network-first, so it updates without a bump.

## Browser support

Current Chrome, Edge, Safari and Firefox. Images, PDFs, documents, data and ZIP work everywhere. Audio and video use WebCodecs, which is complete in Chrome and Edge, good in Safari 17+, and partial in Firefox. Permute hides any output format the browser can't encode.

## Honest limits

- Big files are limited by the browser's memory. Converting a 4 GB video in a tab is not a good idea.
- Word → PDF and Markdown → PDF lay out text, headings, lists, tables and images with the PDF's standard fonts. Complex layouts aren't reproduced, and characters outside Western European scripts (₹, Devanagari, CJK) show as "?" in PDF output. HTML, Word and text outputs keep every character.
- PDF → Word is text only. Scanned PDFs have no text to extract; convert those to images instead.
- Old binary `.doc` files aren't supported. Save them as `.docx` first.
- Video → GIF takes the first 5 to 30 seconds at 12 frames per second.
- Some audio/video formats depend on browser encoders (AAC for M4A, for example). Firefox currently has the fewest.
- ZIPs that unpack to more than 1 GB are refused on purpose.
- Converted HTML and Markdown keep remote image links from the original document; opening those files later will load the images like any web page would.

## Libraries

All bundled in `vendor/` and loaded on demand.

| Library | Used for | License |
| --- | --- | --- |
| [pdf.js](https://github.com/mozilla/pdf.js) | Rendering PDFs and reading their text | Apache-2.0 |
| [pdf-lib](https://github.com/Hopding/pdf-lib) | Writing, merging and splitting PDFs | MIT |
| [mammoth](https://github.com/mwilliamson/mammoth.js) | Reading .docx | BSD-2-Clause |
| [docx](https://github.com/dolanmiu/docx) | Writing .docx | MIT |
| [SheetJS](https://sheetjs.com) | Spreadsheets | Apache-2.0 |
| [mediabunny](https://github.com/Vanilagy/mediabunny) | Audio and video conversion via WebCodecs, MP3 encoding | MPL-2.0 |
| [libheif-js](https://github.com/catdad-experiments/libheif-js) | Decoding HEIC photos | LGPL-3.0 |
| [UTIF.js](https://github.com/photopea/UTIF.js) | TIFF | MIT |
| [gifenc](https://github.com/mattdesl/gifenc) | GIF encoding | MIT |
| [fflate](https://github.com/101arrowz/fflate) | ZIP | MIT |
| [marked](https://github.com/markedjs/marked) | Markdown | MIT |
| [Turndown](https://github.com/mixmark-io/turndown) | HTML to Markdown | MIT |
| [DOMPurify](https://github.com/cure53/DOMPurify) | Sanitising HTML | Apache-2.0 / MPL-2.0 |
| [js-yaml](https://github.com/nodeca/js-yaml) | YAML | MIT |
| [IBM Plex](https://github.com/IBM/plex) | Typefaces | OFL-1.1 |

## Author

Built before I formally moved into cybersecurity, but it's the project that made the move feel obvious in hindsight. The instinct behind Permute (*don't send the user's data to a server if you don't have to*) is the principle of least privilege applied to file conversion. Security work is a deeper version of the same instinct: find which trust boundaries a system crosses, and make each one as small and checkable as it can be.
