import { createLibp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { identify } from '@libp2p/identify';
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import net from 'node:net';
import fs from 'fs';

const KEY_FILE = './relay-key.json';
const SIGNALING_PATH = '/signaling';

// The single port Render exposes. Everything public is multiplexed onto this.
const PUBLIC_PORT = Number(process.env.PORT || 10000);

// @libp2p/websockets@10 cannot attach to an existing http.Server (its
// WebSocketsInit accepts only http/https *options* and always creates its own
// net.Server). So we bind it to a loopback-only port and proxy upgrades to it
// from the public server below. Loopback means it is never directly reachable.
const LIBP2P_PORT = PUBLIC_PORT === 10101 ? 10102 : 10101;

// Render sets this; used so the relay announces its public address instead of
// the loopback one it actually listens on.
const PUBLIC_HOST = process.env.RENDER_EXTERNAL_HOSTNAME;

async function getOrCreatePrivateKey() {
  if (fs.existsSync(KEY_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(KEY_FILE, 'utf-8'));
      return privateKeyFromProtobuf(Uint8Array.from(raw));
    } catch (e) {
      console.warn('⚠️  Could not load saved key, generating new one:', e.message);
    }
  }

  const privateKey = await generateKeyPair('Ed25519');
  const protobuf = privateKeyToProtobuf(privateKey);
  fs.writeFileSync(KEY_FILE, JSON.stringify(Array.from(protobuf)));
  console.log('🔑 Generated and saved new persistent relay key.');
  return privateKey;
}

// ─── Signaling + Data Relay logic ───
// Handles peer discovery, encrypted chunk distribution and chunk retrieval.
// Attached with noServer:true so it can share a port with libp2p: ws aborts
// non-matching upgrades with a 400 when given { server, path }, which would
// reject libp2p's own upgrades on '/'. We route by path ourselves instead.
function createSignalingServer() {
  const wss = new WebSocketServer({ noServer: true });

  // Track connected peers: peerId -> ws connection
  const connectedPeers = new Map();
  // Store chunks that peers have distributed: chunkId -> { data (base64), ownerPeerId }
  const chunkStore = new Map();

  // Helper: clean up dead connections
  function cleanupDeadPeers() {
    for (const [pid, pWs] of connectedPeers) {
      if (pWs.readyState !== 1) { // 1 = OPEN
        connectedPeers.delete(pid);
      }
    }
  }

  // Helper: get only live peer count
  function livePeerCount() {
    let count = 0;
    for (const [, pWs] of connectedPeers) {
      if (pWs.readyState === 1) count++;
    }
    return count;
  }

  wss.on('connection', (ws) => {
    let thisPeerId = null;

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        switch (msg.type) {
          // ── Peer announces itself ──
          case 'announce': {
            const isFirstAnnounce = thisPeerId === null || thisPeerId !== msg.peerId;
            thisPeerId = msg.peerId;

            // Clean up any old connection for this peer ID (handles HMR reloads)
            const oldWs = connectedPeers.get(thisPeerId);
            if (oldWs && oldWs !== ws) {
              try { oldWs.close(); } catch (e) {}
            }

            connectedPeers.set(thisPeerId, ws);
            cleanupDeadPeers();

            if (isFirstAnnounce) {
              // Tell this new peer about all existing LIVE peers
              for (const [existingPeerId, existingWs] of connectedPeers) {
                if (existingPeerId !== thisPeerId && existingWs.readyState === 1) {
                  ws.send(JSON.stringify({ type: 'peer-joined', peerId: existingPeerId }));
                }
              }

              // Tell all existing LIVE peers about this new peer
              for (const [existingPeerId, existingWs] of connectedPeers) {
                if (existingPeerId !== thisPeerId && existingWs.readyState === 1) {
                  existingWs.send(JSON.stringify({ type: 'peer-joined', peerId: thisPeerId }));
                }
              }

              console.log(`👤 Peer connected: ${thisPeerId.slice(-8)} (total: ${livePeerCount()})`);
            }
            break;
          }

          // ── Peer stores a chunk on the relay ──
          case 'store-chunk': {
            const { chunkId, data, targetPeerId } = msg;
            chunkStore.set(chunkId, { data, ownerPeerId: thisPeerId });

            // If target peer is online, forward the chunk to them for local caching
            const targetWs = connectedPeers.get(targetPeerId);
            if (targetWs && targetWs.readyState === 1) {
              targetWs.send(JSON.stringify({
                type: 'receive-chunk',
                chunkId,
                data,
                fromPeerId: thisPeerId
              }));
            }

            console.log(`📦 Stored chunk ${chunkId.slice(-12)} from ${thisPeerId?.slice(-8)} (store size: ${chunkStore.size})`);
            break;
          }

          // ── Peer requests a chunk ──
          case 'request-chunk': {
            const { chunkId: reqId } = msg;
            const stored = chunkStore.get(reqId);

            if (stored) {
              ws.send(JSON.stringify({
                type: 'chunk-response',
                chunkId: reqId,
                data: stored.data,
                found: true
              }));
              console.log(`📤 Served chunk ${reqId.slice(-12)} to ${thisPeerId?.slice(-8)}`);
            } else {
              // Ask all peers if they have it
              for (const [pId, pWs] of connectedPeers) {
                if (pId !== thisPeerId && pWs.readyState === 1) {
                  pWs.send(JSON.stringify({ type: 'find-chunk', chunkId: reqId, requesterId: thisPeerId }));
                }
              }
              // If nobody responds, send not found after a short delay
              setTimeout(() => {
                if (!chunkStore.has(reqId)) {
                  ws.send(JSON.stringify({ type: 'chunk-response', chunkId: reqId, found: false }));
                }
              }, 2000);
            }
            break;
          }

          // ── Peer responds with a chunk another peer was looking for ──
          case 'chunk-found': {
            const { chunkId: foundId, data: foundData, requesterId } = msg;
            chunkStore.set(foundId, { data: foundData, ownerPeerId: thisPeerId });

            const requesterWs = connectedPeers.get(requesterId);
            if (requesterWs && requesterWs.readyState === 1) {
              requesterWs.send(JSON.stringify({
                type: 'chunk-response',
                chunkId: foundId,
                data: foundData,
                found: true
              }));
            }
            break;
          }

          // ── Peer shares file metadata with the network ──
          case 'share-file': {
            const fileInfo = msg.fileInfo;
            // Broadcast to all other connected peers
            for (const [pId, pWs] of connectedPeers) {
              if (pId !== thisPeerId && pWs.readyState === 1) {
                pWs.send(JSON.stringify({
                  type: 'file-shared',
                  fileInfo,
                  fromPeerId: thisPeerId
                }));
              }
            }
            console.log(`📂 File "${fileInfo.name}" shared to ${livePeerCount() - 1} live peers by ${thisPeerId?.slice(-8)}`);
            break;
          }

          default:
            console.warn('Unknown message type:', msg.type);
        }
      } catch (e) {
        // Legacy: plain text peer ID announcement (backward compat)
        // Ignore parse errors from old clients
      }
    });

    ws.on('close', () => {
      if (thisPeerId) {
        // Only delete if THIS ws is still the registered one (not replaced by HMR reload)
        if (connectedPeers.get(thisPeerId) === ws) {
          connectedPeers.delete(thisPeerId);
        }
        cleanupDeadPeers();
        // Notify all remaining LIVE peers
        for (const [pId, pWs] of connectedPeers) {
          if (pWs.readyState === 1) {
            pWs.send(JSON.stringify({ type: 'peer-left', peerId: thisPeerId }));
          }
        }
        console.log(`👋 Peer disconnected: ${thisPeerId.slice(-8)} (total: ${livePeerCount()})`);
      }
    });
  });

  return wss;
}

