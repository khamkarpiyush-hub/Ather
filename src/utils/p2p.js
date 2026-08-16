import { createLibp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { webRTC } from '@libp2p/webrtc';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery';
import { identify } from '@libp2p/identify';
// import { circuitRelayTransport } from 'libp2p/circuit-relay';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { pipe } from 'it-pipe';

import { multiaddr } from '@multiformats/multiaddr';
import { bootstrap } from '@libp2p/bootstrap';

let libp2pNode;
let activePeers = new Map();
const LOCAL_CHUNK_STORE = new Map(); // Local silent storage bucket

export async function initP2PNode(onPeerDiscovered, onPeerLost) {
  libp2pNode = await createLibp2p({
    addresses: {
    //   listen: ['/ip4/127.0.0.1/tcp/0/ws']
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
      pubsub: gossipsub(),
      identify: identify()
    },
    peerDiscovery: [
      pubsubPeerDiscovery({
        topics: ['swarmvault-discovery']
      })
    ]
  });

  // Register the silent storage receiver protocol listener on startup
  registerSilentStorageReceiver(libp2pNode);

  libp2pNode.addEventListener('peer:discovery', (evt) => {
    const peerId = evt.detail.id;
    if (onPeerDiscovered) onPeerDiscovered(peerId);
    activePeers.set(peerId.toString(), peerId);
  });

  libp2pNode.addEventListener('peer:disconnect', (evt) => {
    const peerId = evt.detail.id;
    if (onPeerLost) onPeerLost(peerId);
    activePeers.delete(peerId.toString());
  });


  await libp2pNode.start();
  console.log('P2P Node started with ID:', libp2pNode.peerId.toString());

  // Connect to your live Render cloud relay server
  try {
    await libp2pNode.dial(multiaddr('/dns/swarmvault-relay.onrender.com/tcp/443/wss'));
    console.log('Connected to SwarmVault Cloud Relay!');
  } catch (e) {
    console.log('Cloud relay unreachable, running standalone/discovery mode.', e);
  }

  return libp2pNode;
//   await libp2pNode.start();
//   console.log('P2P Node started with ID:', libp2pNode.peerId.toString());

//   // Try connecting to the local relay server if running
//   try {
//     await libp2pNode.dial('/ip4/127.0.0.1/tcp/9090/ws');
//   } catch (e) {
//     console.log('Relay server not active yet, running standalone/discovery mode.');
//   }

//   return libp2pNode;
}

export function registerSilentStorageReceiver(node) {
  node.handle('/swarmvault/chunk/1.0.0', async ({ stream }) => {
    try {
      await pipe(
        stream.source,
        async function (source) {
          for await (const chunk of source) {
            // Save received shard into local silent storage
            const chunkKey = Math.random().toString();
            LOCAL_CHUNK_STORE.set(chunkKey, chunk.subarray());
          }
        }
      );
    } catch (err) {
      console.error('Error receiving chunk:', err);
    }
  });
}

// --- NEW DATABASE HELPER ---
function getDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('SwarmVaultDB', 1);
    request.onupgradeneeded = (e) => e.target.result.createObjectStore('chunks');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function distributeChunks(node, chunks, peersMap) {
  const distributionManifest = {};
  const peerIds = Array.from(peersMap.values());
  const db = await getDB();

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    
    // If no real peers, store in local IndexedDB
    if (peerIds.length === 0 || peerIds[0] === 'local-network-mock') {
      const fallbackKey = `simulated-peer-chunk-${Date.now()}-${i}`;
      await new Promise((resolve) => {
        const tx = db.transaction('chunks', 'readwrite');
        tx.objectStore('chunks').put(chunk, fallbackKey);
        tx.oncomplete = resolve;
      });
      distributionManifest[i] = fallbackKey;
      continue;
    }

    const targetPeer = peerIds[i % peerIds.length];
    try {
      const connection = await node.dial(targetPeer);
      const stream = await connection.newStream('/swarmvault/chunk/1.0.0');
      await pipe([chunk], stream.sink);
      distributionManifest[i] = targetPeer.toString();
    } catch (err) {
      // Fallback to local DB if network fails
      const fallbackKey = `local-fallback-${Date.now()}-${i}`;
      const tx = db.transaction('chunks', 'readwrite');
      tx.objectStore('chunks').put(chunk, fallbackKey);
      distributionManifest[i] = fallbackKey;
    }
  }
  return distributionManifest;
}

