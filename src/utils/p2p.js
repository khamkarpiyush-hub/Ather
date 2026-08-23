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
const RELAY_HOST = 'swarmvault-relay.onrender.com';
const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]', '::1'];
// Private LAN addresses (and mDNS *.local names) are dev too — without this a
// phone on 192.168.x.x:5173 would be treated as production and dial Render.
const PRIVATE_HOST_RE = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|\.local$/;

// True when served from a real domain (Vercel, etc.) rather than local dev.
// Production must use wss:// + /dns4/ — a hostname is not a valid /ip4/ address.
function isProduction() {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  if (LOCAL_HOSTNAMES.includes(host)) return false;
  return !PRIVATE_HOST_RE.test(host);
}

// In dev, dial whatever host served the page. On a LAN test device that is the
// dev machine's IP, so it reaches the relay there instead of its own loopback.
function devHost() {
  if (typeof window === 'undefined') return '127.0.0.1';
  return window.location.hostname;
}

// /ip4/ only accepts a numeric address, so 'localhost' has to go through /dns4/.
function devRelayMultiaddr() {
  const host = devHost();
  const proto = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? 'ip4' : 'dns4';
  return `/${proto}/${host}/tcp/10000/ws/p2p/${RELAY_PEER_ID}`;
}

let libp2pNode;
let activePeers = new Map();

// ─── Signaling WebSocket (the REAL data channel) ───
let signalingWs = null;
let localPeerId = null;
const pendingChunkRequests = new Map(); // chunkId -> { resolve, reject, timeout }
let onFileSharedCallback = null; // callback when a peer shares a file with us

// ─── Hosted Chunks Store (chunks this device stores for OTHER peers) ───
const HOSTED_CHUNKS = new Map();

// Provenance for each hosted chunk. The chunk id alone can't say who sent it,
// so the diagnostic table would have nothing real to show in an Origin column.
const HOSTED_META = new Map(); // chunkId -> { fromPeerId, receivedAt, bytes }

// ─── Pending Distribution (offline-first uploads) ───
// A file uploaded while no peer is connected is still encrypted and chunked,
// but its chunks park here in local IndexedDB until a real peer shows up.
const PENDING_CHUNKS = new Map(); // chunkId -> { index, createdAt, bytes }
let isFlushingPending = false;

// Handing a chunk to a peer and then keeping a local mirror would mean the node
// never reclaims anything, so the local copy is released after a successful
// handoff. The trade-off: `store-chunk` is fire-and-forget over the relay, so
// there is no delivery receipt to wait for. Set this to false to keep the
// mirror — retrieval still works either way, since a `peer:` manifest entry
// falls back to the local `chunks` store when the peer is unreachable.
const FREE_LOCAL_COPY_AFTER_HANDOFF = true;

let onHostedChunkAddedCallback = null;   // fires the instant a chunk arrives
let onPendingDistributedCallback = null; // fires after a delayed handoff

// v3 adds `hostedMeta` (who sent each hosted chunk) and `pending` (the
// offline-first queue). Existing `chunks` / `hosted` data is left untouched.
const DB_VERSION = 3;

// ─── IndexedDB helpers ───
function getDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('SwarmVaultDB', DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('chunks')) {
        db.createObjectStore('chunks');
      }
      if (!db.objectStoreNames.contains('hosted')) {
        db.createObjectStore('hosted');
      }
      if (!db.objectStoreNames.contains('hostedMeta')) {
        db.createObjectStore('hostedMeta');
      }
      if (!db.objectStoreNames.contains('pending')) {
        db.createObjectStore('pending');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Chunk ids are minted as `chunk-<epoch-ms>-<index>-<rand>`, so anything stored
// before `hostedMeta` existed still yields a usable arrival time.
function chunkIdTimestamp(chunkId) {
  const match = /^chunk-(\d{10,})-/.exec(String(chunkId));
  return match ? Number(match[1]) : null;
}

// Small promisified store write/delete, used by the pending queue.
function idbPut(db, storeName, value, key) {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch (e) {
      resolve(false);
    }
  });
}

function idbDelete(db, storeName, key) {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch (e) {
      resolve(false);
    }
  });
}

