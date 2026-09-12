#!/usr/bin/env node

import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

chromium.use(stealthPlugin());

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9_\u0900-\u097F -]/g, '').trim().replace(/\s+/g, '_');
}

async function transcribeVideo(youtubeUrl, options = {}) {
  const lang = options.lang || 'english'; // 'english' (default) or 'hindi'
  const outputDir = path.resolve(options.outputDir || 'transcripts');

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  console.log(`\n🎬 [1/3] Fetching video info & downloading audio with yt-dlp...`);
  
  // Get video upload date and title using reliable extractor args and cookies
  const metaCmd = spawnSync('yt-dlp', [
    '--cookies-from-browser', 'chrome',
    '--extractor-args', 'youtube:player_client=mweb,android',
    '--print', '%(upload_date>%Y_%m_%d)s',
    '--print', '%(title)s',
    youtubeUrl
  ], { encoding: 'utf-8' });

  let uploadDate = '';
  let rawTitle = 'youtube_audio';

  if (metaCmd.stdout) {
    const lines = metaCmd.stdout.trim().split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length >= 2) {
      uploadDate = lines[0];
      rawTitle = lines.slice(1).join(' ');
    } else if (lines.length === 1) {
      rawTitle = lines[0];
    }
  }

  const cleanTitle = sanitizeFilename(rawTitle) || 'transcript_output';
  const prefix = (uploadDate && /^\d{4}_\d{2}_\d{2}$/.test(uploadDate)) ? `${uploadDate}_` : '';
  const folderName = `${prefix}${cleanTitle}`;
  const videoFolder = path.join(outputDir, folderName);
  
  if (!fs.existsSync(videoFolder)) {
    fs.mkdirSync(videoFolder, { recursive: true });
  }

  const audioPath = path.join(videoFolder, `${folderName}.mp3`);
  const txtPath = path.join(videoFolder, `${folderName}.txt`);
  const jsonPath = path.join(videoFolder, `${folderName}.json`);

  // Check if valid transcript already exists (in new prefixed folder or old folder)
  const oldFolder = path.join(outputDir, cleanTitle);
  const oldTxt = path.join(oldFolder, `${cleanTitle}.txt`);

  if (fs.existsSync(txtPath) && fs.statSync(txtPath).size > 100) {
    const existingContent = fs.readFileSync(txtPath, 'utf-8');
    if (!existingContent.includes('No transcript text extracted')) {
      console.log(`⏩ Transcript already exists at: ${txtPath}`);
      console.log(`Skipping download & transcription for this video.`);
      return;
    }
  } else if (fs.existsSync(oldTxt) && fs.statSync(oldTxt).size > 100) {
    console.log(`⏩ Transcript already exists in legacy folder: ${oldTxt}`);
    console.log(`Skipping download & transcription for this video.`);
    return;
  }

  // Check if audio exists in new folder or legacy folder to skip download
  const oldAudio = path.join(oldFolder, `${cleanTitle}.mp3`);
  if (!fs.existsSync(audioPath) && fs.existsSync(oldAudio) && fs.statSync(oldAudio).size > 1000) {
    fs.copyFileSync(oldAudio, audioPath);
    console.log(`✅ Reusing existing audio from legacy folder: ${oldAudio}`);
  }

  // Download audio as mp3 using exact working flags (only if file doesn't already exist)
  if (fs.existsSync(audioPath) && fs.statSync(audioPath).size > 1000) {
    console.log(`✅ Audio already downloaded at: ${audioPath} (Skipping yt-dlp)`);
  } else {
    console.log(`Downloading audio to: ${audioPath}`);
    const dlResult = spawnSync('yt-dlp', [
      '--cookies-from-browser', 'chrome',
      '--extractor-args', 'youtube:player_client=mweb,android',
      '-f', 'ba[ext=m4a]/ba/worst[acodec!=none]',
      '--extract-audio',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      '-o', audioPath,
      youtubeUrl
    ], { stdio: 'inherit' });

    if (dlResult.status !== 0) {
      throw new Error(`Failed to download audio with yt-dlp for URL: ${youtubeUrl}`);
    }
  }

  console.log(`\n🌐 [2/3] Launching headless browser session for ElevenLabs (${lang})...`);
  const targetUrl = lang === 'english'
    ? 'https://elevenlabs.io/speech-to-text/english'
    : 'https://elevenlabs.io/speech-to-text/hindi';

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  let transcriptData = null;

  // Intercept the backend transcription response
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('speech-to-text') || url.includes('scribe') || url.includes('transcribe')) {
      try {
        const contentType = response.headers()['content-type'] || '';
        if (contentType.includes('application/json')) {
          const json = await response.json();
          if (json && (json.text || json.words || json.transcription || json.transcript)) {
            transcriptData = json;
          }
        }
      } catch (e) {}
    }
  });

  try {
    await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 60000 });

    // Handle cookie banner if present
    try {
      const cookieBtn = await page.$('#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll, button:has-text("Allow all"), button:has-text("Accept")');
      if (cookieBtn) {
        await cookieBtn.click();
        await page.waitForTimeout(500);
      }
    } catch (e) {}

    console.log(`Uploading ${path.basename(audioPath)} to ElevenLabs web form...`);
    const fileInput = await page.$('input[type="file"]');
    if (!fileInput) {
      throw new Error('Could not find file upload input on ElevenLabs page.');
    }

    await fileInput.setInputFiles(audioPath);
    console.log(`Waiting for transcription to complete...`);

    // Wait for transcription completion (up to 20 minutes for long ~1.5h lectures)
    let extractedText = '';
    const maxWaitMs = 1200000; // ~20 minutes max wait
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      // 1. Check if Scribe API JSON was intercepted directly
      if (transcriptData && transcriptData.text) {
        extractedText = transcriptData.text;
        break;
      }

      // 2. Check if transcription is completed in UI (Download button or SPEAKER blocks present, TRANSCRIBING gone)
      const isComplete = await page.evaluate(() => {
        const body = document.body.innerText || '';
        const isTranscribing = body.includes('TRANSCRIBING') || body.includes('Please wait while we transcribe');
        const hasNoTranscript = body.includes('NO TRANSCRIPT AVAILABLE');
        const hasSpeaker = body.includes('SPEAKER') || body.includes('Download');
        return !isTranscribing && !hasNoTranscript && hasSpeaker;
      });

      if (isComplete) {
        console.log(`\nTranscription ready on page! Extracting content...`);
        
        // Method A: Click the Copy Button and read clipboard
        try {
          const copyButton = await page.$('button[class*="rounded"]:has(svg), button:has(svg.lucide-copy), button:has-text("Copy")');
          if (copyButton) {
            await copyButton.click();
            await page.waitForTimeout(800);
            const clip = await page.evaluate(async () => {
              try { return await navigator.clipboard.readText(); } catch (e) { return ''; }
            });
            if (clip && clip.length > 50) {
              extractedText = clip;
              break;
            }
          }
        } catch (e) {}

        // Method B: Extract text from all speaker paragraphs in DOM
        const domText = await page.evaluate(() => {
          // Find container with SPEAKER blocks
          const blocks = Array.from(document.querySelectorAll('div, p'))
            .filter(el => el.innerText && (el.innerText.startsWith('SPEAKER ') || el.innerText.includes('SPEAKER 1')));
          if (blocks.length > 0) {
            return blocks.map(b => b.innerText.trim()).join('\n\n');
          }
          
          // Or slice from the body starting from SPEAKER or first text block
          const body = document.body.innerText;
          const startIdx = body.indexOf('SPEAKER');
          if (startIdx !== -1) {
            const endIdx = body.indexOf('What languages does Scribe support?');
            return endIdx !== -1 ? body.substring(startIdx, endIdx).trim() : body.substring(startIdx, startIdx + 120000).trim();
          }
          return '';
        });

        if (domText && domText.length > 50) {
          extractedText = domText;
          break;
        }
      }

      // Log progress periodically
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      if (elapsed > 0 && elapsed % 15 === 0) {
        process.stdout.write(`... transcribing in progress (${elapsed}s)\r`);
      }

      await page.waitForTimeout(3000);
    }

    if (!extractedText && transcriptData && transcriptData.text) {
      extractedText = transcriptData.text;
    }

    if (!extractedText) {
      // Fallback: try one more time to grab any text from the page before throwing
      extractedText = await page.evaluate(() => {
        const body = document.body.innerText;
        const startIdx = body.indexOf('SPEAKER');
        if (startIdx !== -1) {
          const endIdx = body.indexOf('What languages does Scribe support?');
          return endIdx !== -1 ? body.substring(startIdx, endIdx).trim() : body.substring(startIdx).trim();
        }
        return '';
      });
    }

    console.log(`\n💾 [3/3] Saving outputs to ${videoFolder}...`);

    let finalPlainText = extractedText.trim();
    if (!finalPlainText) {
      throw new Error('Transcription finished but could not read text from page.');
    }

    // Auto-reformat if words are separated line-by-line
    const lines = finalPlainText.split('\n');
    if (lines.length > 500) {
      const formattedBlocks = [];
      let currentSpeaker = '';
      let currentWords = [];

      for (let line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith('SPEAKER ')) {
          if (currentWords.length > 0) {
            formattedBlocks.push(`${currentSpeaker}\n${currentWords.join(' ')}`);
            currentWords = [];
          }
          currentSpeaker = trimmed;
        } else {
          currentWords.push(trimmed);
        }
      }

      if (currentWords.length > 0) {
        formattedBlocks.push(`${currentSpeaker}\n${currentWords.join(' ')}`);
      }

      if (formattedBlocks.length > 0) {
        finalPlainText = formattedBlocks.join('\n\n');
      }
    }
    
    // 1. Audio is already saved at audioPath
    // 2. Save Plain Text transcript
    fs.writeFileSync(txtPath, finalPlainText, 'utf-8');
    
    // 3. Save JSON metadata / timestamp data
    const jsonOutput = {
      title: rawTitle,
      sourceUrl: youtubeUrl,
      language: lang,
      date: new Date().toISOString(),
      transcript: finalPlainText,
      rawApiResponse: transcriptData || null
    };
    fs.writeFileSync(jsonPath, JSON.stringify(jsonOutput, null, 2), 'utf-8');

    console.log(`\n✅ Done! 3 Files Created:`);
    console.log(`1. 🎵 Audio:      ${audioPath}`);
    console.log(`2. 📄 Plain Text: ${txtPath}`);
    console.log(`3. 📊 JSON:       ${jsonPath}\n`);

  } finally {
    await browser.close();
  }
}