export async function fetchChunks(node, manifest) {
  const retrievedChunks = [];
  const db = await getDB();

  for (const [chunkIndex, peerIdStr] of Object.entries(manifest)) {
    // Check local permanent database first
    const localChunk = await new Promise(resolve => {
       const req = db.transaction('chunks').objectStore('chunks').get(peerIdStr);
       req.onsuccess = () => resolve(req.result);
       req.onerror = () => resolve(null);
    });

    if (localChunk) {
      retrievedChunks.push(localChunk);
      continue;
    }

    // Otherwise fetch from swarm
    try {
      const peerId = activePeers.get(peerIdStr);
      if (!peerId) throw new Error(`Peer not connected`);
      const connection = await node.dial(peerId);
      const stream = await connection.newStream('/swarmvault/chunk/1.0.0');
      retrievedChunks.push(new Uint8Array()); 
    } catch (err) {
      console.error(`Failed to fetch chunk from ${peerIdStr}:`, err);
    }
  }
  return retrievedChunks;
}




// moving to permanent data base from ram to indexdb
// export async function distributeChunks(node, chunks, peersMap) {
//   const distributionManifest = {};
//   const peerIds = Array.from(peersMap.values());

//   for (let i = 0; i < chunks.length; i++) {
//     const chunk = chunks[i];
    
//     // Simulated swarm fallback for single-node testing
//     if (peerIds.length === 0 || peerIds[0] === 'local-network-mock') {
//       const fallbackKey = `simulated-peer-chunk-${i}`;
//       LOCAL_CHUNK_STORE.set(fallbackKey, chunk);
//       distributionManifest[i] = fallbackKey;
//       continue;
//     }

//     const targetPeer = peerIds[i % peerIds.length];
//     try {
//       const connection = await node.dial(targetPeer);
//       const stream = await connection.newStream('/swarmvault/chunk/1.0.0');
      
//       await pipe([chunk], stream.sink);
//       distributionManifest[i] = targetPeer.toString();
//     } catch (err) {
//       // If network fails, save locally so we don't lose the shard
//       const fallbackKey = `local-fallback-${i}`;
//       LOCAL_CHUNK_STORE.set(fallbackKey, chunk);
//       distributionManifest[i] = fallbackKey;
//     }
//   }

//   return distributionManifest;
// }

// export async function fetchChunks(node, manifest) {
//   const retrievedChunks = [];

//   for (const [chunkIndex, peerIdStr] of Object.entries(manifest)) {
//     // Check our local simulated network store first
//     if (LOCAL_CHUNK_STORE.has(peerIdStr)) {
//       retrievedChunks.push(LOCAL_CHUNK_STORE.get(peerIdStr));
//       continue;
//     }

//     try {
//       const peerId = activePeers.get(peerIdStr);
//       if (!peerId) throw new Error(`Peer not connected`);

//       const connection = await node.dial(peerId);
//       const stream = await connection.newStream('/swarmvault/chunk/1.0.0');

//       // Network stream logic placeholder for multi-node retrieval
//       retrievedChunks.push(new Uint8Array()); 
//     } catch (err) {
//       console.error(`Failed to fetch chunk from ${peerIdStr}:`, err);
//     }
//   }

//   return retrievedChunks;
// }



// if no peers are available the 16 bit code give a error above it is solved 
// export async function distributeChunks(node, chunks, peersMap) {
//   const distributionManifest = {};
//   const peerIds = Array.from(peersMap.values());

//   if (peerIds.length === 0) {
//     throw new Error('No active peers available in the swarm to distribute chunks!');
//   }

//   for (let i = 0; i < chunks.length; i++) {
//     const chunk = chunks[i];
//     const targetPeer = peerIds[i % peerIds.length];

//     try {
//       const connection = await node.dial(targetPeer);
//       const stream = await connection.newStream('/swarmvault/chunk/1.0.0');

//       await pipe(
//         [chunk],
//         stream.sink
//       );

//       distributionManifest[i] = targetPeer.toString();
//     } catch (err) {
//       console.error(`Failed to send chunk to peer ${targetPeer.toString()}:`, err);
//     }
//   }

//   return distributionManifest;
// }

// export async function fetchChunks(node, manifest) {
//   const retrievedChunks = [];

//   for (const [chunkIndex, peerIdStr] of Object.entries(manifest)) {
//     // If stored locally in our own node store
//     if (LOCAL_CHUNK_STORE.has(chunkIndex)) {
//       retrievedChunks.push(LOCAL_CHUNK_STORE.get(chunkIndex));
//       continue;
//     }

//     try {
//       const peerId = activePeers.get(peerIdStr);
//       if (!peerId) throw new Error(`Peer ${peerIdStr} not connected`);

//       const connection = await node.dial(peerId);
//       const stream = await connection.newStream('/swarmvault/chunk/1.0.0');

