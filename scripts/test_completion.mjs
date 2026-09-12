import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'path';

chromium.use(stealthPlugin());

async function monitorFullTranscription() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  page.on('response', async res => {
    const url = res.url();
    if (res.request().resourceType() === 'fetch' || res.request().resourceType() === 'xhr') {
      console.log('XHR/FETCH:', res.status(), url);
      try {
        const text = await res.text();
        console.log('RESPONSE DATA:', text.slice(0, 300));
      } catch (e) {}
    }
  });

  console.log('Navigating...');
  await page.goto('https://elevenlabs.io/speech-to-text/hindi', { waitUntil: 'networkidle' });

  // Dismiss cookie
  try {
    const btn = await page.$('#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll, button:has-text("Allow all"), button:has-text("Accept all")');
    if (btn) await btn.click();
  } catch (e) {}

  const audioFile = path.resolve('transcripts/16_ME_Mount/16_ME_Mount.mp3');
  console.log('Uploading file...');
  const fileInput = await page.$('input[type="file"]');
  await fileInput.setInputFiles(audioFile);

  console.log('Uploaded! Polling for completion (up to 2 minutes)...');
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(2000);
    const state = await page.evaluate(() => {
      const trans = document.querySelector('div:has(> p), div[class*="transcript"]');
      const body = document.body.innerText;
      return {
        hasTranscribing: body.includes('TRANSCRIBING') || body.includes('Transcribing'),
        hasNoTranscript: body.includes('NO TRANSCRIPT'),
        textSample: trans ? trans.innerText.slice(0, 100) : ''
      };
    });
    console.log(`[${i*2}s]`, JSON.stringify(state));
    if (!state.hasTranscribing && !state.hasNoTranscript && state.textSample) {
      console.log('TRANSCRIPTION READY!');
      break;
    }
  }

  await page.screenshot({ path: 'after_completion.png' });
  await browser.close();
}

monitorFullTranscription().catch(console.error);
