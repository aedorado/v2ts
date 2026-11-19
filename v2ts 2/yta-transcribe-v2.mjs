#!/usr/bin/env node

import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

function askUser(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise(resolve => rl.question(query, ans => {
    rl.close();
    resolve(ans.trim());
  }));
}

chromium.use(stealthPlugin());

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9_\u0900-\u097F -]/g, '').trim().replace(/\s+/g, '_');
}

function formatSecondsToTimestamp(sec) {
  const totalMs = Math.floor(sec * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function generateSegmentsFromWords(words) {
  if (!words || !Array.isArray(words)) return [];
  const segments = [];
  let currentSeg = null;

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w.text) continue;

    const spk = w.speaker_id || currentSeg?.speaker || 'speaker_0';
    const prevWord = i > 0 ? words[i - 1] : null;
    const gap = prevWord ? (w.start - (prevWord.end ?? prevWord.start)) : 0;
    const isPunctuationEnd = currentSeg && /[.?!।|]$/.test(currentSeg.text.trim());
    const durationSoFar = currentSeg ? (w.end - currentSeg.start) : 0;
    const wordCount = currentSeg ? currentSeg.text.trim().split(/\s+/).length : 0;

    // Split into a new segment/paragraph if:
    // 1. Speaker changed
    // 2. Pause >= 1.2s after a sentence boundary (. ? ! ।)
    // 3. Very long pause >= 2.5s (speaker pause/breath)
    // 4. Over ~40 seconds or ~75 words AND at a sentence boundary (. ? ! ।)
    const speakerChanged = currentSeg && currentSeg.speaker !== spk;
    const pauseBreak = isPunctuationEnd && gap >= 1.2;
    const longPauseBreak = gap >= 2.5;
    const lengthBreak = isPunctuationEnd && (durationSoFar >= 40 || wordCount >= 75);

    const shouldStartNewSeg = !currentSeg || speakerChanged || pauseBreak || longPauseBreak || lengthBreak;

    if (shouldStartNewSeg) {
      if (currentSeg) {
        currentSeg.text = currentSeg.text.trim();
        if (currentSeg.text) segments.push(currentSeg);
      }
      currentSeg = {
        speaker: spk,
        start: w.start ?? 0,
        end: w.end ?? 0,
        text: w.text
      };
    } else {
      currentSeg.end = w.end ?? currentSeg.end;
      if (w.type === 'spacing') {
        currentSeg.text += w.text;
      } else {
        const needsSpace = currentSeg.text && !/\s$/.test(currentSeg.text) && !/^[.,!?;:]/.test(w.text);
        currentSeg.text += (needsSpace ? ' ' : '') + w.text;
      }
    }
  }

  if (currentSeg) {
    currentSeg.text = currentSeg.text.trim();
    if (currentSeg.text) segments.push(currentSeg);
  }

  return segments;
}

function generateTimestampedTxt(transcriptData) {
  if (!transcriptData) return '';
  let segments = transcriptData.segments;
  if (!segments && transcriptData.words) {
    segments = generateSegmentsFromWords(transcriptData.words);
  }
  if (!segments || !Array.isArray(segments) || segments.length === 0) return '';
  return segments.map(seg => {
    const start = seg.start ?? seg.words?.[0]?.start ?? 0;
    const end = seg.end ?? seg.words?.[seg.words.length - 1]?.end ?? 0;
    const rawSpeaker = seg.speaker ?? seg.speaker_id ?? seg.words?.[0]?.speaker_id ?? 'speaker_0';
    const spkNumMatch = String(rawSpeaker).match(/\d+/);
    const spkNum = spkNumMatch ? parseInt(spkNumMatch[0], 10) + 1 : 1;
    const speakerLabel = `Speaker ${spkNum}`;
    return `${formatSecondsToTimestamp(start)} --> ${formatSecondsToTimestamp(end)} [${speakerLabel}]\n${(seg.text || '').trim()}`;
  }).join('\n\n');
}

function generateTimestampedTxtFromSegments(segments) {
  return generateTimestampedTxt({ segments });
}

function isMarketingOrJunk(text) {
  if (!text || typeof text !== 'string') return true;
  const lower = text.toLowerCase();
  return lower.includes('hindi transcription benchmark') ||
         lower.includes('scribe v1') ||
         lower.includes('fleurs scribe') ||
         lower.includes('speech-to-text api integration') ||
         lower.includes('world\'s most advanced asr') ||
         lower.includes('smart speaker diarization in any conversation') ||
         lower.includes('reached the limit of available requests');
}

