import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import path from 'path';

chromium.use(stealthPlugin());

async function testUpload() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  console.log('Navigating...');
  await page.goto('https://elevenlabs.io/speech-to-text/hindi', { waitUntil: 'networkidle', timeout: 45000 });

  // Handle cookie popup if present
  try {
    const cookieBtn = await page.$('#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll, button:has-text("Allow all"), button:has-text("Accept")');
    if (cookieBtn) {
      await cookieBtn.click();
      console.log('Dismissed cookie banner');
    }
  } catch (e) {}

  // Create dummy audio file to test upload mechanism
  const dummyWav = path.resolve('test_audio.wav');
  // Simple 1 sec blank wav
  const wavHeader = Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x24, 0x08, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
    0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x44, 0xac, 0x00, 0x00, 0x88, 0x58, 0x01, 0x00,
    0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61, 0x00, 0x08, 0x00, 0x00
  ]);
  const wavData = Buffer.alloc(2048);
  fs.writeFileSync(dummyWav, Buffer.concat([wavHeader, wavData]));

  console.log('Uploading test audio to input[type="file"]...');
  const fileInput = await page.$('input[type="file"]');
  if (!fileInput) {
    console.error('File input not found!');
    await browser.close();
    return;
  }

  await fileInput.setInputFiles(dummyWav);
  console.log('File uploaded to input.');

  // Wait a few seconds to observe UI changes
  await page.waitForTimeout(5000);

  // Take screenshot of state
  await page.screenshot({ path: 'after_upload.png' });
  console.log('Screenshot saved to after_upload.png');

  // Check buttons again to see "Transcribe" or "Generate"
  const buttons = await page.$$eval('button', els => els.map(el => ({ text: el.innerText.trim(), className: el.className })));
  console.log('Buttons after upload:', JSON.stringify(buttons.filter(b => b.text.length > 0), null, 2));

  await browser.close();
}

testUpload().catch(console.error);
