import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'path';

chromium.use(stealthPlugin());

async function testExtraction() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  await page.goto('https://elevenlabs.io/speech-to-text/hindi', { waitUntil: 'networkidle' });

  // Dismiss cookie
  try {
    const btn = await page.$('#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll, button:has-text("Allow all"), button:has-text("Accept all")');
    if (btn) await btn.click();
  } catch (e) {}

  const audioFile = path.resolve('transcripts/13_JU_Mount/13_JU_Mount.mp3');
  console.log('Uploading audio...');
  const fileInput = await page.$('input[type="file"]');
  await fileInput.setInputFiles(audioFile);

  console.log('Waiting for completion...');
  for (let i = 0; i < 90; i++) {
    await page.waitForTimeout(2000);
    const body = await page.evaluate(() => document.body.innerText);
    const isTranscribing = body.includes('TRANSCRIBING') || body.includes('Please wait while we transcribe');
    if (!isTranscribing && body.includes('SPEAKER')) {
      console.log(`Ready at ~${i*2}s! Testing extraction methods...`);
      
      // Method 1: Find the copy button right next to Download
      const copyBtn = await page.$('button:has(svg.lucide-copy), button:has(svg):near(button:has-text("Download")), button[class*="rounded-full"]:has(svg)');
      console.log('Found copy button:', !!copyBtn);
      
      // Method 2: Extract text directly from the container
      const transcriptText = await page.evaluate(() => {
        // Find element containing SPEAKER 1 and inspect its full hierarchy
        const el = Array.from(document.querySelectorAll('*')).find(e => e.innerText && e.innerText.includes('SPEAKER 1') && e.children.length > 2);
        if (el) {
          return {
            tagName: el.tagName,
            className: el.className,
            textPreview: el.innerText.slice(0, 300),
            totalLength: el.innerText.length
          };
        }
        return null;
      });

      console.log('Method 2 result:', transcriptText);
      break;
    }
  }

  await browser.close();
}

testExtraction().catch(console.error);
