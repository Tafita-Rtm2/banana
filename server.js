p
require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// NOTE: Use only on sites you own or have permission to test.
app.get('/scrap', async (req, res) => {
  const {
    siteUrl,           // url de la page (ex: https://monsite/editeur)
    imageUrl,          // url de l'image source (optionnel si ton UI accepte upload)
    prompt,            // prompt text
    imageSelector,     // css selector pour le champ d'url image (ex: input#image-url)
    promptSelector,    // css selector pour le champ prompt (ex: textarea#prompt)
    buttonSelector,    // css selector pour le bouton 'generate' (ex: button#gen)
    resultSelector,    // css selector du <img> ou élément contenant l'image finale
    waitForText        // optionnel: texte à attendre (ex: 'Finished') au lieu d'un imageSelector
  } = req.query;

  if (!siteUrl || !prompt || !promptSelector || !buttonSelector || !resultSelector) {
    return res.status(400).json({
      error: 'Paramètres requis: siteUrl, prompt, promptSelector, buttonSelector, resultSelector (imageSelector optionnel)'
    });
  }

  const BROWSER_TIMEOUT = Number(process.env.BROWSER_TIMEOUT_MS || 120000);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Va sur la page (attendre load)
    await page.goto(siteUrl, { waitUntil: 'networkidle2', timeout: BROWSER_TIMEOUT });

    // If imageUrl is provided and there's an imageSelector, fill it
    if (imageUrl && imageSelector) {
      await page.waitForSelector(imageSelector, { timeout: 10000 });
      await page.evaluate(
        (sel, val) => { const el = document.querySelector(sel); if (el) { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); } },
        imageSelector, imageUrl
      );
    }

    // Fill the prompt
    await page.waitForSelector(promptSelector, { timeout: 10000 });
    await page.evaluate(
      (sel, val) => { const el = document.querySelector(sel); if (el) { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); } },
      promptSelector, prompt
    );

    // Click generate button
    await page.waitForSelector(buttonSelector, { timeout: 10000 });
    await page.click(buttonSelector);

    // Attendre le résultat: soit un texte (waitForText), soit présence d'une image element
    if (waitForText) {
      await page.waitForFunction(
        (txt) => document.body && document.body.innerText.includes(txt),
        { timeout: BROWSER_TIMEOUT },
        waitForText
      );
    } else {
      await page.waitForSelector(resultSelector, { timeout: BROWSER_TIMEOUT });
    }

    // Récupère la source de l'image (peut être data:... ou blob:... ou url)
    const imgSrc = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      // si c'est <img>
      if (el.tagName.toLowerCase() === 'img') return el.src;
      // si c'est background-image
      const bg = window.getComputedStyle(el).backgroundImage || '';
      const m = bg.match(/url\(["']?(.*?)["']?\)/);
      if (m) return m[1];
      // else, retourne texte si disponible
      return el.textContent || null;
    }, resultSelector);

    if (!imgSrc) {
      throw new Error('Impossible de récupérer src de l\'image via le sélecteur fourni.');
    }

    // Si c'est une data URL on convertit directement
    if (imgSrc.startsWith('data:')) {
      const match = imgSrc.match(/^data:(.+);base64,(.*)$/);
      if (!match) throw new Error('Src data: mais format inattendu');
      const contentType = match[1];
      const b64 = match[2];
      const buf = Buffer.from(b64, 'base64');
      res.setHeader('Content-Type', contentType);
      await browser.close();
      return res.send(buf);
    }

    // Si c'est un blob: ou autre URL relatif -> fetch via page context (respecte CORS du site)
    if (imgSrc.startsWith('blob:') || imgSrc.startsWith('/') || imgSrc.startsWith(windowLocationPlaceholder())) {
      // effectue fetch dans la page context (ainsi CORS du site est respecté)
      const result = await page.evaluate(async (src) => {
        // fetch la ressource et renvoyer base64
        const response = await fetch(src);
        const blob = await response.blob();
        const arrayBuffer = await blob.arrayBuffer();
        // convert to base64
        let binary = '';
        const bytes = new Uint8Array(arrayBuffer);
        const chunk = 0;
        const len = bytes.byteLength;
        const CHUNK = 0x8000;
        for (let i = 0; i < len; i += CHUNK) {
          const slice = bytes.subarray(i, i + CHUNK);
          binary += String.fromCharCode.apply(null, slice);
        }
        return {
          contentType: blob.type || 'application/octet-stream',
          b64: btoa(binary)
        };
      }, imgSrc);

      const buf = Buffer.from(result.b64, 'base64');
      res.setHeader('Content-Type', result.contentType);
      await browser.close();
      return res.send(buf);
    }

    // Sinon c'est une URL publique (http(s)://) — on la télécharge côté serveur
    if (/^https?:\/\//i.test(imgSrc)) {
      const r = await axios.get(imgSrc, { responseType: 'arraybuffer', timeout: 30000 });
      const contentType = r.headers['content-type'] || 'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      await browser.close();
      return res.send(Buffer.from(r.data, 'binary'));
    }

    // Fallback: retourne l'URL trouvée
    await browser.close();
    return res.status(200).json({ message: 'Image src trouvée mais format non géré', src: imgSrc });

  } catch (err) {
    try { if (browser) await browser.close(); } catch (e) {}
    console.error('Erreur /scrap puppeteer:', err);
    return res.status(500).json({ error: err.message || String(err) });
  }

  // tiny function placeholder so linter n'aime pas window - mais on ne l'expose pas.
  function windowLocationPlaceholder() { return ''; }
});

app.listen(PORT, () => {
  console.log(`Puppeteer proxy listening on ${PORT}`);
});
