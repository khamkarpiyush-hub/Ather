import { createLibp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { webRTC } from '@libp2p/webrtc';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery';
import { identify } from '@libp2p/identify';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { bootstrap } from '@libp2p/bootstrap';

// ─── Constants ───
const RELAY_PEER_ID = '12D3KooWAQhWksCm5kE41QFg1D4yEyWQEY7Ed4BFrGA5pDt955xJ';

let libp2pNode;
let activePeers = new Map();

// ─── Signaling WebSocket (the REAL data channel) ───
let signalingWs = null;
let localPeerId = null;
const pendingChunkRequests = new Map(); // chunkId -> { resolve, reject, timeout }
let onFileSharedCallback = null; // callback when a peer shares a file with us

// ─── Hosted Chunks Store (chunks this device stores for OTHER peers) ───
const HOSTED_CHUNKS = new Map();

// ─── IndexedDB helpers ───
function getDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('SwarmVaultDB', 2);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('chunks')) {
        db.createObjectStore('chunks');
      }
      if (!db.objectStoreNames.contains('hosted')) {
        db.createObjectStore('hosted');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ─── Connect to Signaling + Data Relay Server ───
function connectSignalingServer(peerId, onPeerDiscovered, onPeerLost, onFileReceived) {
  onFileSharedCallback = onFileReceived;
  const wsHost = typeof window !== 'undefined' ? window.location.hostname : '127.0.0.1';
  const signalingUrl = `ws://${wsHost}:10001`;
  
  localPeerId = peerId;
  signalingWs = new WebSocket(signalingUrl);
  
  signalingWs.onopen = () => {
    console.log('📡 Connected to Signaling + Data Relay Server');
    // Announce ourselves
    signalingWs.send(JSON.stringify({ type: 'announce', peerId }));
    
    // Keep-alive heartbeat
    setInterval(() => {
      if (signalingWs.readyState === WebSocket.OPEN) {
        signalingWs.send(JSON.stringify({ type: 'announce', peerId }));
      }
    }, 15000);
  };

  signalingWs.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      
      switch (msg.type) {
        case 'peer-joined': {
          const pid = msg.peerId;
          if (pid !== peerId && pid !== RELAY_PEER_ID && !activePeers.has(pid)) {
            activePeers.set(pid, pid);
            if (onPeerDiscovered) onPeerDiscovered(pid);
            console.log('✅ Real peer connected:', pid.slice(-8));
          }
          break;
        }
        
        case 'peer-left': {
          const pid = msg.peerId;
          if (activePeers.has(pid)) {
            activePeers.delete(pid);
            if (onPeerLost) onPeerLost(pid);
            console.log('👋 Peer disconnected:', pid.slice(-8));
          }
          break;
        }
        
        // Another peer sent us a chunk to host
        case 'receive-chunk': {
          const { chunkId, data, fromPeerId } = msg;
          const chunkData = base64ToUint8Array(data);
          HOSTED_CHUNKS.set(chunkId, chunkData);
          
          // Persist to IndexedDB
          try {
            const db = await getDB();
            await new Promise((resolve) => {
              const tx = db.transaction('hosted', 'readwrite');
              tx.objectStore('hosted').put(chunkData, chunkId);
              tx.oncomplete = resolve;
            });
          } catch (e) {}
          
          console.log(`📦 Hosting chunk ${chunkId.slice(-12)} from peer ${fromPeerId?.slice(-8)} (${chunkData.byteLength} bytes)`);
          break;
        }
        
        // Server is asking us if we have a chunk someone else needs
        case 'find-chunk': {
          const { chunkId, requesterId } = msg;
          let chunkData = HOSTED_CHUNKS.get(chunkId);
          
          if (!chunkData) {
            try {
              const db = await getDB();
              chunkData = await new Promise(resolve => {
                const req = db.transaction('hosted').objectStore('hosted').get(chunkId);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => resolve(null);
              });
            } catch (e) {}
          }
          
          // Also check local chunks store
          if (!chunkData) {
            try {
              const db = await getDB();
              chunkData = await new Promise(resolve => {
                const req = db.transaction('chunks').objectStore('chunks').get(chunkId);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => resolve(null);
              });
            } catch (e) {}
          }
          
          if (chunkData) {
            signalingWs.send(JSON.stringify({
              type: 'chunk-found',
              chunkId,
              data: uint8ArrayToBase64(new Uint8Array(chunkData)),
              requesterId
            }));
            console.log(`📤 Served chunk ${chunkId.slice(-12)} to peer ${requesterId?.slice(-8)}`);
          }
          break;
        }
        
        // Response to our chunk request
        case 'chunk-response': {
          const { chunkId, data, found } = msg;
          const pending = pendingChunkRequests.get(chunkId);
          if (pending) {
            clearTimeout(pending.timeout);
            pendingChunkRequests.delete(chunkId);
            if (found && data) {
              pending.resolve(base64ToUint8Array(data));
            } else {
              pending.resolve(null);
            }
          }
          break;
        }
        
        // Another peer shared a file with us
        case 'file-shared': {
          const { fileInfo, fromPeerId } = msg;
          console.log(`📂 Received shared file "${fileInfo.name}" from peer ${fromPeerId?.slice(-8)}`);
          if (onFileSharedCallback) {
            onFileSharedCallback(fileInfo, fromPeerId);
          }
          break;
        }
      }
    } catch (e) {
      // Ignore parse errors
    }
  };
  
  signalingWs.onerror = (err) => {
    console.warn('⚠️ Signaling server connection error. Make sure relay.js is running.');
  };
  
  signalingWs.onclose = () => {
    console.warn('⚠️ Signaling server disconnected. Attempting reconnect in 3s...');
    setTimeout(() => connectSignalingServer(peerId, onPeerDiscovered, onPeerLost, onFileReceived), 3000);
  };
}

