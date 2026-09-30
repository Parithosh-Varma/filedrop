# The Threshold Moved

A three-minute premium technology documentary built with [HyperFrames](https://github.com/heygen-com/hyperframes), plain HTML/CSS, and a deterministic GSAP timeline.

The film interprets Anthropic's September 2026 research on GLM-5.3 and the spread of advanced cyber capabilities. It uses 13 animated editorial scenes, custom data visualizations, cinematic narration, and an original synthesized ambient score. All runtime assets are local; rendering does not require a CDN or network fetch.

## Final film

`output/the-threshold-moved.mp4`

- **Duration:** 03:00 exactly
- **Frame:** 1920×1080
- **Frame rate:** 24 fps
- **Video:** H.264
- **Audio:** stereo AAC, 48 kHz
- **File size:** about 78 MB

## Preview

Requirements: Node.js 22+, FFmpeg/FFprobe, and Chrome/Chromium.

```bash
cd documentary
npx hyperframes preview
```

HyperFrames Studio provides frame-accurate timeline scrubbing.

## Validate

```bash
npx hyperframes check
npx hyperframes snapshot --at 6,19,33,48,61,75,89,103,117,131,145,158,172
```

The browser/runtime, layout, motion, and contrast gate passes with no errors or non-informational layout findings. Static lint retains advisory warnings recommending scene sub-compositions because the composition deliberately keeps its shared editorial design system and master GSAP choreography in one inspectable file.

## Render

```bash
npx hyperframes render . \
  --fps 24 \
  --quality looks \
  --output output/the-threshold-moved.mp4
```

## Project structure

- `index.html` — the complete HyperFrames composition, scene design, SVG/CSS artwork, and paused master GSAP timeline
- `assets/gsap.min.js` — local GSAP runtime
- `assets/fonts/` — local Space Grotesk and Space Mono webfonts
- `assets/narration-final.m4a` — narrated voice track
- `assets/score.m4a` — original atmospheric score
- `SCRIPT.md` — timed editorial structure and narration script
- `TRANSCRIPT.md` — complete, timecoded verbatim transcript
- `SOURCES.md` — research attribution and fact ledger
- `output/transcript.vtt` — browser-ready English subtitle track
- `output/transcript.srt` — downloadable SubRip subtitles
- `output/index.html` — video player with captions and a clickable transcript
- `output/the-threshold-moved.mp4` — final rendered documentary

## Creative direction

The film avoids slide-deck language: every chapter is treated as an editorial shot with camera drift, instrument-like data graphics, technical texture, cross-scene visual continuity, and a restrained near-black/cyan/amber palette. The motion is frame-seekable and deterministic—no wall-clock timers, random values, or render-time requests.
