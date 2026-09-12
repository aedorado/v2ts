import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(stealthPlugin());

async function inspectElevenLabs() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  console.log('Navigating to https://elevenlabs.io/speech-to-text/hindi...');
  await page.goto('https://elevenlabs.io/speech-to-text/hindi', { waitUntil: 'networkidle', timeout: 45000 });

  // Get title
  console.log('Page Title:', await page.title());

  // Check all input elements
  const inputs = await page.$$eval('input', els => els.map(el => ({ type: el.type, name: el.name, id: el.id, accept: el.accept, className: el.className })));
  console.log('Inputs found:', JSON.stringify(inputs, null, 2));

  // Check buttons
  const buttons = await page.$$eval('button', els => els.map(el => ({ text: el.innerText.trim(), className: el.className, type: el.type })));
  console.log('Buttons found:', JSON.stringify(buttons.slice(0, 15), null, 2));

  // Look for text areas or upload dropzones
  const dropzones = await page.$$eval('div[class*="upload"], div[class*="drop"], div[class*="file"], label[class*="upload"], label[class*="drop"], label[class*="file"]', els => els.map(el => ({
    tag: el.tagName,
    text: el.innerText.trim().slice(0, 80),
    className: el.className
  })));
  console.log('Dropzones/Labels found:', JSON.stringify(dropzones, null, 2));

  await browser.close();
}

inspectElevenLabs().catch(console.error);
