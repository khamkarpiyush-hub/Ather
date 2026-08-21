const fs = require('fs');

let p2p = fs.readFileSync('src/utils/p2p.js', 'utf8');

// We will inject a manual heartbeat loop and listener after the node starts
const injection = `
  await libp2pNode.start();
  
  // ROBUST MANUAL DISCOVERY OVER PUBSUB
  try {
    libp2pNode.services.pubsub.subscribe('swarmvault-discovery');
    
    libp2pNode.services.pubsub.addEventListener('message', (message) => {
      if (message.detail.topic === 'swarmvault-discovery') {
        const peerIdStr = new TextDecoder().decode(message.detail.data);
        if (peerIdStr !== libp2pNode.peerId.toString() && peerIdStr !== RELAY_PEER_ID && peerIdStr !== '12D3KooWHjuu24DxzDzHbR7B2Jv92gsvW5azvC8p5J3tBydQhdvh') {
          if (!activePeers.has(peerIdStr)) {
            console.log('📡 Manual pubsub heartbeat discovered peer:', peerIdStr);
            // Reconstruct peer id object (cheat: just dial the string)
            libp2pNode.dial('/p2p/' + peerIdStr).then(() => {
              console.log('✅ Successfully dialed manually discovered peer');
            }).catch(e => {
              // It might fail if we don't have their relay address in peerstore, but gossipsub should propagate it
            });
          }
        }
      }
    });

    setInterval(async () => {
      try {
        await libp2pNode.services.pubsub.publish(
          'swarmvault-discovery',
          new TextEncoder().encode(libp2pNode.peerId.toString())
        );
      } catch (e) {}
    }, 5000);
  } catch (err) {
    console.error('Failed to setup manual discovery:', err);
  }
`;

p2p = p2p.replace('await libp2pNode.start();', injection);

fs.writeFileSync('src/utils/p2p.js', p2p);
