import { createLibp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { identify } from '@libp2p/identify';

async function main() {
  const port = process.env.PORT || 10000;
  
  const server = await createLibp2p({
    addresses: {
      listen: [`/ip4/0.0.0.0/tcp/${port}/ws`]
    },
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMultiplexers: [yamux()],
    services: {
      relay: circuitRelayServer(),
      pubsub: gossipsub(),
      identify: identify()
    }
  });

  console.log(`🚀 SwarmVault Public Relay running successfully with PubSub!`);
  console.log(`Peer ID: ${server.peerId.toString()}`);
  server.getMultiaddrs().forEach((ma) => console.log(`Listening on: ${ma.toString()}`));
}

main().catch((err) => {
  console.error('Failed to start relay server:', err);
  process.exit(1);
});

//   works 
// import { createLibp2p } from 'libp2p';
// import { webSockets } from '@libp2p/websockets';
// import { webRTC } from '@libp2p/webrtc';
// import { noise } from '@chainsafe/libp2p-noise';
// import { yamux } from '@chainsafe/libp2p-yamux';
// import { gossipsub } from '@chainsafe/libp2p-gossipsub';
// import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery';
// import { identify } from '@libp2p/identify';
// // import { circuitRelayTransport, circuitRelayServer } from 'libp2p/circuit-relay';
// import { circuitRelayTransport, circuitRelayServer } from '@libp2p/circuit-relay-v2';

// async function createRelayServer() {
//   const relay = await createLibp2p({
//     addresses: {
//       listen: ['/ip4/127.0.0.1/tcp/9090/ws']
//     },
//     transports: [
//       webSockets(),
//       webRTC(),
//       circuitRelayTransport()
//     ],
//     connectionEncrypters: [noise()],
//     streamMuxers: [yamux()],
//     services: {
//       pubsub: gossipsub(),
//       identify: identify(),
//       relay: circuitRelayServer()
//     },
//     peerDiscovery: [
//       pubsubPeerDiscovery({
//         topics: ['swarmvault-discovery']
//       })
//     ]
//   });

//   console.log('Relay server multiaddress:', relay.getMultiaddrs().map(ma => ma.toString()));
//   return relay;
// }

// createRelayServer().catch(err => console.error(err));


// import { identify } from '@libp2p/identify';
// import { createLibp2p } from 'libp2p';
// import { webSockets } from '@libp2p/websockets';
// import { webRTC } from '@libp2p/webrtc';
// import { noise } from '@chainsafe/libp2p-noise';
// import { yamux } from '@chainsafe/libp2p-yamux';
// import { gossipsub } from '@chainsafe/libp2p-gossipsub';
// import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery';

// async function createRelayServer() {
//   const relay = await createLibp2p({
//     addresses: {
//       listen: ['/ip4/127.0.0.1/tcp/9090/ws']
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

//   console.log('Relay server multiaddress:', relay.getMultiaddrs().map(ma => ma.toString()));
//   return relay;
// }

// createRelayServer().catch(err => console.error(err));