// CLI Argument Handling
const rawArgs = process.argv.slice(2);
if (rawArgs.length === 0 || rawArgs.includes('--help') || rawArgs.includes('-h')) {
  console.log(`
Usage:
  yta-transcribe [options] <YouTube_URL | file.txt>
  yta-transcribe <YouTube_URL | file.txt> [options]

Options:
  --lang, -l     Language to use: 'english' (default) or 'hindi' / 'hi'
  --out, -o      Output directory (default: ./transcripts)
  --help, -h     Show this help message

Batch Mode:
  You can provide a text file (e.g. input.txt) containing one YouTube URL per line.

Examples:
  yta-transcribe input.txt
  yta-transcribe -l hi input.txt
  yta-transcribe -l hi "https://www.youtube.com/watch?v=VIDEO_ID"
`);
  process.exit(0);
}

let target = null;
let lang = 'english';
let outDir = 'transcripts';

for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (arg === '--lang' || arg === '-l') {
    const val = rawArgs[i + 1]?.toLowerCase();
    lang = val === 'hindi' || val === 'hi' ? 'hindi' : 'english';
    i++;
  } else if (arg === '--out' || arg === '-o') {
    outDir = rawArgs[i + 1];
    i++;
  } else if (!arg.startsWith('-')) {
    target = arg;
  }
}

if (!target) {
  console.error('Error: Please provide a YouTube video URL or a file path (e.g., input.txt).');
  process.exit(1);
}

async function main() {
  let urls = [];

  // Check if target is an existing text file
  if (fs.existsSync(target) && fs.statSync(target).isFile()) {
    console.log(`📄 Reading URLs from batch file: ${target}`);
    const lines = fs.readFileSync(target, 'utf-8').split('\n');
    urls = lines
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#'));
    console.log(`Found ${urls.length} URL(s) to process.\n`);
  } else {
    urls = [target];
  }

  for (let idx = 0; idx < urls.length; idx++) {
    const currentUrl = urls[idx];
    console.log(`\n======================================================`);
    console.log(`▶️ Processing (${idx + 1}/${urls.length}): ${currentUrl}`);
    console.log(`======================================================`);
    try {
      await transcribeVideo(currentUrl, { lang, outputDir: outDir });
    } catch (err) {
      console.error(`❌ Failed processing ${currentUrl}:`, err.message || err);
    }
  }

  console.log(`\n🎉 All jobs completed!`);
}

main().catch(err => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});


