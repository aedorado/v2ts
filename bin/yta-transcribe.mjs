#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import {
  parseCliArgs,
  ensureOutputDir,
  checkExistingTranscript,
  copyLegacyAudioIfExists
} from '../src/utils.js';
import { fetchVideoMetadata, downloadAudio, resolveTargetUrls } from '../src/youtube.js';
import { transcribeAudioWithElevenLabs } from '../src/transcriber.js';
import { saveTranscriptOutputs } from '../src/formatter.js';

function printHelp() {
  console.log(`
YouTube Video to Audio & Transcript Automation (v2ts)

Usage:
  yta-transcribe [options] <YouTube_URL | Channel_URL | file.txt>
  yta-transcribe <YouTube_URL | Channel_URL | file.txt> [options]

Options:
  --days, -d     Number of days to look back for Channel uploads (default: 1)
  --lang, -l     Language to use: 'english' (default) or 'hindi' / 'hi'
  --out, -o      Output directory (default: ./transcripts)
  --help, -h     Show this help message

Examples:
  # Single video
  yta-transcribe "https://www.youtube.com/watch?v=VIDEO_ID"

  # Channel uploads in the last 1 day (Default)
  yta-transcribe -d 1 "https://www.youtube.com/channel/..."
  yta-transcribe -d 1 "https://www.youtube.com/@BDDSwamiMedia"

  # Batch mode from input.txt
  yta-transcribe input.txt
  yta-transcribe -l hi input.txt
`);
}

export async function processVideo(youtubeUrl, options = {}) {
  const lang = options.lang || 'english';
  const outputDir = ensureOutputDir(options.outputDir || 'transcripts');

  console.log(`\n🎬 [1/3] Fetching video info & downloading audio with yt-dlp...`);
  const { rawTitle, cleanTitle, folderName } = fetchVideoMetadata(youtubeUrl);
  
  const videoFolder = path.join(outputDir, folderName);
  if (!fs.existsSync(videoFolder)) {
    fs.mkdirSync(videoFolder, { recursive: true });
  }

  // 1. Check if transcript already exists
  if (checkExistingTranscript(outputDir, folderName, cleanTitle)) {
    const txtPath = path.join(videoFolder, `${folderName}.txt`);
    console.log(`⏩ Transcript already exists at: ${txtPath}`);
    console.log(`Skipping download & transcription for this video.`);
    return;
  }

  // 2. Check for legacy audio if moving from old structure
  copyLegacyAudioIfExists(outputDir, videoFolder, folderName, cleanTitle);

  // 3. Download MP3 audio
  const audioPath = path.join(videoFolder, `${folderName}.mp3`);
  downloadAudio(youtubeUrl, audioPath);

  // 4. Perform browser STT transcription
  console.log(`\n🌐 [2/3] Launching browser session for ElevenLabs STT (${lang})...`);
  const { extractedText, rawApiResponse } = await transcribeAudioWithElevenLabs(audioPath, lang);

  // 5. Format and save results
  console.log(`\n💾 [3/3] Saving outputs to ${videoFolder}...`);
  const { txtPath, jsonPath } = saveTranscriptOutputs({
    videoFolder,
    folderName,
    rawTitle,
    youtubeUrl,
    lang,
    extractedText,
    rawApiResponse
  });

  console.log(`\n✅ Done! 3 Files Created:`);
  console.log(`1. 🎵 Audio:      ${audioPath}`);
  console.log(`2. 📄 Plain Text: ${txtPath}`);
  console.log(`3. 📊 JSON:       ${jsonPath}\n`);
}

export async function runCli() {
  const cliArgs = parseCliArgs(process.argv.slice(2));

  if (cliArgs.showHelp) {
    printHelp();
    process.exit(0);
  }

  if (!cliArgs.target) {
    console.error('Error: Please provide a YouTube video URL, channel URL, or a file path (e.g., input.txt).');
    process.exit(1);
  }

  const urls = resolveTargetUrls(cliArgs.target, { days: cliArgs.days });

  if (urls.length === 0) {
    console.log('No video URLs to process.');
    return;
  }

  for (let idx = 0; idx < urls.length; idx++) {
    const currentUrl = urls[idx];
    console.log(`\n======================================================`);
    console.log(`▶️ Processing (${idx + 1}/${urls.length}): ${currentUrl}`);
    console.log(`======================================================`);
    try {
      await processVideo(currentUrl, { lang: cliArgs.lang, outputDir: cliArgs.outDir });
    } catch (err) {
      console.error(`❌ Failed processing ${currentUrl}:`, err.message || err);
    }
  }

  console.log(`\n🎉 All jobs completed!`);
}

if (process.argv[1] && process.argv[1].endsWith('bin/yta-transcribe.mjs')) {
  runCli().catch(err => {
    console.error('Fatal execution error:', err);
    process.exit(1);
  });
}
