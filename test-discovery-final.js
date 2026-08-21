import { createLibp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { identify } from '@libp2p/identify';
import { circuitRelayTransport, circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { bootstrap } from '@libp2p/bootstrap';
import { multiaddr } from '@multiformats/multiaddr';

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
  return node;
}

async function main() {
  const relay = await createNode('Relay', ['/ip4/127.0.0.1/tcp/10006/ws']);
  const RELAY_PEER_ID = relay.peerId.toString();
  const relayAddr = `/ip4/127.0.0.1/tcp/10006/ws/p2p/${RELAY_PEER_ID}`;
  
  async function createClient(name) {
    const node = await createLibp2p({
      transports: [webSockets(), circuitRelayTransport()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { pubsub: gossipsub({ allowPublishToZeroTopicPeers: true }), identify: identify() },
      peerDiscovery: [bootstrap({ list: [relayAddr] })]
    });
    await node.start();
    
    node.services.pubsub.subscribe('swarmvault-discovery');
    
    node.services.pubsub.addEventListener('message', (message) => {
      if (message.detail.topic === 'swarmvault-discovery') {
        const peerIdStr = new TextDecoder().decode(message.detail.data);
        if (peerIdStr !== node.peerId.toString() && peerIdStr !== RELAY_PEER_ID) {
          console.log(`[${name}] Manual pubsub heartbeat discovered peer:`, peerIdStr);
          const circuitAddr = `/ip4/127.0.0.1/tcp/10006/ws/p2p/${RELAY_PEER_ID}/p2p-circuit/p2p/${peerIdStr}`;
          node.dial(multiaddr(circuitAddr)).then(() => {
             console.log(`[${name}] ✅ Successfully dialed manually discovered peer over circuit relay`);
          }).catch(e => {
             // console.log(`[${name}] Failed to dial manual peer:`, e.message);
          });
        }
      }
    });

    setInterval(async () => {
      try {
        await node.services.pubsub.publish(
          'swarmvault-discovery',
          new TextEncoder().encode(node.peerId.toString())
        );
      } catch (e) {}
    }, 1000);
    
    return node;
  }
  
  const node1 = await createClient('Node1');
  const node2 = await createClient('Node2');
  
  console.log("Waiting 10s for mesh/discovery...");
  await new Promise(r => setTimeout(r, 10000));
  await relay.stop(); await node1.stop(); await node2.stop();
  process.exit(0);
}
main();
