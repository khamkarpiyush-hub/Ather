import { createLibp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { identify } from '@libp2p/identify';
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import fs from 'fs';

const KEY_FILE = './relay-key.json';

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

async function main() {
  const port = process.env.PORT || 10000;
  const privateKey = await getOrCreatePrivateKey();

  const server = await createLibp2p({
    privateKey,
    addresses: {
      listen: [`/ip4/0.0.0.0/tcp/${port}/ws`]
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

  console.log(`\n🚀 SwarmVault Relay running with PubSub!`);
  console.log(`   Peer ID: ${peerId}`);
  console.log(`\n📋 Copy this multiaddr into p2p.js bootstrap list:`);
  server.getMultiaddrs().forEach((ma) => {
    console.log(`   ${ma.toString()}`);
  });
  console.log(`\n   For Render deployment, use:`);
  console.log(`   /dns/swarmvault-relay.onrender.com/tcp/443/wss/p2p/${peerId}\n`);

  // ─── Enhanced Signaling + Data Relay Server ───
  // This server handles:
  // 1. Peer discovery (broadcasting peer IDs)
  // 2. Actual encrypted chunk distribution between peers
  // 3. Chunk retrieval requests
  import('ws').then(({ WebSocketServer }) => {
    const wss = new WebSocketServer({ port: 10001 });
    console.log(`📡 Signaling + Data Relay Server running on ws://0.0.0.0:10001`);
    
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
                try { oldWs.close(); } catch(e) {}
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
                let found = false;
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
  });
}

main().catch((err) => {
  console.error('Failed to start relay server:', err);
  process.exit(1);
});