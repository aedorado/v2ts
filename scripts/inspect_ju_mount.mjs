import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'path';

chromium.use(stealthPlugin());

async function inspectTranscriptDOM() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  let apiResponse = null;
  page.on('response', async res => {
    if (res.url().includes('speech-to-text')) {
      console.log('STT API URL:', res.status(), res.url());
      try {
        apiResponse = await res.json();
        console.log('API JSON Keys:', Object.keys(apiResponse));
        if (apiResponse.text) {
          console.log('API text preview:', apiResponse.text.slice(0, 100));
        }
      } catch (e) {
        console.log('Could not parse API json:', e.message);
      }
    }
  });

  await page.goto('https://elevenlabs.io/speech-to-text/hindi', { waitUntil: 'networkidle' });

  // Dismiss cookie
  try {
    const btn = await page.$('#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll, button:has-text("Allow all"), button:has-text("Accept all")');
    if (btn) await btn.click();
  } catch (e) {}

  const audioFile = path.resolve('transcripts/13_JU_Mount/13_JU_Mount.mp3');
  console.log('Uploading 13_JU_Mount.mp3...');
  const fileInput = await page.$('input[type="file"]');
  await fileInput.setInputFiles(audioFile);

  console.log('Waiting for completion...');
  for (let i = 0; i < 90; i++) {
    await page.waitForTimeout(2000);
    const body = await page.evaluate(() => document.body.innerText);
    const isTranscribing = body.includes('TRANSCRIBING') || body.includes('Please wait while we transcribe');
    if (!isTranscribing && (body.includes('SPEAKER') || apiResponse)) {
      console.log(`Finished at ~${i*2}s!`);
      
      // Inspect DOM elements containing transcript
      const dump = await page.evaluate(() => {
        // Find all divs or containers below the audio player
        const allTextNodes = Array.from(document.querySelectorAll('*'))
          .filter(el => el.children.length === 0 && el.innerText && el.innerText.length > 20)
          .map(el => ({ tag: el.tagName, text: el.innerText.slice(0, 60), class: el.className }));
        
        const copyBtns = Array.from(document.querySelectorAll('button'))
          .map(b => ({ text: b.innerText, ariaLabel: b.getAttribute('aria-label'), class: b.className }));

        return { allTextNodes: allTextNodes.slice(0, 10), copyBtns };
      });

      console.log('DOM DUMP:', JSON.stringify(dump, null, 2));
      break;
    }
  }

  await browser.close();
}

inspectTranscriptDOM().catch(console.error);
