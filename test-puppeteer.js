const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  
  async function createTab(name) {
    const page = await browser.newPage();
    page.on('console', msg => {
      const txt = msg.text();
      if (txt.includes('P2P Node started') || txt.includes('Discovered') || txt.includes('Connected to peer') || txt.includes('Manual pubsub heartbeat')) {
        console.log(`[${name}] ${txt}`);
      }
    });
    await page.goto('http://localhost:5173');
    // Click login
    await page.waitForSelector('button', { timeout: 5000 });
    const buttons = await page.$$('button');
    for (let b of buttons) {
      const text = await page.evaluate(el => el.textContent, b);
      if (text.includes('Google')) {
        await b.click();
        break;
      }
    }
    return page;
  }

  console.log('Starting Tab 1...');
  const t1 = await createTab('Tab1');
  await new Promise(r => setTimeout(r, 3000));
  
  console.log('Starting Tab 2...');
  const t2 = await createTab('Tab2');
  
  await new Promise(r => setTimeout(r, 15000));
  await browser.close();
})();
