# YouTube Video to Audio & Transcript Automation (`v2ts`)

Automated CLI tool to download YouTube audio via `yt-dlp` and generate high-accuracy transcripts using headless browser automation on ElevenLabs Speech-to-Text (Hindi & English).

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

Follow these step-by-step instructions to set up and run this project on any fresh macOS / Linux machine:

### 1. Prerequisites (System Tools)
Make sure **Homebrew**, **Node.js (v18+)**, **yt-dlp**, and **ffmpeg** are installed:

```bash
# macOS (using Homebrew)
brew install node yt-dlp ffmpeg

# Linux (Ubuntu/Debian)
sudo apt update && sudo apt install -y nodejs npm ffmpeg
sudo wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
```

### 2. Clone & Install Project Dependencies
Navigate to the project folder and install the Node dependencies and Playwright Chromium browser:

```bash
cd v2ts

# Install npm packages
npm install

# Install Playwright browser binaries
npx playwright install chromium
```

### 3. Make the CLI Executable
```bash
chmod +x yta-transcribe.mjs
```

---

## 🚀 Quick Start Commands

### 1. Entire YouTube Playlist Transcription (Hindi / English)
You can directly pass a YouTube Playlist URL. The tool automatically resolves all videos in the playlist and transcribes each one sequentially:

```zsh
# Hindi Playlist
./yta-transcribe.mjs -l hi "https://www.youtube.com/playlist?list=PLAYLIST_ID"

# English Playlist (English is default, or explicitly pass -l en)
./yta-transcribe.mjs -l en "https://www.youtube.com/playlist?list=PLAYLIST_ID"
./yta-transcribe.mjs "https://www.youtube.com/playlist?list=PLAYLIST_ID"
```

### 2. Batch Transcription from Files (Auto Language Detection)
You can maintain separate files: `input-hi.txt` for Hindi videos and `input-en.txt` for English videos (one URL per line, supports both single videos and playlist URLs). The CLI automatically detects the language from the file name:

```zsh
# Automatically runs in Hindi mode
./yta-transcribe.mjs input-hi.txt

# Automatically runs in English mode
./yta-transcribe.mjs input-en.txt

# Or manually specify language/file
./yta-transcribe.mjs -l hi input.txt
./yta-transcribe.mjs input.txt
```

### 3. Single Video Transcription

```zsh
# English (Default)
./yta-transcribe.mjs "https://www.youtube.com/watch?v=VIDEO_ID"

# Hindi
./yta-transcribe.mjs -l hi "https://www.youtube.com/watch?v=VIDEO_ID"
# or
./yta-transcribe.mjs --lang hindi "https://www.youtube.com/watch?v=VIDEO_ID"

# Custom Output Directory
./yta-transcribe.mjs -o ./custom_folder input-hi.txt
```

---

## 🛠️ Global Terminal Alias (Use from Anywhere)

To run this command from any folder in your terminal:

1. Add this alias to your shell configuration (`~/.zshrc` or `~/.bashrc`):
   ```zsh
   echo 'alias yta-transcribe="node /Users/anurag/pworkspace/v2ts/yta-transcribe.mjs"' >> ~/.zshrc
   ```
2. Reload your terminal configuration:
   ```zsh
   source ~/.zshrc
   ```
3. Now you can run it anywhere:
   ```zsh
   yta-transcribe -l hi input.txt
   yta-transcribe -l hi "https://www.youtube.com/watch?v=Zy6k0QXBzcM"
   ```

---

## ⚙️ Options Reference

| Flag | Description | Default |
| :--- | :--- | :--- |
| `-l`, `--lang` | Language target (`hindi` / `hi` or `english` / `en`) | `english` |
| `-o`, `--out` | Output destination directory | `./transcripts` |
| `-h`, `--help` | Display usage instructions and examples | — |

---

## 📝 Batch File Format (`input.txt`)

You can include full YouTube URLs, short URLs (`youtu.be`), blank lines, and comments starting with `#`:

```text
# Hindi Video Batch
https://www.youtube.com/watch?v=z0aG1xr2RV8
https://www.youtube.com/watch?v=Zy6k0QXBzcM

# English Video Batch
https://www.youtube.com/watch?v=znSiMPv7IqE
https://youtu.be/EBkQeBYllGw
```

---

## 💡 Key Features & Smart Behaviors

- **Smart Audio Caching**: If `.mp3` is already downloaded, it reuses the local file without re-fetching from YouTube.
- **Smart Completion Skip**: If a valid transcript has already been generated, it skips redundant downloads & API calls.
- **Isolated Incognito Sessions**: Every transcription runs in a fresh, isolated headless browser instance to bypass session limits.
- **Robust YouTube Extraction**: Uses `--cookies-from-browser chrome` and mobile/android extractor fallback to avoid HTTP 403 Forbidden errors.
