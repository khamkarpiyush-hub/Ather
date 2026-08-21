import { resolve } from 'path';
import { fileURLToPath } from 'url';
const require = module.createRequire(import.meta.url);
try {
  const all = require('@libp2p/websockets/filters');
  console.log("Resolved via require:", all);
} catch (e) {
  console.log("Require failed");
}
