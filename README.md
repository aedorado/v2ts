# YouTube Video to Audio & Transcript Automation (`v2ts`)

Automated CLI tool to download YouTube audio via `yt-dlp` and generate high-accuracy transcripts using headless browser automation on ElevenLabs Speech-to-Text (Hindi & English). Supports single videos, batch files, and YouTube channel upload monitoring.

---

## 📁 Repository Architecture

```text
v2ts/
├── .github/
│   └── workflows/
│       └── transcribe.yml        # GitHub Actions workflow for automated daily transcription
├── bin/
│   └── yta-transcribe.mjs        # Executable CLI entrypoint
├── src/
│   ├── formatter.js              # Plain text & JSON output generation & line reformatting
│   ├── transcriber.js            # Playwright automation for ElevenLabs STT
│   ├── utils.js                  # Filename sanitization, path handling & argument parsing
│   └── youtube.js                # yt-dlp metadata extraction & channel video resolver
├── test/
│   └── index.test.js             # Automated unit tests for core modules
├── scripts/                      # Inspection and debugging utility scripts
├── yta-transcribe.mjs            # Backwards-compatible CLI wrapper
├── package.json
└── README.md
```

---

## 📁 Output Structure

For every video processed, a dedicated folder is created under `transcripts/` prepended with the video upload date (`YYYY_MM_DD_`):

```text
transcripts/
└── 2024_09_12_[Video_Title]/
    ├── 2024_09_12_[Video_Title].mp3    # 1. Extracted high-quality MP3 audio
    ├── 2024_09_12_[Video_Title].txt    # 2. Clean plain-text transcript
    └── 2024_09_12_[Video_Title].json   # 3. Timestamped / structured transcript with metadata & URLs
```

---

## 💻 Setup on a New System

### 1. Prerequisites (System Tools)
Make sure **Node.js (v18+)**, **yt-dlp**, and **ffmpeg** are installed:

```bash
# macOS (using Homebrew)
brew install node yt-dlp ffmpeg

# Linux (Ubuntu/Debian)
sudo apt update && sudo apt install -y nodejs npm ffmpeg
sudo wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
```

### 2. Clone & Install Project Dependencies
```bash
git clone https://github.com/aedorado/v2ts.git
cd v2ts

# Install npm packages
npm install

# Install Playwright browser binaries with OS dependencies
npx playwright install chromium --with-deps
```

### 3. Run Tests
```bash
npm test
```

---

## 🚀 Usage & Quick Start Commands

### 1. Channel Uploads (e.g. `@BDDSwamiMedia` - Last 1 Day)
Automatically fetch and transcribe all videos uploaded to a channel in the last N days (default: 1 day):

```zsh
# Process videos uploaded in the last 1 day (Default)
./yta-transcribe.mjs "https://www.youtube.com/@BDDSwamiMedia"

# Process videos uploaded in the last 3 days
./yta-transcribe.mjs -d 3 "https://www.youtube.com/@BDDSwamiMedia"

# Hindi language mode for channel videos
./yta-transcribe.mjs -l hi -d 1 "https://www.youtube.com/@BDDSwamiMedia"
```

### 2. Single Video Transcription

```zsh
# English (Default)
./yta-transcribe.mjs "https://www.youtube.com/watch?v=VIDEO_ID"

# Hindi
./yta-transcribe.mjs -l hi "https://www.youtube.com/watch?v=VIDEO_ID"

# Custom Output Directory
./yta-transcribe.mjs -l hi -o ./custom_folder "https://www.youtube.com/watch?v=VIDEO_ID"
```

### 3. Batch Transcription from File (`input.txt`)
Add YouTube links to `input.txt` (one URL per line), then run:

```zsh
./yta-transcribe.mjs input.txt
```

---

## ⚡ Running Daily in GitHub Actions

This repository includes a pre-configured GitHub Actions workflow (`.github/workflows/transcribe.yml`) that runs **automatically every day at 00:00 UTC** (or manually on demand) to transcribe videos from `@BDDSwamiMedia` (or any channel/video) and commit the generated transcripts back to the Git repository.

### Features in GitHub Actions:
- **Daily Automation Schedule**: Runs automatically every 24 hours (`cron: '0 0 * * *'`).
- **Auto-Commit Transcripts**: Automatically commits & pushes newly created transcript folders under `transcripts/` directly to the `main` branch.
- **Headless Playwright & yt-dlp**: Headless Chromium browser automation with automatic CI fallback.
- **Artifact Downloads**: Uploads transcripts and audio files as downloadable artifacts on GitHub.

### How to Trigger Manually from GitHub UI:
1. Go to your repository on GitHub (`https://github.com/aedorado/v2ts`).
2. Click on the **Actions** tab.
3. Select **Transcribe YouTube Video** from the workflow list.
4. Click **Run workflow**, set target (`https://www.youtube.com/@BDDSwamiMedia`), set days (`1`), and click **Run workflow**.

---

## ⚙️ Options Reference

| Flag | Description | Default |
| :--- | :--- | :--- |
| `-d`, `--days` | Number of days to look back for Channel uploads | `1` |
| `-l`, `--lang` | Language target (`hindi` / `hi` or `english` / `en`) | `english` |
| `-o`, `--out` | Output destination directory | `./transcripts` |
| `-h`, `--help` | Display usage instructions and examples | — |

---

## 💡 Key Features & Smart Behaviors

- **Automatic Channel Filtering**: Expands YouTube Channel URLs (`@channel`) and filters uploads within specified timeframe (`--days N`).
- **Smart Audio Caching**: Reuses local audio files if `.mp3` is already present.
- **Smart Completion Skip**: Skips redundant downloads & API calls if valid transcript exists.
- **Isolated Incognito Sessions**: Every transcription runs in a fresh, isolated headless browser instance to bypass session limits.
