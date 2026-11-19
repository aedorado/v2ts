import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import path from 'path';

chromium.use(stealthPlugin());

/**
 * Checks if the extracted text accidentally scraped ElevenLabs homepage marketing copy.
 * @param {string} text 
 * @returns {boolean}
 */
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

/**
 * Dismisses cookie consent banners if present on the page.
 * @param {import('playwright').Page} page 
 * @param {boolean} waitFor 
 */
async function dismissCookieBanner(page, waitFor = true) {
  try {
    const cookieSelector = 'button:has-text("Accept all cookies"), button:has-text("Allow all"), button:has-text("Reject all"), #CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll';
    const cookieBtn = waitFor
      ? await page.waitForSelector(cookieSelector, { timeout: 2500 }).catch(() => null)
      : await page.$(cookieSelector).catch(() => null);
    if (cookieBtn && await cookieBtn.isVisible().catch(() => false)) {
      await cookieBtn.click().catch(() => {});
      await page.waitForTimeout(500);
      console.log('✅ Dismissed cookie banner.');
    }
  } catch (e) {}
}

/**
 * Automates browser interaction with ElevenLabs Speech-to-Text service.
 * Supports both the new Hero Floating Card UI and classic layouts.
 * Works seamlessly in local environments and headless CI runners (GitHub Actions).
 * 
 * @param {string} audioPath Absolute path to local .mp3 audio file
 * @param {string} lang 'english' or 'hindi'
 * @returns {Promise<{ extractedText: string, rawApiResponse: Object|null }>}
 */
export async function transcribeAudioWithElevenLabs(audioPath, lang = 'english') {
  const targetUrl = lang === 'hindi'
    ? 'https://elevenlabs.io/speech-to-text/hindi'
    : 'https://elevenlabs.io/speech-to-text/english';

  console.log(`\n🌐 Launching Playwright Chromium session for ElevenLabs (${lang})...`);

  // Flags required for headless execution in Linux / GitHub Actions & Docker containers
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu'
    ]
  });

  const context = await browser.newContext({
    acceptDownloads: true,
    permissions: ['clipboard-read', 'clipboard-write'],
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });

  const page = context.pages()[0] || await context.newPage();

  let transcriptData = null;
  let backendError = null;

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
          } catch (e) {}
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
      }).catch(() => {});
    }
  });

  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);

    await dismissCookieBanner(page, true);
    await dismissCookieBanner(page, false);

    const fileSizeMB = (fs.statSync(audioPath).size / (1024 * 1024)).toFixed(1);
    console.log(`📤 Uploading ${path.basename(audioPath)} (${fileSizeMB} MB) to ElevenLabs web form...`);

    const fileInput = await page.$('input[type="file"]');
    if (!fileInput) {
      throw new Error('Could not find file upload input on ElevenLabs page.');
    }

    // Set input files natively without artificial DOM dispatchEvent interference
    await page.setInputFiles('input[type="file"]', audioPath);
    console.log(`⏳ File input attached. Waiting for ElevenLabs transcription to start...`);

    let extractedText = '';
    const maxSafetyWaitMs = 120 * 60 * 1000; // 120 minutes max safety limit for long lectures
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
        if (transcriptData.text) {
          extractedText = transcriptData.text;
          break;
        }
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

        // Actively processing / transcribing stages
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

        // Check if finished transcript is truly rendered with actual text content in hidden container
        const hiddenContainers = Array.from(document.querySelectorAll('div.tw-opacity-0, div.tw-h-px.tw-opacity-0'));
        let maxHiddenLen = 0;
        for (const hc of hiddenContainers) {
          const t = (hc.innerText || '').trim();
          if (t.length > maxHiddenLen) maxHiddenLen = t.length;
        }
        const hasHiddenTranscriptText = maxHiddenLen > 50;

        // Visible speaker turns strictly inside the card
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
          activePhase: matchedPhase || (hasSpinner ? 'processing audio' : (hasCardTitle ? 'analyzing audio' : ''))
        };
      });

      if (status.isTranscribing) {
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
                  let speaker = 'SPEAKER 0';
                  const spkMatch = rawSpeaker.match(/(?:speaker|spk)\s*([0-9a-zA-Z_]+)/i);
                  if (spkMatch) {
                    const cleanNum = spkMatch[1].replace(/^_+/, '');
                    speaker = `SPEAKER ${cleanNum}`;
                  } else {
                    unnumberedCount++;
                    speaker = unnumberedCount % 2 === 1 ? 'SPEAKER 0' : 'SPEAKER 1';
                  }
                  const text = (textEl?.innerText || '').trim();
                  if (text) {
                    blocks.push(`${speaker}:\n${text}`);
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
                  let speaker = 'SPEAKER 0';
                  const spkMatch = rawSpeaker.match(/(?:speaker|spk)\s*([0-9a-zA-Z_]+)/i);
                  if (spkMatch) {
                    const cleanNum = spkMatch[1].replace(/^_+/, '');
                    speaker = `SPEAKER ${cleanNum}`;
                  } else {
                    unnumberedCount++;
                    speaker = unnumberedCount % 2 === 1 ? 'SPEAKER 0' : 'SPEAKER 1';
                  }
                  const text = (textEls[i]?.innerText || '').trim();
                  if (text) {
                    blocks.push(`${speaker}:\n${text}`);
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
            console.log(`   ✨ Successfully extracted full transcript from hidden DOM container (${extractedText.length} chars)!`);
          }
        } catch (e) {}

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
                  let speaker = 'SPEAKER 0';
                  const spkMatch = rawSpeaker.match(/(?:speaker|spk)\s*([0-9a-zA-Z_]+)/i);
                  if (spkMatch) {
                    const cleanNum = spkMatch[1].replace(/^_+/, '');
                    speaker = `SPEAKER ${cleanNum}`;
                  } else {
                    unnumberedCount++;
                    speaker = unnumberedCount % 2 === 1 ? 'SPEAKER 0' : 'SPEAKER 1';
                  }
                  const text = (textEl?.innerText || '').trim();
                  if (text && !text.includes('Unlock full transcript')) {
                    blocks.push(`${speaker}:\n${text}`);
                  }
                }
                if (blocks.length > 0) return blocks.join('\n\n');
              }
              return '';
            });
            if (extractedText && extractedText.length > 50) {
              console.log(`   ✨ Successfully extracted transcript from visible DOM card (${extractedText.length} chars)!`);
            }
          } catch (e) {}
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
          } catch (e) {}
        }

        // Method B: Single-pass linear extraction from DOM without ancestor duplication
        if (!extractedText) {
          extractedText = await page.evaluate(() => {
            const body = document.body.innerText || '';
            const speakerMatch = body.search(/\bspeaker[\s_-]*\d+\b/i);
            if (speakerMatch === -1) return '';

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
              if (idx !== -1) transcript = transcript.substring(0, idx);
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

      // Log progress periodically every 10 seconds
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

    return {
      extractedText: extractedText || '',
      rawApiResponse: transcriptData
    };

  } finally {
    await browser.close();
  }
}
