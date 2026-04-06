#!/usr/bin/env node
// test-cdp-zp.mjs — Test Chrome headless with real profile against ZonaProp Cloudflare
// Copies user's Chrome profile to /tmp, launches headless, checks if ZP loads

import puppeteer from 'puppeteer-core';
import { execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';

const TEST_URL = 'https://www.zonaprop.com.ar/propiedades/clasificado/veclcain-casa-en-villa-riachuelo-57216406.html';
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const REAL_PROFILE = `${process.env.HOME}/Library/Application Support/Google/Chrome`;
const TMP_PROFILE = '/tmp/zp-chrome-profile';

async function main() {
  // Step 1: Copy Chrome profile (just Default + root files, skip heavy dirs)
  console.log('1. Copying Chrome profile to /tmp...');
  if (existsSync(TMP_PROFILE)) {
    execSync(`rm -rf "${TMP_PROFILE}"`);
  }
  mkdirSync(TMP_PROFILE, { recursive: true });

  // Copy only cookies and essential files - not session restore data
  mkdirSync(`${TMP_PROFILE}/Default`, { recursive: true });
  execSync(`cp "${REAL_PROFILE}/Default/Cookies" "${TMP_PROFILE}/Default/Cookies" 2>/dev/null || true`);
  execSync(`cp "${REAL_PROFILE}/Default/Preferences" "${TMP_PROFILE}/Default/Preferences" 2>/dev/null || true`);
  execSync(`cp "${REAL_PROFILE}/Local State" "${TMP_PROFILE}/Local State" 2>/dev/null || true`);

  // Remove lock files from copy
  execSync(`rm -f "${TMP_PROFILE}/SingletonLock" "${TMP_PROFILE}/SingletonSocket" "${TMP_PROFILE}/SingletonCookie" 2>/dev/null || true`);

  console.log('   Done.\n');

  // Step 2: Launch headless Chrome with copied profile
  console.log('2. Launching Chrome headless with real profile...');
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: false,
    userDataDir: TMP_PROFILE,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--remote-debugging-port=9223',
      '--window-position=-2560,-2560',
      '--window-size=1440,900',
    ],
  });

  const page = await browser.newPage();

  // Set a realistic viewport
  await page.setViewport({ width: 1440, height: 900 });

  console.log('   Browser launched.\n');

  // Step 3: Navigate to ZP
  console.log(`3. Navigating to: ${TEST_URL}`);
  try {
    const response = await page.goto(TEST_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    const status = response?.status();
    console.log(`   HTTP status: ${status}\n`);

    // Step 4: Check what we got
    const title = await page.title();
    console.log(`4. Page title: "${title}"`);

    const isCloudflare = title.toLowerCase().includes('moment') ||
                         title.toLowerCase().includes('just a moment') ||
                         title.toLowerCase().includes('attention');

    if (isCloudflare) {
      console.log('   ⚠️  CLOUDFLARE CHALLENGE DETECTED - waiting 10s and retrying...');
      await new Promise(r => setTimeout(r, 10000));
      const title2 = await page.title();
      console.log(`   After wait: "${title2}"`);
    }

    // Step 5: Try to extract data
    const data = await page.evaluate(() => {
      const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
      let house = null;
      for (const s of ldScripts) {
        try {
          const j = JSON.parse(s.textContent);
          if (j['@type'] === 'House' || j['@type'] === 'Apartment') house = j;
        } catch {}
      }
      const body = document.body.innerText.substring(0, 3000);
      return { house, bodyLength: body.length, bodyPreview: body.substring(0, 500), title: document.title };
    });

    console.log(`\n5. Results:`);
    console.log(`   JSON-LD found: ${data.house ? 'YES' : 'NO'}`);
    if (data.house) {
      console.log(`   Type: ${data.house['@type']}`);
      console.log(`   Address: ${data.house.address?.streetAddress || 'N/A'}`);
      console.log(`   Bedrooms: ${data.house.numberOfBedrooms || 'N/A'}`);
      console.log(`   Image: ${data.house.image ? 'YES' : 'NO'}`);
      console.log(`   Phone: ${data.house.telephone || 'N/A'}`);
    }
    console.log(`   Body text length: ${data.bodyLength} chars`);
    console.log(`   Body preview: "${data.bodyPreview.substring(0, 200)}..."`);

    const success = data.bodyLength > 500 && !data.bodyPreview.includes('security verification');
    console.log(`\n${success ? '✅ SUCCESS - CDP headless works against ZP Cloudflare!' : '❌ BLOCKED - Cloudflare detected headless'}`);

  } catch (err) {
    console.log(`   ❌ Navigation error: ${err.message}`);
  }

  await browser.close();
  console.log('\nBrowser closed.');

  // Cleanup
  execSync(`rm -rf "${TMP_PROFILE}"`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
