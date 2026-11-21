# permute
Convert anything securely; 
[Try permute (opens in a new tab via Ctrl+Click)](https://permute.mohitupawar.com/)
# Permute

A privacy-first file converter that runs entirely in the browser. Files never leave your device.

**Live demo:** https://permute.mohitupawar.com

## Why this exists

Most online file converters work the same way: you upload your file to a server, the server runs the conversion, and you download the result. That's convenient and it means a stranger's server briefly holds an unencrypted copy of your file.
 For converting a meme, fine. For anything with a passport scan, a payslip, a contract, a chat export, or a private photo, you've handed your data to an unknown third party with unknown retention, unknown access controls, and unknown logging.

Permute is the same workflow without that trade-off. The conversion runs in your browser using the file APIs the browser already exposes. No upload, no server-side processing, no logs — the file the page receives is the file the page returns, transformed locally.

## The security property, stated precisely

This is the part worth being explicit about, because "private" is a vague marketing word and "client-side" is a specific technical claim:

- **No file upload occurs.** The file is read into memory by JavaScript running in your browser, converted in that same context, and offered back as a download. The network is never used for the file's contents.
- **No telemetry on file contents.** The page does not transmit filenames, sizes, or hashes of converted files.
- **Open to inspection.** Because everything runs client-side, this claim is *verifiable* — open the browser's network panel, watch a conversion happen, confirm no upload request is made. A server-side converter cannot offer the same guarantee no matter what its privacy policy says.

This is sometimes called *privacy by design*: the privacy property comes from the architecture, not from a promise. Even if the operator wanted to log your files, they couldn't — the files were never sent.

## Trust boundaries

The interesting design question for any tool that touches user files is: *where does the user's trust boundary stop?* For a server-side converter, the boundary is broken the moment the upload begins; from there, the user is trusting the operator's infrastructure, code, and policies. For Permute, the boundary is the browser tab. The user is trusting the browser sandbox (well-studied, hardened by every major vendor) and the page's JavaScript (open to inspection). That's a strictly smaller and more transparent trust surface.

## How it works

Standard web platform APIs:
- `File` / `FileReader` to read the user's input file into memory.
- Format-specific JavaScript libraries (decoding/encoding) running locally.
- `Blob` + `URL.createObjectURL` to offer the converted file as a download.

No backend, no database, no analytics on file contents. The codebase is the whole story.

## Honest limits

- Very large files are bounded by the browser's available memory. A 5 GB video conversion is not a job for the browser; it's a job for desktop software you already trust.
- Some niche formats require heavy native dependencies that don't (yet) port cleanly to the browser; for those, Permute will tell you it can't do it rather than silently uploading the file somewhere.

## Author

Built before I formally started moving into cybersecurity, but it's the project that made the move feel obvious in retrospect. The instinct that produced Permute — *don't send the user's data to a server if you don't have to* — is just the principle of least privilege applied to file conversion. Security work is a deeper version of the same instinct: figure out which trust boundaries a system crosses, and make each one as small and verifiable as it can be.