function formatCleanTranscript(rawText) {
  if (!rawText || !rawText.trim()) return '';

  const rawLines = rawText.split(/\r?\n/).map(l => l.trim());
  const blocks = [];
  let currentSpeaker = '';
  let currentWords = [];
  let unnumberedSpeakerCount = 0;

  function commitBlock() {
    if (currentWords.length > 0) {
      const text = currentWords.join(' ')
        .replace(/\s+([.,!?;:])/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) {
        if (blocks.length > 0 && blocks[blocks.length - 1].speaker === currentSpeaker) {
          blocks[blocks.length - 1].text += '\n\n' + text;
        } else {
          blocks.push({
            speaker: currentSpeaker || 'Speaker 1',
            text
          });
        }
      }
      currentWords = [];
    }
  }

  const srtTimestampRegex = /^\d{1,2}:\d{2}:\d{2}[,\.]\d{2,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,\.]\d{2,3}/;

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (!line) continue;

    // Check if line is purely an SRT sequence number (e.g. "1", "24") followed by a timestamp
    if (/^\d+$/.test(line)) {
      let nextLine = '';
      for (let j = i + 1; j < Math.min(i + 4, rawLines.length); j++) {
        if (rawLines[j]) {
          nextLine = rawLines[j];
          break;
        }
      }
      if (srtTimestampRegex.test(nextLine)) {
        continue; // Skip SRT index number
      }
    }

    // Check if line is a timestamp line (e.g. 00:00:00,000 --> 00:00:05,000 [Speaker 1])
    if (srtTimestampRegex.test(line)) {
      commitBlock();
      const speakerMatch = line.match(/\[([a-zA-Z0-9_\s]+)\]/) || line.match(/<v\s+([^>]+)>/i);
      if (speakerMatch) {
        const rawSpk = speakerMatch[1].trim();
        const m = rawSpk.match(/^(?:speaker|spk)(?:\s*([0-9a-zA-Z_]+))?/i);
        let spk;
        if (m) {
          const num = m[1] !== undefined ? m[1].replace(/^_+/, '') : '';
          spk = num ? `Speaker ${num}` : 'Speaker 1';
        } else {
          spk = rawSpk;
        }
        currentSpeaker = spk;
      }
      continue; // Skip timestamp line
    }

    // Check for timestamp before speaker e.g. "0:00 [Speaker 1]" or "00:00:15 [Speaker 2]"
    const timeBeforeSpeakerMatch = line.match(/^(?:\[?\d{1,2}:\d{2}(?::\d{2})?(?:[,\.]\d{2,3})?\]?)\s*\[?(?:speaker|spk)(?:\s*([0-9a-zA-Z_]+))?\]?\s*[:-]?\s*(.*)$/i);
    if (timeBeforeSpeakerMatch) {
      commitBlock();
      const num = timeBeforeSpeakerMatch[1];
      if (num !== undefined && num !== '') {
        const cleanNum = num.replace(/^_+/, '');
        currentSpeaker = /^\d+$/.test(cleanNum) ? `Speaker ${cleanNum}` : `Speaker ${cleanNum}`;
      } else {
        unnumberedSpeakerCount++;
        currentSpeaker = unnumberedSpeakerCount % 2 === 1 ? 'Speaker 1' : 'Speaker 2';
      }
      const rest = timeBeforeSpeakerMatch[2].trim();
      if (rest) {
        currentWords.push(rest);
      }
      continue;
    }

    // Check if line is standalone speaker label like "Speaker", "SPEAKER 1", "speaker_1", "Speaker 0:", "[Speaker 2]"
    const standaloneSpeakerMatch = line.match(/^(?:\[?\s*)?(?:speaker|spk)(?:\s*([0-9a-zA-Z_]+))?(?:\s*\])?(?:\s*:)?$/i);
    if (standaloneSpeakerMatch) {
      commitBlock();
      const num = standaloneSpeakerMatch[1];
      if (num !== undefined && num !== '') {
        const cleanNum = num.replace(/^_+/, '');
        currentSpeaker = /^\d+$/.test(cleanNum) ? `Speaker ${cleanNum}` : `Speaker ${cleanNum}`;
      } else {
        // Unnumbered Speaker header: alternate between Speaker 1 and Speaker 2
        unnumberedSpeakerCount++;
        currentSpeaker = unnumberedSpeakerCount % 2 === 1 ? 'Speaker 1' : 'Speaker 2';
      }
      continue;
    }

    // Check for inline speaker e.g. "Speaker 1: Hello world" or "Speaker: Hello"
    const inlineSpeakerMatch = line.match(/^(?:\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s*)?(?:speaker|spk)(?:\s*([0-9a-zA-Z_]+))?\s*[:-]\s*(.*)$/i);
    if (inlineSpeakerMatch) {
      commitBlock();
      const num = inlineSpeakerMatch[1];
      if (num !== undefined && num !== '') {
        const cleanNum = num.replace(/^_+/, '');
        currentSpeaker = /^\d+$/.test(cleanNum) ? `Speaker ${cleanNum}` : `Speaker ${cleanNum}`;
      } else {
        unnumberedSpeakerCount++;
        currentSpeaker = unnumberedSpeakerCount % 2 === 1 ? 'Speaker 1' : 'Speaker 2';
      }
      const rest = inlineSpeakerMatch[2].trim();
      if (rest) {
        currentWords.push(rest);
      }
      continue;
    }

    // Strip any leading inline timestamp like [00:00:15] or 00:00:15 -
    let cleanLine = line.replace(/^\[?\d{1,2}:\d{2}(?::\d{2})?(?:[,\.]\d{2,3})?\]?\s*[:-]?\s*/, '').trim();
    if (!cleanLine) continue;

    currentWords.push(cleanLine);
  }

  commitBlock();

  return blocks.map(b => `${b.speaker}\n${b.text}`).join('\n\n');
}

