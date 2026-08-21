import { createLibp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { multiaddr } from '@multiformats/multiaddr';

const RELAY_PEER_ID = '12D3KooWAQhWksCm5kE41QFg1D4yEyWQEY7Ed4BFrGA5pDt955xJ';

async function main() {
  const node = await createLibp2p({
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()]
  });
  await node.start();
  console.log('Node started');
  try {
    await node.dial(multiaddr(`/ip4/127.0.0.1/tcp/10000/ws/p2p/${RELAY_PEER_ID}`));
    console.log('Dial successful!');
  } catch(e) {
    console.log('Dial failed:', e);
  }
  await node.stop();
}
main();