// ─── Base64 helpers for WebSocket chunk transport ───
function uint8ArrayToBase64(uint8Array) {
  let binary = '';
  const len = uint8Array.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(uint8Array[i]);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ─── Init P2P Node ───
export async function initP2PNode(onPeerDiscovered, onPeerLost, onFileReceived) {
  libp2pNode = await createLibp2p({
    addresses: {
      listen: ['/webrtc']
    },
    transports: [
      webSockets(),
      webRTC(),
      circuitRelayTransport()
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      pubsub: gossipsub({ allowPublishToZeroTopicPeers: true }),
      identify: identify()
    },
    peerDiscovery: [
      bootstrap({
        list: [
          typeof window !== 'undefined' 
            ? `/ip4/${window.location.hostname === 'localhost' ? '127.0.0.1' : window.location.hostname}/tcp/10000/ws/p2p/${RELAY_PEER_ID}`
            : `/ip4/127.0.0.1/tcp/10000/ws/p2p/${RELAY_PEER_ID}`
        ]
      }),
      pubsubPeerDiscovery({
        topics: ['swarmvault-discovery']
      })
    ]
  });

  await libp2pNode.start();
  
  const myPeerId = libp2pNode.peerId.toString();
  console.log('🔐 P2P Node started with ID:', myPeerId);

  // Connect to the signaling + data relay server for REAL peer discovery and data transfer
  connectSignalingServer(myPeerId, onPeerDiscovered, onPeerLost, onFileReceived);

  return libp2pNode;
}

// ─── Distribute chunks to peers via signaling relay ───
export async function distributeChunks(node, chunks, peerIdStrings) {
  const distributionManifest = {};
  const db = await getDB();
  
  // Filter to real peers only
  const realPeers = peerIdStrings.filter(p => p !== 'local-network-mock' && p !== RELAY_PEER_ID);
  const hasRealPeers = realPeers.length > 0 && signalingWs && signalingWs.readyState === WebSocket.OPEN;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkId = `chunk-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`;

    // Always store locally first (as backup)
    await new Promise((resolve) => {
      const tx = db.transaction('chunks', 'readwrite');
      tx.objectStore('chunks').put(chunk, chunkId);
      tx.oncomplete = resolve;
    });

    if (hasRealPeers) {
      // Distribute to a real peer via the signaling relay
      const targetPeer = realPeers[i % realPeers.length];
      
      try {
        const base64Data = uint8ArrayToBase64(chunk);
        signalingWs.send(JSON.stringify({
          type: 'store-chunk',
          chunkId,
          data: base64Data,
          targetPeerId: targetPeer
        }));
        
        distributionManifest[i] = `peer:${targetPeer}:${chunkId}`;
        console.log(`📤 Distributed chunk ${i} (${chunk.byteLength} bytes) to peer ${targetPeer.slice(-8)}`);
        continue;
      } catch (err) {
        console.warn(`⚠️ Could not distribute chunk ${i} to peer, storing locally:`, err.message);
      }
    }

    // No peers or send failed — local-only
    distributionManifest[i] = chunkId;
  }

  return distributionManifest;
}