function getCompletedVideoIds(outputDir) {
  const completedIds = new Set();
  if (!fs.existsSync(outputDir)) return completedIds;
  try {
    const entries = fs.readdirSync(outputDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const folder = path.join(outputDir, entry.name);
      const files = fs.readdirSync(folder);
      const txt = files.find(f => f.endsWith('.txt') && !f.endsWith('_raw.txt'));
      if (!txt || fs.statSync(path.join(folder, txt)).size < 100) continue;

      const txtContent = fs.readFileSync(path.join(folder, txt), 'utf-8');
      if (isMarketingOrJunk(txtContent)) continue;

      const jsonFile = files.find(f => f.endsWith('.json'));
      if (jsonFile) {
        try {
          const json = JSON.parse(fs.readFileSync(path.join(folder, jsonFile), 'utf-8'));
          if (json.sourceUrl) {
            const match = json.sourceUrl.match(/(?:v=|\/)([a-zA-Z0-9_-]{11})(?:[&?]|$)/);
            if (match) completedIds.add(match[1]);
          }
        } catch (e) { }
      }
    }
  } catch (e) { }
  return completedIds;
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
    '--no-playlist',
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
      '--no-playlist',
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

  const isHeaded = !!options.headed;
  console.log(`\n🌐 [2/3] Launching browser session for ElevenLabs (${lang})${isHeaded ? ' [headed]' : ''}...`);
  const targetUrl = lang === 'english'
    ? 'https://elevenlabs.io/speech-to-text/english'
    : 'https://elevenlabs.io/speech-to-text/hindi';

  const launchOpts = {
    headless: !isHeaded,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1512,982'
    ]
  };
  if (fs.existsSync('/Applications/Google Chrome.app')) {
    launchOpts.channel = 'chrome';
  }

  const profileDir = path.resolve('.elevenlabs-session');
  const context = await chromium.launchPersistentContext(profileDir, {
    ...launchOpts,
    acceptDownloads: true,
    permissions: ['clipboard-read', 'clipboard-write'],
    viewport: { width: 1280, height: 800 },
  });

  const page = context.pages()[0] || await context.newPage();

  let transcriptData = null;
  let backendError = null;
  const recentErrors = [];

  // Capture page console errors for diagnostics (filtering out harmless third-party notices)
  page.on('console', msg => {
    const text = msg.text();
    const isHarmless = [
      'GSI_LOGGER', 'WebGL', 'favicon', 'accounts list is empty',
      'FedCM', 'Credential', 'Failed to load resource: net::',
      'ResizeObserver', 'Third-Party Cookie', 'DevTools'
    ].some(ignore => text.includes(ignore));

    if (!isHarmless && msg.type() === 'error') {
      recentErrors.push(`Page Console: ${text}`);
    }
  });

  // Intercept backend transcription responses, capture JSON, and detect errors immediately
  page.on('response', async (response) => {
    const url = response.url();
    const status = response.status();
    if (url.includes('api.elevenlabs.io') || url.includes('speech-to-text') || url.includes('scribe') || url.includes('transcribe')) {
      if (status >= 400) {
        backendError = `ElevenLabs API HTTP ${status}`;
        try {
          const text = await response.text();
          let msg = text;
          try {
            const json = JSON.parse(text);
            msg = typeof json.detail === 'string'
              ? json.detail
              : (json.detail?.message || json.message || json.error || JSON.stringify(json.detail));
          } catch (e) { }
          backendError = `ElevenLabs API HTTP ${status}: ${msg}`;
          console.error(`🚨 [API Error Detail]: ${backendError}`);
        } catch (e) {
          console.error(`🚨 [API Error]: HTTP ${status} from ${url}`);
        }
        return;
      }
      response.json().then(json => {
        if (json && (json.text || json.words || json.transcription || json.transcript)) {
          transcriptData = json;
        }
      }).catch(() => { });
    }
  });

  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);

    async function dismissCookieBanner(waitFor = true) {
      try {
        const cookieSelector = 'button:has-text("Accept all cookies"), button:has-text("Allow all"), button:has-text("Reject all")';
        const cookieBtn = waitFor
          ? await page.waitForSelector(cookieSelector, { timeout: 2500 }).catch(() => null)
          : await page.$(cookieSelector).catch(() => null);
        if (cookieBtn && await cookieBtn.isVisible().catch(() => false)) {
          await cookieBtn.click().catch(() => { });
          await page.waitForTimeout(500);
          console.log('✅ Dismissed cookie banner.');
        }
      } catch (e) { }
    }

    await dismissCookieBanner(true);

    // Support both new hero dropzone and classic upload UI
    console.log('🔍 Checking upload card ready state...');
    await dismissCookieBanner(false);

    const fileSizeMB = (fs.statSync(audioPath).size / (1024 * 1024)).toFixed(1);
    console.log(`📤 Uploading ${path.basename(audioPath)} (${fileSizeMB} MB) to ElevenLabs web form...`);
    const fileInput = await page.$('input[type="file"]');
    if (!fileInput) {
      throw new Error('Could not find file upload input on ElevenLabs page.');
    }

    // Set input files natively without artificial DOM dispatchEvent interference
    await page.setInputFiles('input[type="file"]', audioPath);
    console.log(`⏳ File input attached. Waiting for ElevenLabs transcription to start...`);

    // Wait for transcription completion:
    // Support very long audio (3h+) with adaptive waiting as long as the loader is actively processing
    let extractedText = '';
    let rawTimestampedText = '';
    const maxSafetyWaitMs = 120 * 60 * 1000; // 120 minutes max safety limit
    const startTime = Date.now();
    let uploadConfirmed = false;
    let lastLogSec = -1;

    while (Date.now() - startTime < maxSafetyWaitMs) {
      // 1. Check for immediate API rejection
      if (backendError) {
        throw new Error(backendError);
      }

      // 2. Check for immediate error messages / alerts in the UI
      const uiError = await page.evaluate(() => {
        const body = document.body.innerText || '';
        const errorPhrases = [
          'Unusual activity has been detected',
          'Free Tier access has been disabled',
          'exceeded your free limit',
          'limit is exhausted',
          'Upload failed',
          'File exceeds',
          'Something went wrong',
          'maximum file duration',
          'reached the limit',
          'limit of available requests',
          'signing up to the platform'
        ];
        for (const phrase of errorPhrases) {
          if (body.toLowerCase().includes(phrase.toLowerCase())) {
            return phrase;
          }
        }
        return null;
      });

      if (uiError) {
        throw new Error(`ElevenLabs UI Error: ${uiError}`);
      }

      // 3. Check if Scribe API JSON was intercepted directly
      if (transcriptData && (transcriptData.words || transcriptData.segments || transcriptData.text)) {
        rawTimestampedText = generateTimestampedTxt(transcriptData);
        extractedText = transcriptData.text || '';
        break;
      }

      // 4. Check UI state: is it actively transcribing, finished, or idle upload card?
      const status = await page.evaluate(() => {
        const body = document.body.innerText || '';
        const floatingCard = document.querySelector('[data-testid="stt-hero-floating-card"]');
        const cardTitle = document.querySelector('[data-testid="stt-hero-card-title"]');
        const dropzone = document.querySelector('[data-testid="stt-hero-input-dropzone"]');
        const allButtons = Array.from(document.querySelectorAll('button'));

        // Scope processing checks strictly to the floating card
        const card = floatingCard || document.querySelector('main') || document.body;
        const cardText = (card ? card.innerText : body).toLowerCase();

        // 1. Actively processing / transcribing stages (scoped strictly to card carousel messages or active spinners)
        const processingPhrases = [
          'aligning word timestamps',
          'detecting speakers',
          'formatting the transcript',
          'almost there, polishing the results',
          'almost there',
          'please wait while we transcribe'
        ];
        const matchedPhase = processingPhrases.find(phrase => cardText.includes(phrase));
        const hasSpinner = Boolean(document.querySelector('[data-state="loading"], [role="progressbar"], .animate-spin, svg.animate-spin'));
        const hasCardTitle = Boolean(cardTitle);

        // 2. Check if finished transcript is truly rendered with actual text content
        const hiddenContainers = Array.from(document.querySelectorAll('div.tw-opacity-0, div.tw-h-px.tw-opacity-0'));
        let maxHiddenLen = 0;
        for (const hc of hiddenContainers) {
          const t = (hc.innerText || '').trim();
          if (t.length > maxHiddenLen) maxHiddenLen = t.length;
        }
        const hasHiddenTranscriptText = maxHiddenLen > 50;

        // Visible speaker turns strictly INSIDE the card
        let hasCardSpeakerTurns = false;
        if (floatingCard) {
          const cardTurns = floatingCard.querySelectorAll('p.tw-type-xs');
          for (const ct of cardTurns) {
            const txt = (ct.innerText || '').trim();
            if (/speaker\s*\d+/i.test(txt) || /speaker/i.test(txt)) {
              hasCardSpeakerTurns = true;
              break;
            }
          }
        }

        const hasClassicDownloadBtn = allButtons.some(b => (b.innerText || b.textContent || '').trim().toLowerCase() === 'download');
        const hasClassicSpeaker = body.includes('Speaker 1') || body.includes('speaker_1') || body.includes('Speaker 0');

        const hasNoTranscript = body.includes('NO TRANSCRIPT AVAILABLE');
        const isFinished = !matchedPhase && (hasHiddenTranscriptText || hasCardSpeakerTurns || (hasClassicDownloadBtn && hasClassicSpeaker));
        const isTranscribing = !isFinished && (Boolean(matchedPhase) || hasSpinner || hasCardTitle);
        const isUploadScreen = !isFinished && !isTranscribing && Boolean(dropzone);

        return {
          isTranscribing,
          isFinished,
          hasNoTranscript,
          isUploadScreen,
          activePhase: matchedPhase || (hasSpinner ? 'processing audio' : (hasCardTitle ? 'analyzing audio' : '')),
          previewText: cardText.slice(0, 150).replace(/\s+/g, ' ').trim()
        };
      });

      if (status.isTranscribing || status.fileInputHasFiles) {
        if (!uploadConfirmed) {
          console.log(`⚡ [Upload Confirmed] ElevenLabs started processing the audio!`);
          uploadConfirmed = true;
        }
      }

      // Transcription completed in UI
      if (status.isFinished && !status.hasNoTranscript) {
        console.log(`🎯 [Transcript Ready] Transcription finished on page! Extracting content...`);

        // Method 0 (New UI): Extract full 100% transcript from the hidden DOM container
        try {
          extractedText = await page.evaluate(() => {
            const hiddenContainer = Array.from(document.querySelectorAll('div.tw-opacity-0')).find(el => el.querySelector('p.tw-type-sm'))
              || document.querySelector('div.tw-h-px.tw-opacity-0');
            if (hiddenContainer) {
              const blocks = [];
              const pairs = hiddenContainer.querySelectorAll('.tw-flex.tw-flex-col.tw-gap-\\[13px\\], div:has(> p.tw-type-xs)');
              if (pairs.length > 0) {
                let unnumberedCount = 0;
                for (const pair of pairs) {
                  const speakerEl = pair.querySelector('p.tw-type-xs');
                  const textEl = pair.querySelector('p.tw-type-sm');
                  let rawSpeaker = (speakerEl?.innerText || '').trim();
                  let speaker = 'Speaker 1';
                  const spkMatch = rawSpeaker.match(/(?:speaker|spk)\s*([0-9a-zA-Z_]+)/i);
                  if (spkMatch) {
                    const cleanNum = spkMatch[1].replace(/^_+/, '');
                    speaker = /^\d+$/.test(cleanNum) ? `Speaker ${cleanNum}` : `Speaker ${cleanNum}`;
                  } else {
                    unnumberedCount++;
                    speaker = unnumberedCount % 2 === 1 ? 'Speaker 1' : 'Speaker 2';
                  }
                  const text = (textEl?.innerText || '').trim();
                  if (text) {
                    blocks.push(`${speaker}\n${text}`);
                  }
                }
                if (blocks.length > 0) return blocks.join('\n\n');
              }
              const speakerEls = hiddenContainer.querySelectorAll('p.tw-type-xs');
              const textEls = hiddenContainer.querySelectorAll('p.tw-type-sm');
              if (textEls.length > 0) {
                let unnumberedCount = 0;
                for (let i = 0; i < textEls.length; i++) {
                  let rawSpeaker = (speakerEls[i]?.innerText || '').trim();
                  let speaker = 'Speaker 1';
                  const spkMatch = rawSpeaker.match(/(?:speaker|spk)\s*([0-9a-zA-Z_]+)/i);
                  if (spkMatch) {
                    const cleanNum = spkMatch[1].replace(/^_+/, '');
                    speaker = /^\d+$/.test(cleanNum) ? `Speaker ${cleanNum}` : `Speaker ${cleanNum}`;
                  } else {
                    unnumberedCount++;
                    speaker = unnumberedCount % 2 === 1 ? 'Speaker 1' : 'Speaker 2';
                  }
                  const text = (textEls[i]?.innerText || '').trim();
                  if (text) {
                    blocks.push(`${speaker}\n${text}`);
                  }
                }
                if (blocks.length > 0) return blocks.join('\n\n');
              }
              const rawText = (hiddenContainer.innerText || '').trim();
              if (rawText.length > 50) return rawText;
            }
            return '';
          });
          if (extractedText && extractedText.length > 50) {
            console.log(`   ✨ Successfully extracted full 100% transcript from hidden DOM container (${extractedText.length} chars)!`);
          }
        } catch (e) { }

        // Method 0b (New UI visible card): Extract from visible cards if hidden container was not used
        if (!extractedText) {
          try {
            extractedText = await page.evaluate(() => {
              const card = document.querySelector('[data-testid="stt-hero-floating-card"]') || document.body;
              const pairs = card.querySelectorAll('.tw-flex.tw-flex-col.tw-gap-\\[13px\\], div:has(> p.tw-type-xs)');
              if (pairs.length > 0) {
                const blocks = [];
                let unnumberedCount = 0;
                for (const pair of pairs) {
                  const speakerEl = pair.querySelector('p.tw-type-xs');
                  const textEl = pair.querySelector('p.tw-type-sm');
                  let rawSpeaker = (speakerEl?.innerText || '').trim();
                  let speaker = 'Speaker 1';
                  const spkMatch = rawSpeaker.match(/(?:speaker|spk)\s*([0-9a-zA-Z_]+)/i);
                  if (spkMatch) {
                    const cleanNum = spkMatch[1].replace(/^_+/, '');
                    speaker = /^\d+$/.test(cleanNum) ? `Speaker ${cleanNum}` : `Speaker ${cleanNum}`;
                  } else {
                    unnumberedCount++;
                    speaker = unnumberedCount % 2 === 1 ? 'Speaker 1' : 'Speaker 2';
                  }
                  const text = (textEl?.innerText || '').trim();
                  if (text && !text.includes('Unlock full transcript')) {
                    blocks.push(`${speaker}\n${text}`);
                  }
                }
                if (blocks.length > 0) return blocks.join('\n\n');
              }
              return '';
            });
            if (extractedText && extractedText.length > 50) {
              console.log(`   ✨ Successfully extracted transcript from visible DOM card (${extractedText.length} chars)!`);
            }
          } catch (e) { }
        }

        // Method A: Click the Copy Button and read clipboard
        if (!extractedText) {
          try {
            const copyButton = await page.$('button:has(svg.lucide-copy), button[aria-label*="copy" i], button:has-text("Copy")');
            if (copyButton) {
              await copyButton.click();
              await page.waitForTimeout(800);
              const clip = await page.evaluate(async () => {
                try { return await navigator.clipboard.readText(); } catch (e) { return ''; }
              });
              if (clip && clip.length > 50 && !isMarketingOrJunk(clip) && (/\bspeaker\b/i.test(clip) || clip.length > 150)) {
                extractedText = clip;
              }
            }
          } catch (e) { }
        }

        // Method B: Single-pass linear extraction from DOM without ancestor duplication
        if (!extractedText) {
          extractedText = await page.evaluate(() => {
            const body = document.body.innerText || '';
            const speakerMatch = body.search(/\bspeaker[\s_-]*\d+\b/i);
            if (speakerMatch === -1) {
              return '';
            }

            let transcript = body.substring(speakerMatch);

            const stopMarkers = [
              'What languages does Scribe support?',
              'Frequently asked questions',
              'EXPERIENCE THE FULL AUDIO AI PLATFORM',
              'DEVELOPERS',
              'LANGUAGE OVERVIEW',
              'Powered by ElevenLabs'
            ];

            for (const marker of stopMarkers) {
              const idx = transcript.indexOf(marker);
              if (idx !== -1) {
                transcript = transcript.substring(0, idx);
              }
            }

            return transcript.trim();
          });
        }

        if (extractedText && !isMarketingOrJunk(extractedText) && extractedText.length > 50) {
          break;
        } else {
          extractedText = '';
        }
      }

      // Log progress periodically with explicit timestamped newlines (NO \r overwriting)
      const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
      const mins = Math.floor(elapsedSec / 60);
      const secs = elapsedSec % 60;
      const timeStr = `${mins}m ${secs < 10 ? '0' : ''}${secs}s`;

      if (elapsedSec > 0 && elapsedSec % 10 === 0 && elapsedSec !== lastLogSec) {
        lastLogSec = elapsedSec;
        let stateDesc = 'waiting...';
        if (status.isTranscribing) {
          stateDesc = status.activePhase
            ? `⚡ Actively transcribing (${status.activePhase})...`
            : '⚡ Actively transcribing (processing audio)...';
        } else if (status.isFinished) {
          stateDesc = '🎯 Transcript ready, extracting text...';
        } else if (status.isUploadScreen) {
          stateDesc = '⏸️ Upload card idle (waiting for processing to begin)';
        }
        console.log(`⏳ [${timeStr}] UI State: ${stateDesc}`);
      }

      await page.waitForTimeout(3000);
    }

    if (!extractedText && transcriptData && transcriptData.text) {
      extractedText = transcriptData.text;
    }

    if (!extractedText) {
      throw new Error(`Transcription timed out or could not extract text after waiting ${Math.floor((Date.now() - startTime) / 60000)} minutes.`);
    }

    console.log(`\n💾 [3/3] Saving outputs to ${videoFolder}...`);

    const cleanTxtPath = path.join(videoFolder, `${folderName}_clean.txt`);
    const rawTxtPath = path.join(videoFolder, `${folderName}_raw.txt`);

    // 1. Try to download the exact timestamped .txt directly from ElevenLabs Download button if not already generated
    if (!rawTimestampedText) {
      try {
        const downloadBtn = await page.$('button:has-text("Download")');
        if (downloadBtn) {
        console.log('   Clicking "Download" button to open formats menu...');
        await downloadBtn.click();
        await page.waitForTimeout(1000);

        // Find the specific leaf element for "txt" among the 6 options (txt, srt, doc, pdf, html, json)
        const txtOptionHandle = await page.evaluateHandle(() => {
          const elements = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], button, a, div, span, p'));
          const otherFormats = ['srt', 'doc', 'pdf', 'html', 'json'];

          // Filter to leaf elements that are strictly the txt option
          const candidates = elements.filter(el => {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return false;
            const text = (el.innerText || el.textContent || '').trim().toLowerCase();
            if (!text) return false;

            // Must NOT contain other format names (so it is not the menu wrapper or dropdown container)
            if (otherFormats.some(fmt => text.includes(fmt))) return false;

            // Check if matches txt, .txt, text, or plain text
            return text === 'txt' || text === '.txt' || text === 'text (.txt)' || text === 'plain text (.txt)' || text === 'text' || /^txt\b/i.test(text);
          });

          if (candidates.length === 0) {
            // Fallback: any element whose text includes 'txt' and excludes other formats
            const fallback = elements.filter(el => {
              const text = (el.innerText || el.textContent || '').trim().toLowerCase();
              return text.includes('txt') && !otherFormats.some(fmt => text.includes(fmt));
            });
            candidates.push(...fallback);
          }

          if (candidates.length > 0) {
            // Sort by shortest text length to pick the exact leaf item
            candidates.sort((a, b) => (a.innerText || '').trim().length - (b.innerText || '').trim().length);
            return candidates[0];
          }
          return null;
        });

        const txtOption = txtOptionHandle.asElement();
        if (txtOption) {
          const optionText = (await txtOption.innerText().catch(() => '')).trim();
          console.log(`   🎯 Selected menu option: "${optionText}"`);

          const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 15000 }),
            txtOption.click()
          ]);
          await download.saveAs(rawTxtPath);
          rawTimestampedText = fs.readFileSync(rawTxtPath, 'utf-8');
          console.log(`   📥 Downloaded transcript via Download button (${path.basename(rawTxtPath)})`);
        } else {
          console.log(`   ⚠️ Could not locate "txt" option in download dropdown.`);
        }
      }
    } catch (e) {
      console.warn(`   (UI download button notice: ${e.message})`);
    }
  }

    // Fallback: If UI download didn't produce raw text, construct from intercepted API response
    if (!rawTimestampedText && transcriptData) {
      rawTimestampedText = generateTimestampedTxt(transcriptData);
    }
    if (rawTimestampedText) {
      fs.writeFileSync(rawTxtPath, rawTimestampedText, 'utf-8');
    } else if (extractedText) {
      fs.writeFileSync(rawTxtPath, extractedText, 'utf-8');
    }

    // 2. Generate clean, NotebookLM-friendly transcript (no timestamps, merged consecutive speaker sections)
    let cleanTranscript = '';
    if (rawTimestampedText) {
      cleanTranscript = formatCleanTranscript(rawTimestampedText);
    } else if (extractedText) {
      cleanTranscript = formatCleanTranscript(extractedText) || extractedText.trim();
    }

    if (!cleanTranscript || cleanTranscript.length < 50 || isMarketingOrJunk(cleanTranscript)) {
      throw new Error('Transcription finished but could not extract valid text.');
    }

    // Save outputs:
    // 1. Clean transcript (both as <name>.txt and <name>_clean.txt for easy NotebookLM consumption)
    fs.writeFileSync(cleanTxtPath, cleanTranscript, 'utf-8');
    fs.writeFileSync(txtPath, cleanTranscript, 'utf-8');

    // 2. Save JSON metadata
    const jsonOutput = {
      title: rawTitle,
      sourceUrl: youtubeUrl,
      language: lang,
      date: new Date().toISOString(),
      cleanTranscript: cleanTranscript,
      rawTimestampedTranscript: rawTimestampedText || null,
      rawApiResponse: transcriptData || null
    };
    fs.writeFileSync(jsonPath, JSON.stringify(jsonOutput, null, 2), 'utf-8');

    console.log(`\n✅ Done! Files Created in ${videoFolder}:`);
    console.log(`1. 🎵 Audio:                ${path.basename(audioPath)}`);
    console.log(`2. 📄 Clean Transcript:     ${path.basename(cleanTxtPath)} (Ready for NotebookLM)`);
    if (fs.existsSync(rawTxtPath)) {
      console.log(`3. ⏱️ Raw Timestamps:       ${path.basename(rawTxtPath)} (Original download from ElevenLabs)`);
    }
    console.log(`4. 📊 Metadata JSON:        ${path.basename(jsonPath)}\n`);

  } finally {
    await context.close();
  }
}

