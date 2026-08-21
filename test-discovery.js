import { createLibp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { identify } from '@libp2p/identify';
import { circuitRelayTransport, circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { bootstrap } from '@libp2p/bootstrap';

async function createNode(name, listenAddresses) {
  const node = await createLibp2p({
    addresses: { listen: listenAddresses },
    transports: [webSockets(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      pubsub: gossipsub({ allowPublishToZeroTopicPeers: true }),
      identify: identify(),
      relay: circuitRelayServer()
    }
  });
  await node.start();
  node.services.pubsub.subscribe('swarmvault-discovery');
  node.services.pubsub.addEventListener('message', (message) => {
    if (message.detail.topic === 'swarmvault-discovery') {
      console.log(`[${name}] Received pubsub from:`, new TextDecoder().decode(message.detail.data));
    }
  });
  return node;
}

async function main() {
  const relay = await createNode('Relay', ['/ip4/127.0.0.1/tcp/10005/ws']);
  const relayAddr = `/ip4/127.0.0.1/tcp/10005/ws/p2p/${relay.peerId.toString()}`;
  
  const node1 = await createLibp2p({
    transports: [webSockets(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { pubsub: gossipsub({ allowPublishToZeroTopicPeers: true }), identify: identify() },
    peerDiscovery: [bootstrap({ list: [relayAddr] })]
  });
  await node1.start();
  node1.services.pubsub.subscribe('swarmvault-discovery');
  
  const node2 = await createLibp2p({
    transports: [webSockets(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { pubsub: gossipsub({ allowPublishToZeroTopicPeers: true }), identify: identify() },
    peerDiscovery: [bootstrap({ list: [relayAddr] })]
  });
  await node2.start();
  node2.services.pubsub.subscribe('swarmvault-discovery');
  node2.services.pubsub.addEventListener('message', (message) => {
    if (message.detail.topic === 'swarmvault-discovery') {
      console.log(`[Node2] Received pubsub from:`, new TextDecoder().decode(message.detail.data));
    }
  });

  await new Promise(r => setTimeout(r, 1000));
  
  console.log("Node1 publishing...");
  await node1.services.pubsub.publish('swarmvault-discovery', new TextEncoder().encode("Hello from Node1"));

  await new Promise(r => setTimeout(r, 2000));
  await relay.stop(); await node1.stop(); await node2.stop();
  process.exit(0);
}
main();
