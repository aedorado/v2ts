import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'path';
import fs from 'fs';

chromium.use(stealthPlugin());

async function inspectPage(lang = 'hindi') {
  const url = lang === 'hindi' 
    ? 'https://elevenlabs.io/speech-to-text/hindi'
    : 'https://elevenlabs.io/speech-to-text/english';

  console.log(`Opening ${url}...`);
  const browser = await chromium.launch({
    headless: false, // Start visible to inspect interactive elements
  });
  
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log('Page loaded successfully.');

    // Look for file input or upload zones
    const fileInputs = await page.$$('input[type="file"]');
    console.log(`Found ${fileInputs.length} file inputs.`);

    // Find buttons on the page
    const buttons = await page.$$eval('button', (els) => els.map(el => ({ text: el.innerText.trim(), className: el.className })));
    console.log('Buttons found:', buttons.slice(0, 10));

    await page.waitForTimeout(5000);
  } catch (err) {
    console.error('Error during inspection:', err);
  } finally {
    await browser.close();
  }
}

inspectPage('hindi');