// CLI Argument Handling
const rawArgs = process.argv.slice(2);

if (rawArgs.length === 0 || rawArgs.includes('--help') || rawArgs.includes('-h')) {
  console.log(`
Usage:
  yta-transcribe [options] <YouTube_URL | Playlist_URL | file.txt>
  yta-transcribe <YouTube_URL | Playlist_URL | file.txt> [options]

Options:
  --lang, -l     Language to use: 'english' / 'en' (default) or 'hindi' / 'hi'
  --out, -o      Output directory (default: ./transcripts)
  --headed       Run browser in visible mode (default: headless)
  --help, -h     Show this help message

Modes:
  1. Single Video: Pass a standard YouTube video URL.
  2. Playlist:     Pass a YouTube playlist URL (all videos will be transcribed).
  3. Batch File:   Pass a text file (e.g. input-hi.txt, input-en.txt) with one URL per line.

Examples:
  # Playlist Transcription
  yta-transcribe -l hi "https://www.youtube.com/playlist?list=PLAYLIST_ID"
  yta-transcribe -l en "https://www.youtube.com/playlist?list=PLAYLIST_ID"

  # Single Video
  yta-transcribe -l hi "https://www.youtube.com/watch?v=VIDEO_ID"
  yta-transcribe "https://www.youtube.com/watch?v=VIDEO_ID"

  # Batch File
  yta-transcribe input-hi.txt
  yta-transcribe input-en.txt
`);
  process.exit(0);
}

