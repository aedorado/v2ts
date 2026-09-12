import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'path';

chromium.use(stealthPlugin());

/**
 * Automates browser interaction with ElevenLabs Speech-to-Text service.
 * Works seamlessly in both local environments and headless CI runners (GitHub Actions).
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
    permissions: ['clipboard-read', 'clipboard-write'],
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();
  let transcriptData = null;

  // Intercept the backend transcription API response
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
      } catch (e) {
        // Response parsing ignored if not valid json
      }
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
    } catch (e) {
      // Ignore cookie banner dismissal errors
    }

    console.log(`Uploading ${path.basename(audioPath)} to ElevenLabs web form...`);
    const fileInput = await page.$('input[type="file"]');
    if (!fileInput) {
      throw new Error('Could not find file upload input on ElevenLabs page.');
    }

    await fileInput.setInputFiles(audioPath);
    console.log(`Waiting for transcription to complete...`);

    let extractedText = '';
    const maxWaitMs = 1200000; // ~20 minutes max wait for long lectures
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      // 1. Check if API JSON was intercepted directly
      if (transcriptData && transcriptData.text) {
        extractedText = transcriptData.text;
        break;
      }

      // 2. Check if transcription is completed in UI
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
        } catch (e) {
          // Clipboard fallback ignored
        }

        // Method B: Extract text from all speaker paragraphs in DOM
        const domText = await page.evaluate(() => {
          const blocks = Array.from(document.querySelectorAll('div, p'))
            .filter(el => el.innerText && (el.innerText.startsWith('SPEAKER ') || el.innerText.includes('SPEAKER 1')));
          if (blocks.length > 0) {
            return blocks.map(b => b.innerText.trim()).join('\n\n');
          }
          
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
      // Fallback: try one last time to extract text from page body before throwing
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

    return {
      extractedText: extractedText || '',
      rawApiResponse: transcriptData
    };

  } finally {
    await browser.close();
  }
}
