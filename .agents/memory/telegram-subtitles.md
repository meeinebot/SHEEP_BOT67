---
name: Telegram subtitle bot
description: User-stated product requirements for video transcription and subtitle output.
---

The user wants a Telegram bot that can receive videos up to 27 minutes and 950 MB, transcribe speech in the language spoken in the video, and return a subtitle file with timecodes. They want the service to be free.

The user confirmed that the local Whisper transcription worked well on a short Russian clip, though it made one word substitution. Keep accuracy caveats realistic; occasional transcription corrections are expected.

**Why:** These are explicit requirements the user gave for this project.

**How to apply:** Keep transcription free of paid per-minute APIs, preserve the source language rather than translating, and retain the 27-minute duration and 950 MB file caps unless the user changes these requirements. Be clear about any Telegram file-size or hosting limits that prevent a requirement from being met, and don't promise perfect word recognition.