let target = null;
let lang = null;
let outDir = 'transcripts';
let headed = false;

for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (arg === '--lang' || arg === '-l') {
    const val = rawArgs[i + 1]?.toLowerCase();
    lang = val === 'hindi' || val === 'hi' ? 'hindi' : 'english';
    i++;
  } else if (arg === '--out' || arg === '-o') {
    outDir = rawArgs[i + 1];
    i++;
  } else if (arg === '--headed') {
    headed = true;
  } else if (!arg.startsWith('-')) {
    target = arg;
  }
}

// If no target given, check for input-hi.txt, input-en.txt, or input.txt
if (!target) {
  if (fs.existsSync('input-hi.txt')) {
    target = 'input-hi.txt';
  } else if (fs.existsSync('input-en.txt')) {
    target = 'input-en.txt';
  } else if (fs.existsSync('input.txt')) {
    target = 'input.txt';
  } else {
    console.error('Error: Please provide a YouTube video URL, playlist URL, or a file path (e.g., input-hi.txt, input-en.txt, input.txt).');
    process.exit(1);
  }
}

// Auto-detect language from filename if not explicitly specified via flag
if (!lang) {
  const lowerTarget = target.toLowerCase();
  if (lowerTarget.includes('hi') || lowerTarget.includes('hindi')) {
    lang = 'hindi';
  } else {
    lang = 'english';
  }
}

