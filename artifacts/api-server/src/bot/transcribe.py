import json
import os
import sys

from faster_whisper import WhisperModel


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: transcribe.py <audio-file>")

    model_size = os.environ.get("WHISPER_MODEL_SIZE", "small")
    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    segments, info = model.transcribe(
        sys.argv[1],
        beam_size=5,
        vad_filter=False,
    )

    transcript = [
        {
            "start": segment.start,
            "end": segment.end,
            "text": segment.text,
        }
        for segment in segments
    ]
    print(
        json.dumps(
            {"language": info.language, "segments": transcript},
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
