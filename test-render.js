import { createLibp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { multiaddr } from '@multiformats/multiaddr';

async function main() {
  const node = await createLibp2p({
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() }
  });
  await node.start();
  try {
    await node.dial(multiaddr('/dns/swarmvault-relay.onrender.com/tcp/443/wss'));
    console.log("Connected to Render relay without specifying ID!");
    const connections = node.getConnections();
    console.log("Render Relay Actual ID:", connections[0].remotePeer.toString());
  } catch(e) {
    console.log("Failed to connect:", e.message);
  }
  await node.stop();
  process.exit(0);
}
main();