function resolvePlaylistUrls(url) {
  const hasPlaylist = /youtube\.com\/playlist\?/i.test(url) || /[?&]list=([a-zA-Z0-9_-]+)/i.test(url);
  if (!hasPlaylist) {
    return [url];
  }

  console.log(`\n📋 Detected YouTube Playlist: ${url}`);
  console.log(`   Fetching video URLs from playlist using yt-dlp...`);

  let fetched = [];
  const cmd = spawnSync('yt-dlp', [
    '--flat-playlist',
    '--cookies-from-browser', 'chrome',
    '--extractor-args', 'youtube:player_client=mweb,android',
    '--print', 'webpage_url',
    url
  ], { encoding: 'utf-8' });

  if (cmd.stdout) {
    fetched = cmd.stdout
      .trim()
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('http'));
  }

  if (fetched.length === 0) {
    const fallback = spawnSync('yt-dlp', [
      '--flat-playlist',
      '--print', 'webpage_url',
      url
    ], { encoding: 'utf-8' });

    if (fallback.stdout) {
      fetched = fallback.stdout
        .trim()
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.startsWith('http'));
    }
  }

  if (fetched.length > 0) {
    console.log(`   ✅ Extracted ${fetched.length} videos from playlist.`);
    return fetched;
  }

  console.warn(`   ⚠️ Could not extract playlist items; will attempt as single URL.`);
  return [url];
}