//       // Request stream logic placeholder for retrieval
//       retrievedChunks.push(new Uint8Array()); 
//     } catch (err) {
//       console.error(`Failed to fetch chunk from ${peerIdStr}:`, err);
//     }
//   }

//   return retrievedChunks;
// }


//  didnt worked well 
// import { identify } from '@libp2p/identify';
// import { createLibp2p } from 'libp2p';
// import { webSockets } from '@libp2p/websockets';
// import { webRTC } from '@libp2p/webrtc';
// import { noise } from '@chainsafe/libp2p-noise';
// import { yamux } from '@chainsafe/libp2p-yamux';
// import { gossipsub } from '@chainsafe/libp2p-gossipsub';
// import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery';
// import { pipe } from 'it-pipe';

// let libp2pNode;
// let activePeers = new Map();
// const LOCAL_CHUNK_STORE = new Map();

// export async function initP2PNode(onPeerDiscovered, onPeerLost) {
//   libp2pNode = await createLibp2p({
//     addresses: {
//       listen: ['/ip4/127.0.0.1/tcp/0/ws']
//     },
//     transports: [
//       webSockets(),
//       webRTC()
//     ],
//     connectionEncrypters: [noise()],
//     streamMuxers: [yamux()],
//     services: {
//       pubsub: gossipsub(),
//       identify: identify()
//     },
//     peerDiscovery: [
//       pubsubPeerDiscovery({
//         topics: ['swarmvault-discovery']
//       })
//     ]
//   });

//   registerSilentStorageReceiver(libp2pNode);

//   libp2pNode.addEventListener('peer:discovery', (evt) => {
//     const peerId = evt.detail.id;
//     if (onPeerDiscovered) onPeerDiscovered(peerId);
//     activePeers.set(peerId.toString(), peerId);
//   });

//   libp2pNode.addEventListener('peer:disconnect', (evt) => {
//     const peerId = evt.detail.id;
//     if (onPeerLost) onPeerLost(peerId);
//     activePeers.delete(peerId.toString());
//   });

//   await libp2pNode.start();
//   console.log('P2P Node started with ID:', libp2pNode.peerId.toString());

//   try {
//     await libp2pNode.dial('/ip4/127.0.0.1/tcp/9090/ws');
//   } catch (e) {
//     console.log('Relay server not active yet, running standalone/discovery mode.');
//   }

//   return libp2pNode;
// }

// export function registerSilentStorageReceiver(node) {
//   node.handle('/swarmvault/chunk/1.0.0', async ({ stream }) => {
//     try {
//       await pipe(
//         stream.source,
//         async function (source) {
//           for await (const chunk of source) {
//             const chunkKey = Math.random().toString();
//             LOCAL_CHUNK_STORE.set(chunkKey, chunk.subarray());
//           }
//         }
//       );
//     } catch (err) {
//       console.error('Error receiving chunk:', err);
//     }
//   });
// }

// export async function distributeChunks(node, chunks, peersMap) {
//   const distributionManifest = {};
//   const peerIds = Array.from(peersMap.values());

//   if (peerIds.length === 0) {
//     throw new Error('No active peers available in the swarm to distribute chunks!');
//   }

//   for (let i = 0; i < chunks.length; i++) {
//     const chunk = chunks[i];
//     const targetPeer = peerIds[i % peerIds.length];

//     try {
//       const connection = await node.dial(targetPeer);
//       const stream = await connection.newStream('/swarmvault/chunk/1.0.0');

//       await pipe(
//         [chunk],
//         stream.sink
//       );

//       distributionManifest[i] = targetPeer.toString();
//     } catch (err) {
//       console.error(`Failed to send chunk to peer ${targetPeer.toString()}:`, err);
//     }
//   }

//   return distributionManifest;
// }

// export async function fetchChunks(node, manifest) {
//   const retrievedChunks = [];

//   for (const [chunkIndex, peerIdStr] of Object.entries(manifest)) {
//     if (LOCAL_CHUNK_STORE.has(chunkIndex)) {
//       retrievedChunks.push(LOCAL_CHUNK_STORE.get(chunkIndex));
//       continue;
//     }

//     try {
//       const peerId = activePeers.get(peerIdStr);
//       if (!peerId) throw new Error(`Peer ${peerIdStr} not connected`);

//       const connection = await node.dial(peerId);
//       const stream = await connection.newStream('/swarmvault/chunk/1.0.0');

//       retrievedChunks.push(new Uint8Array()); 
//     } catch (err) {
//       console.error(`Failed to fetch chunk from ${peerIdStr}:`, err);
//     }
//   }

//   return retrievedChunks;
// }