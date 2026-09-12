import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(stealthPlugin());

async function inspectTranscriptArea() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://elevenlabs.io/speech-to-text/hindi', { waitUntil: 'networkidle' });

  // Listen to network requests when transcribing
  page.on('request', req => {
    if (req.url().includes('speech-to-text') || req.url().includes('transcribe') || req.url().includes('elevenlabs')) {
      console.log('REQUEST:', req.method(), req.url());
    }
  });

  page.on('response', async res => {
    if (res.url().includes('speech-to-text') || res.url().includes('transcribe')) {
      console.log('RESPONSE:', res.status(), res.url());
      try {
        const text = await res.text();
        console.log('RESPONSE BODY SAMPLE:', text.slice(0, 300));
      } catch(e) {}
    }
  });

  // Check the copy button or transcript container
  const copyBtns = await page.$$('button:has(svg)');
  console.log(`Found ${copyBtns.length} icon buttons.`);

  await browser.close();
}

inspectTranscriptArea().catch(console.error);