async function main() {
  let rawUrls = [];

  // Check if target is an existing text file
  if (fs.existsSync(target) && fs.statSync(target).isFile()) {
    console.log(`📄 Reading URLs from batch file: ${target} [Language: ${lang}]`);
    const lines = fs.readFileSync(target, 'utf-8').split('\n');
    rawUrls = lines
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#'));
  } else {
    rawUrls = [target];
  }

  // Expand any playlist URLs into individual video URLs
  let urls = [];
  for (const item of rawUrls) {
    const expanded = resolvePlaylistUrls(item);
    urls.push(...expanded);
  }

  console.log(`\nTotal ${urls.length} video(s) queued for transcription [Language: ${lang}].`);

  const completedIds = getCompletedVideoIds(outDir);
  if (completedIds.size > 0) {
    console.log(`⚡ Found ${completedIds.size} already completed transcripts in "${outDir}".`);
  }

  for (let idx = 0; idx < urls.length; idx++) {
    const currentUrl = urls[idx];
    const idMatch = currentUrl.match(/(?:v=|\/)([a-zA-Z0-9_-]{11})(?:[&?]|$)/);
    const videoId = idMatch ? idMatch[1] : null;

    if (videoId && completedIds.has(videoId)) {
      console.log(`⏩ [${idx + 1}/${urls.length}] Transcript already exists (${videoId}). Skipping instantly.`);
      continue;
    }

    console.log(`\n======================================================`);
    console.log(`▶️ Processing (${idx + 1}/${urls.length}): ${currentUrl}`);
    console.log(`======================================================`);

    let success = false;
    while (!success) {
      try {
        await transcribeVideo(currentUrl, { lang, outputDir: outDir, headed });
        if (videoId) completedIds.add(videoId);
        success = true;
      } catch (err) {
        const msg = err.message || String(err);
        const isAuthOrRateLimit = msg.includes('401') ||
          msg.toLowerCase().includes('unauthorized') ||
          msg.toLowerCase().includes('limit') ||
          msg.toLowerCase().includes('unusual activity');

        if (isAuthOrRateLimit) {
          console.error(`\n🛑 ElevenLabs Free Tier Guest Limit Hit on this IP: ${msg}`);
          console.log(`👉 Please rotate your IP (e.g. toggle Airplane Mode on your phone hotspot or switch VPN location).`);
          const answer = await askUser(`   Press [ENTER] to retry this video, 's' to skip, or 'q' to quit: `);
          if (answer.toLowerCase() === 'q') {
            console.log('Quitting batch transcription.');
            process.exit(0);
          } else if (answer.toLowerCase() === 's') {
            console.log(`Skipping: ${currentUrl}`);
            break;
          } else {
            console.log(`🔄 Retrying video: ${currentUrl}...`);
            continue;
          }
        } else {
          console.error(`❌ Failed processing ${currentUrl}:`, msg);
          break;
        }
      }
    }
  }

  console.log(`\n🎉 All jobs completed!`);
}

main().catch(err => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});