// ─── Fetch chunks back for retrieval ───
export async function fetchChunks(node, manifest) {
  const retrievedChunks = [];
  const db = await getDB();

  for (const [chunkIndex, locationStr] of Object.entries(manifest)) {
    // Case 1: Chunk is on a remote peer
    if (locationStr.startsWith('peer:')) {
      const parts = locationStr.split(':');
      const peerIdStr = parts[1];
      const chunkId = parts.slice(2).join(':');

      // Try fetching from the relay server first
      if (signalingWs && signalingWs.readyState === WebSocket.OPEN) {
        try {
          const chunkData = await requestChunkFromRelay(chunkId);
          if (chunkData) {
            retrievedChunks.push(chunkData);
            console.log(`✅ Retrieved chunk ${chunkIndex} from relay/peers`);
            continue;
          }
        } catch (err) {
          console.warn(`⚠️ Relay fetch failed for chunk ${chunkIndex}:`, err.message);
        }
      }

      // Fallback: try local IndexedDB
      const localChunk = await new Promise(resolve => {
        const req = db.transaction('chunks').objectStore('chunks').get(chunkId);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      });
      if (localChunk) {
        retrievedChunks.push(new Uint8Array(localChunk));
        console.log(`📂 Retrieved chunk ${chunkIndex} from local backup`);
        continue;
      }

      console.error(`❌ Could not retrieve chunk ${chunkIndex} — peer offline and no local copy`);
      continue;
    }

    // Case 2: Chunk is stored locally in IndexedDB
    const localChunk = await new Promise(resolve => {
      const req = db.transaction('chunks').objectStore('chunks').get(locationStr);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });

    if (localChunk) {
      retrievedChunks.push(new Uint8Array(localChunk));
    } else {
      console.error(`❌ Missing local chunk: ${locationStr}`);
    }
  }

  return retrievedChunks;
}

// ─── Request a chunk from the relay server ───
function requestChunkFromRelay(chunkId) {
  return new Promise((resolve, reject) => {
    if (!signalingWs || signalingWs.readyState !== WebSocket.OPEN) {
      return resolve(null);
    }
    
    const timeout = setTimeout(() => {
      pendingChunkRequests.delete(chunkId);
      resolve(null); // Timeout — chunk not found
    }, 5000);
    
    pendingChunkRequests.set(chunkId, { resolve, reject, timeout });
    
    signalingWs.send(JSON.stringify({
      type: 'request-chunk',
      chunkId
    }));
  });
}

// ─── Hosted Chunk Stats (for proof-of-hosting UI) ───
export function getHostedChunkStats() {
  let totalBytes = 0;
  for (const chunk of HOSTED_CHUNKS.values()) {
    totalBytes += chunk.byteLength || chunk.length || 0;
  }
  return {
    count: HOSTED_CHUNKS.size,
    totalBytes,
  };
}

// Load persisted hosted chunks from IndexedDB on startup
export async function loadHostedChunksFromDB() {
  try {
    const db = await getDB();
    return new Promise((resolve) => {
      const tx = db.transaction('hosted', 'readonly');
      const store = tx.objectStore('hosted');
      const cursorReq = store.openCursor();
      let loaded = 0;

      cursorReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          HOSTED_CHUNKS.set(cursor.key, cursor.value);
          loaded++;
          cursor.continue();
        } else {
          console.log(`📂 Loaded ${loaded} hosted chunks from IndexedDB`);
          resolve(loaded);
        }
      };
      cursorReq.onerror = () => resolve(0);
    });
  } catch (e) {
    console.warn('Could not load hosted chunks from IndexedDB:', e);
    return 0;
  }
}

// ─── Share a file's metadata with all connected peers ───
export function shareFileToNetwork(fileInfo) {
  if (signalingWs && signalingWs.readyState === WebSocket.OPEN) {
    signalingWs.send(JSON.stringify({
      type: 'share-file',
      fileInfo
    }));
    console.log(`📤 Shared file "${fileInfo.name}" with network peers`);
  } else {
    console.warn('Cannot share file — not connected to signaling server');
  }
}

export { RELAY_PEER_ID };