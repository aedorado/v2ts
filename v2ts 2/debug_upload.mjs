import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'path';

chromium.use(stealthPlugin());

async function testWebUpload() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  page.on('response', async res => {
    const url = res.url();
    if (url.includes('speech-to-text') || url.includes('transcribe') || url.includes('scribe') || url.includes('history')) {
      console.log('HTTP RESP:', res.status(), url);
      try {
        const text = await res.text();
        console.log('BODY:', text.slice(0, 200));
      } catch (e) {}
    }
  });

  console.log('Navigating to https://elevenlabs.io/speech-to-text/hindi...');
  await page.goto('https://elevenlabs.io/speech-to-text/hindi', { waitUntil: 'networkidle' });

  // Dismiss cookie
  try {
    const btn = await page.$('#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll, button:has-text("Allow all"), button:has-text("Accept all")');
    if (btn) await btn.click();
  } catch (e) {}

  const audioFile = path.resolve('transcripts/16_ME_Mount/16_ME_Mount.mp3');
  console.log('Uploading file:', audioFile);
  const fileInput = await page.$('input[type="file"]');
  await fileInput.setInputFiles(audioFile);

  console.log('Waiting 15 seconds to observe...');
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(1000);
    const progress = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('*')).map(el => el.innerText).filter(t => t && (t.includes('%') || t.includes('Transcribing') || t.includes('Processing') || t.includes('Uploading')))[0] || '';
    });
    if (progress) console.log('UI state:', progress.slice(0, 100));
  }

  await page.screenshot({ path: 'test_upload_state.png' });
  console.log('Screenshot saved.');

  await browser.close();
}

testWebUpload().catch(console.error);