// ─── Forward a WebSocket upgrade to libp2p's loopback listener ───
function proxyUpgradeToLibp2p(req, socket, head) {
  const upstream = net.connect(LIBP2P_PORT, '127.0.0.1', () => {
    // Replay the original request line + headers, then hand over the raw stream
    let preamble = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      preamble += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    upstream.write(`${preamble}\r\n`);
    if (head?.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });

  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
}

async function main() {
  const privateKey = await getOrCreatePrivateKey();

  const server = await createLibp2p({
    privateKey,
    addresses: {
      // Loopback only — public traffic arrives via the proxy below.
      listen: [`/ip4/127.0.0.1/tcp/${LIBP2P_PORT}/ws`],
      // Advertise the public address rather than 127.0.0.1, so peers that
      // learn our addresses over identify/pubsub get something dialable.
      announce: PUBLIC_HOST ? [`/dns4/${PUBLIC_HOST}/tcp/443/wss`] : []
    },
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      relay: circuitRelayServer(),
      pubsub: gossipsub({ allowPublishToZeroTopicPeers: true }),
      identify: identify()
    }
  });

  const peerId = server.peerId.toString();

  server.services.pubsub.subscribe('swarmvault-discovery');
  server.services.pubsub.subscribe('_peer-discovery._p2p._pubsub');

  // ─── Single public HTTP server: health checks + both WebSocket services ───
  const httpServer = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', peerId }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`SwarmVault relay\nPeer ID: ${peerId}\nSignaling: ${SIGNALING_PATH}\n`);
  });

  const wss = createSignalingServer();

  // Route upgrades by path: /signaling -> our JSON protocol, everything else -> libp2p
  httpServer.on('upgrade', (req, socket, head) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch (e) {
      pathname = '/';
    }

    socket.setNoDelay(true);

    if (pathname === SIGNALING_PATH) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
      return;
    }

    proxyUpgradeToLibp2p(req, socket, head);
  });

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(PUBLIC_PORT, '0.0.0.0', resolve);
  });

  console.log(`\n🚀 SwarmVault Relay running with PubSub!`);
  console.log(`   Peer ID: ${peerId}`);
  console.log(`🌐 Single public port: ${PUBLIC_PORT}`);
  console.log(`📡 Signaling + Data Relay: ws://0.0.0.0:${PUBLIC_PORT}${SIGNALING_PATH}`);
  console.log(`🔗 libp2p websockets proxied from the same port (loopback :${LIBP2P_PORT})`);
  console.log(`\n📋 Copy this multiaddr into p2p.js bootstrap list:`);
  server.getMultiaddrs().forEach((ma) => {
    console.log(`   ${ma.toString()}`);
  });
  console.log(`\n   For Render deployment, use:`);
  console.log(`   /dns4/swarmvault-relay.onrender.com/tcp/443/wss/p2p/${peerId}\n`);
}

main().catch((err) => {
  console.error('Failed to start relay server:', err);
  process.exit(1);
});