function idbGet(db, storeName, key) {
  return new Promise((resolve) => {
    try {
      const req = db.transaction(storeName).objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch (e) {
      resolve(null);
    }
  });
}

// ─── Connect to Signaling + Data Relay Server ───
function connectSignalingServer(peerId, onPeerDiscovered, onPeerLost, onFileReceived) {
  onFileSharedCallback = onFileReceived;
  const signalingUrl = isProduction()
    ? `wss://${RELAY_HOST}/signaling`
    : `ws://${devHost()}:10000/signaling`;
  
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

            // Offline-first handoff: anything uploaded while this node was
            // isolated goes out to the peer that just arrived. Not awaited —
            // a slow flush must not stall the rest of the message loop.
            flushPendingChunks(pid);
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
          const entry = {
            fromPeerId: fromPeerId || null,
            receivedAt: Date.now(),
            bytes: chunkData.byteLength,
          };
          HOSTED_CHUNKS.set(chunkId, chunkData);
          HOSTED_META.set(chunkId, entry);

          // Persist to IndexedDB. `hosted` keeps raw bytes so the find-chunk
          // path can hand them straight back; provenance rides alongside in
          // `hostedMeta` rather than wrapping the bytes in an object.
          try {
            const db = await getDB();
            await new Promise((resolve) => {
              const tx = db.transaction(['hosted', 'hostedMeta'], 'readwrite');
              tx.objectStore('hosted').put(chunkData, chunkId);
              tx.objectStore('hostedMeta').put(entry, chunkId);
              tx.oncomplete = resolve;
              tx.onerror = resolve;
              tx.onabort = resolve;
            });
          } catch (e) {}

          console.log(`📦 Hosting chunk ${chunkId.slice(-12)} from peer ${fromPeerId?.slice(-8)} (${chunkData.byteLength} bytes)`);

          // Push the arrival straight to the UI so the diagnostic table updates
          // the moment the chunk lands, instead of on the next poll.
          if (onHostedChunkAddedCallback) {
            try {
              onHostedChunkAddedCallback({ chunkId, ...entry });
            } catch (e) {
              console.warn('onHostedChunkAdded handler threw:', e.message);
            }
          }
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
// The two trailing callbacks are optional, so existing three-argument calls
// keep working unchanged.
export async function initP2PNode(
  onPeerDiscovered,
  onPeerLost,
  onFileReceived,
  onHostedChunkAdded,
  onPendingDistributed
) {
  onHostedChunkAddedCallback = onHostedChunkAdded || null;
  onPendingDistributedCallback = onPendingDistributed || null;

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
          isProduction()
            ? `/dns4/${RELAY_HOST}/tcp/443/wss/p2p/${RELAY_PEER_ID}`
            : devRelayMultiaddr()
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

    // No peers, or the send failed. The chunk stays local and joins the pending
    // queue, so it can be offloaded the moment a real peer appears.
    distributionManifest[i] = chunkId;

    const pendingEntry = { index: i, createdAt: Date.now(), bytes: chunk.byteLength };
    PENDING_CHUNKS.set(chunkId, pendingEntry);
    await idbPut(db, 'pending', pendingEntry, chunkId);
    console.log(`🕗 Chunk ${i} (${chunk.byteLength} bytes) queued for delayed distribution`);
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

// ─── Offline-first handoff ───
// Runs the moment a real peer joins. Every chunk parked locally because the node
// was isolated is pushed to that peer, then released locally so the node
// reclaims the space. Returns the moves so the caller can rewrite its manifests.
export async function flushPendingChunks(targetPeerId) {
  if (isFlushingPending) return [];
  if (!targetPeerId || targetPeerId === RELAY_PEER_ID) return [];
  if (!signalingWs || signalingWs.readyState !== WebSocket.OPEN) return [];
  if (PENDING_CHUNKS.size === 0) return [];

  isFlushingPending = true;
  const moved = [];

  try {
    const db = await getDB();
    // Snapshot first — the map is mutated as the loop drains it.
    const queued = Array.from(PENDING_CHUNKS.entries());
    console.log(`🚚 Offloading ${queued.length} pending chunk(s) to peer ${targetPeerId.slice(-8)}...`);

    for (const [chunkId, entry] of queued) {
      // The bytes have been sitting in the local `chunks` store since upload.
      const stored = await idbGet(db, 'chunks', chunkId);
      if (!stored) {
        // Nothing left to hand over — drop it rather than retrying forever.
        PENDING_CHUNKS.delete(chunkId);
        await idbDelete(db, 'pending', chunkId);
        console.warn(`⚠️ Pending chunk ${chunkId.slice(-12)} has no local bytes — dropped from the queue`);
        continue;
      }

      const bytes = new Uint8Array(stored);
      try {
        signalingWs.send(JSON.stringify({
          type: 'store-chunk',
          chunkId,
          data: uint8ArrayToBase64(bytes),
          targetPeerId,
        }));
      } catch (err) {
        // Leave it queued so the next peer to join can try again.
        console.warn(`⚠️ Handoff failed for ${chunkId.slice(-12)}, keeping it local:`, err.message);
        continue;
      }

      PENDING_CHUNKS.delete(chunkId);
      await idbDelete(db, 'pending', chunkId);

      if (FREE_LOCAL_COPY_AFTER_HANDOFF) {
        await idbDelete(db, 'chunks', chunkId);
      }

      moved.push({
        chunkId,
        index: entry && typeof entry.index === 'number' ? entry.index : null,
        peerId: targetPeerId,
        location: `peer:${targetPeerId}:${chunkId}`,
        bytes: bytes.byteLength,
      });
    }

    if (moved.length) {
      const freedBytes = moved.reduce((acc, m) => acc + m.bytes, 0);
      console.log(`🚀 Offloaded ${moved.length} chunk(s) (${freedBytes} bytes) to peer ${targetPeerId.slice(-8)}`);
      if (onPendingDistributedCallback) {
        try {
          onPendingDistributedCallback(moved, targetPeerId);
        } catch (e) {
          console.warn('onPendingDistributed handler threw:', e.message);
        }
      }
    }
  } catch (err) {
    console.warn('Pending-chunk flush failed:', err.message);
  } finally {
    isFlushingPending = false;
  }

  return moved;
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

// Per-chunk rows for the diagnostic table, newest arrival first.
export function getHostedChunkLedger() {
  const rows = [];
  for (const [chunkId, chunk] of HOSTED_CHUNKS.entries()) {
    const meta = HOSTED_META.get(chunkId) || {};
    rows.push({
      chunkId,
      bytes: meta.bytes ?? chunk.byteLength ?? chunk.length ?? 0,
      // Chunks stored before provenance existed fall back to their minted time.
      receivedAt: meta.receivedAt ?? chunkIdTimestamp(chunkId),
      fromPeerId: meta.fromPeerId ?? null,
    });
  }
  rows.sort((a, b) => (b.receivedAt || 0) - (a.receivedAt || 0));
  return rows;
}

// Chunks waiting on a peer to hand them to.
export function getPendingChunkStats() {
  let totalBytes = 0;
  for (const entry of PENDING_CHUNKS.values()) {
    totalBytes += (entry && entry.bytes) || 0;
  }
  return { count: PENDING_CHUNKS.size, totalBytes };
}

export function getPendingChunkIds() {
  return Array.from(PENDING_CHUNKS.keys());
}

// Per-chunk rows for the queue, so the diagnostic table can list a pending
// shard next to a hosted one with the same columns. Newest first.
export function getPendingChunkLedger() {
  const rows = [];
  for (const [chunkId, entry] of PENDING_CHUNKS.entries()) {
    rows.push({
      chunkId,
      bytes: (entry && entry.bytes) || 0,
      createdAt: (entry && entry.createdAt) || chunkIdTimestamp(chunkId),
      index: entry && typeof entry.index === 'number' ? entry.index : null,
    });
  }
  rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return rows;
}

// Measures the node's real IndexedDB footprint by walking both stores: our own
// chunks (including anything pending) plus everything held for other peers.
export async function getLocalStorageUsage() {
  const empty = {
    ownCount: 0, ownBytes: 0,
    hostedCount: 0, hostedBytes: 0,
    pendingCount: 0, pendingBytes: 0,
    totalBytes: 0,
  };

  const sumStore = (db, storeName) => new Promise((resolve) => {
    if (!db.objectStoreNames.contains(storeName)) return resolve({ count: 0, bytes: 0 });
    let count = 0;
    let bytes = 0;
    try {
      const req = db.transaction(storeName).objectStore(storeName).openCursor();
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          const value = cursor.value;
          bytes += (value && (value.byteLength ?? value.length)) || 0;
          count++;
          cursor.continue();
        } else {
          resolve({ count, bytes });
        }
      };
      req.onerror = () => resolve({ count, bytes });
    } catch (e) {
      resolve({ count, bytes });
    }
  });

  try {
    const db = await getDB();
    const [own, hosted] = await Promise.all([
      sumStore(db, 'chunks'),
      sumStore(db, 'hosted'),
    ]);
    const pending = getPendingChunkStats();
    return {
      ownCount: own.count,
      ownBytes: own.bytes,
      hostedCount: hosted.count,
      hostedBytes: hosted.bytes,
      pendingCount: pending.count,
      pendingBytes: pending.totalBytes,
      totalBytes: own.bytes + hosted.bytes,
    };
  } catch (e) {
    console.warn('Could not measure local storage usage:', e.message);
    return empty;
  }
}

// Load persisted hosted chunks (and their provenance) from IndexedDB on startup
export async function loadHostedChunksFromDB() {
  try {
    const db = await getDB();

    // Provenance first, so every chunk loaded below can find its origin.
    if (db.objectStoreNames.contains('hostedMeta')) {
      await new Promise((resolve) => {
        try {
          const cursorReq = db.transaction('hostedMeta').objectStore('hostedMeta').openCursor();
          cursorReq.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) {
              HOSTED_META.set(cursor.key, cursor.value);
              cursor.continue();
            } else {
              resolve();
            }
          };
          cursorReq.onerror = () => resolve();
        } catch (e) {
          resolve();
        }
      });
    }

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

// Restore the pending-distribution queue so a file uploaded offline in an
// earlier session is still handed off when a peer finally connects.
export async function loadPendingChunksFromDB() {
  try {
    const db = await getDB();
    if (!db.objectStoreNames.contains('pending')) return 0;

    return new Promise((resolve) => {
      let loaded = 0;
      try {
        const cursorReq = db.transaction('pending').objectStore('pending').openCursor();
        cursorReq.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            PENDING_CHUNKS.set(cursor.key, cursor.value);
            loaded++;
            cursor.continue();
          } else {
            if (loaded) console.log(`🕗 ${loaded} chunk(s) still awaiting distribution`);
            resolve(loaded);
          }
        };
        cursorReq.onerror = () => resolve(loaded);
      } catch (e) {
        resolve(loaded);
      }
    });
  } catch (e) {
    console.warn('Could not load the pending queue from IndexedDB:', e);
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