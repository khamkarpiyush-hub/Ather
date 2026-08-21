<p align="center">
  <img src="https://img.shields.io/badge/SwarmVault-v1.0.0-10b981?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IndoaXRlIiBzdHJva2Utd2lkdGg9IjIiPjxwYXRoIGQ9Ik0xMiAyMnM4LTQgOC0xMFY1bC04LTMtOCAzdjdjMCA2IDggMTAgOCAxMHoiLz48L3N2Zz4=" alt="SwarmVault Badge" />
  <img src="https://img.shields.io/badge/React-18.2-61dafb?style=for-the-badge&logo=react" alt="React" />
  <img src="https://img.shields.io/badge/Vite-5.x-646cff?style=for-the-badge&logo=vite" alt="Vite" />
  <img src="https://img.shields.io/badge/libp2p-P2P-ff6347?style=for-the-badge" alt="libp2p" />
  <img src="https://img.shields.io/badge/Firebase-Auth%20%2B%20Firestore-ffca28?style=for-the-badge&logo=firebase" alt="Firebase" />
</p>

# 🛡️ SwarmVault — Decentralized Encrypted File Storage

**SwarmVault** is a peer-to-peer (P2P), zero-knowledge, decentralized file storage application. Files are encrypted client-side with **AES-256-GCM**, split into shards, and distributed across connected peers in a swarm network. No server ever sees your plaintext data. Your files, your keys, your peers.

---

## ✨ Key Features

| Feature | Description |
|---|---|
| 🔐 **AES-256-GCM Encryption** | All files are encrypted in-browser before leaving your device |
| 🧩 **Automatic File Sharding** | Encrypted files are split into 1 MB chunks and distributed across peers |
| 🌐 **Peer-to-Peer Distribution** | Chunks are sent to real connected peers via a WebSocket signaling relay |
| 🔥 **Firebase Authentication** | Google Sign-In for user identity and cloud vault sync |
| ☁️ **Firestore Cloud Sync** | File metadata (keys, manifests, thumbnails) synced to Firestore per user |
| 👁️ **In-App File Preview** | Decrypt and preview images, audio, video, and PDFs without downloading |
| 📥 **One-Click Download** | Retrieve, reassemble, decrypt, and download files instantly |
| 📦 **Proof-of-Hosting** | See how many encrypted chunks your node is hosting for other peers |
| 📂 **Network Shared Files** | Browse and retrieve files that other peers have shared with the swarm |
| 🌗 **Dark / Light Mode** | Theme toggle with persistent localStorage preference |
| 🧠 **IndexedDB Persistence** | Local chunks and hosted chunks survive browser refreshes |

---

## 🏗️ Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                        SwarmVault Architecture                       │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   ┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐  │
│   │  Browser A   │────▶│  Relay Server    │◀────│  Browser B      │  │
│   │  (React App) │     │  (relay.js)      │     │  (React App)    │  │
│   └──────┬───────┘     │                  │     └────────┬────────┘  │
│          │             │  ┌────────────┐  │              │           │
│          │             │  │ libp2p     │  │              │           │
│          │             │  │ Relay Node │  │              │           │
│          │             │  │ (port 10000)│ │              │           │
│          │             │  └────────────┘  │              │           │
│          │             │  ┌────────────┐  │              │           │
│          │             │  │ WebSocket  │  │              │           │
│          │             │  │ Signaling  │  │              │           │
│          │             │  │ + Data     │  │              │           │
│          │             │  │ (port 10001)│ │              │           │
│          │             │  └────────────┘  │              │           │
│          │             └──────────────────┘              │           │
│          │                                               │           │
│   ┌──────▼───────┐                              ┌───────▼────────┐  │
│   │  IndexedDB   │                              │   IndexedDB    │  │
│   │  (chunks +   │                              │   (chunks +    │  │
│   │   hosted)    │                              │    hosted)     │  │
│   └──────────────┘                              └────────────────┘  │
│                                                                      │
│   ┌──────────────────────────────────────────────────────────────┐   │
│   │                    Firebase Cloud Layer                       │   │
│   │  ┌──────────────┐        ┌──────────────────────────────┐   │   │
│   │  │  Google Auth  │        │  Firestore (vault metadata)  │   │   │
│   │  └──────────────┘        └──────────────────────────────┘   │   │
│   └──────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Upload** → User drops a file → Encrypted with AES-256-GCM in-browser → Sharded into 1 MB chunks
2. **Distribute** → Chunks sent to connected peers via WebSocket relay → Also cached locally in IndexedDB
3. **Metadata Sync** → File manifest (chunk locations), encryption key, IV, and thumbnail saved to Firestore
4. **Retrieve** → Manifest is read → Chunks fetched from peers (or local fallback) → Reassembled → Decrypted → Downloaded/Previewed

---

## 🛠️ Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| **Frontend** | React 18 + JSX | UI components and state management |
| **Build Tool** | Vite 5 | Fast dev server and production bundler |
| **Styling** | Tailwind CSS 3 | Utility-first CSS framework |
| **Icons** | Lucide React | SVG icon library |
| **P2P Networking** | libp2p (WebSockets, WebRTC, Circuit Relay, GossipSub) | Peer discovery and connection |
| **Signaling Server** | Custom WebSocket relay (`relay.js`) | Peer discovery, chunk routing, and data relay |
| **Encryption** | Web Crypto API (AES-256-GCM) | Client-side zero-knowledge encryption |
| **Authentication** | Firebase Auth (Google Sign-In) | User identity |
| **Database** | Cloud Firestore | Vault metadata persistence |
| **Local Storage** | IndexedDB | Encrypted chunk and hosted chunk persistence |
| **Process Manager** | concurrently | Runs Vite dev server + relay server simultaneously |

---

## 📁 Project Structure

```
Ather/
├── index.html              # HTML entry point
├── package.json            # Dependencies and scripts
├── vite.config.js          # Vite configuration
├── tailwind.config.js      # Tailwind CSS configuration
├── postcss.config.js       # PostCSS configuration
├── relay.js                # libp2p relay + WebSocket signaling server
├── relay-key.json          # Auto-generated persistent relay node key
├── start.sh                # Clean-start helper script (kills ports, runs dev)
├── patch.js                # Utility patches
├── .gitignore              # Git ignore rules
│
├── src/
│   ├── main.jsx            # React entry point
│   ├── App.jsx             # Main application component (all UI + logic)
│   ├── style.css           # Global Tailwind CSS imports
│   ├── firebase.js         # Firebase config (Auth + Firestore init)
│   ├── assets/             # Static assets
│   └── utils/
│       ├── crypto.js       # AES-256-GCM encrypt/decrypt + file sharding
│       └── p2p.js          # libp2p node, signaling, chunk distribution/retrieval
│
├── public/                 # Static public files (favicon, etc.)
├── dist/                   # Production build output (auto-generated)
└── node_modules/           # Installed dependencies (auto-generated)
```

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** ≥ 18.x (recommended: latest LTS)
- **npm** ≥ 9.x (comes with Node.js)
- A modern browser (Chrome, Firefox, Edge — must support Web Crypto API)

### Option 1: Clone from GitHub

```bash
# 1. Clone the repository
git clone https://github.com/khamkarpiyush-hub/Ather.git

# 2. Navigate into the project
cd Ather

# 3. Install dependencies
npm install

# 4. Start the development server
npm run dev
```

### Option 2: Download as ZIP

1. Go to [https://github.com/khamkarpiyush-hub/Ather](https://github.com/khamkarpiyush-hub/Ather)
2. Click the green **"Code"** button → **"Download ZIP"**
3. Extract the ZIP file to a folder of your choice
4. Open a terminal and navigate to the extracted folder:

```bash
cd /path/to/extracted/Ather
```

5. Install all dependencies:

```bash
npm install
```

6. Start the application:

```bash
npm run dev
```

### What `npm run dev` Does

The `dev` script runs **two processes concurrently**:

| Process | Command | Port | Purpose |
|---|---|---|---|
| Vite Dev Server | `vite --host` | `5173` | Serves the React frontend |
| Relay Server | `node relay.js` | `10000` (libp2p) + `10001` (WebSocket) | P2P relay and signaling |

Once running, open **http://localhost:5173** in your browser.

---

## 🧹 Clean Start (Optional)

If you have leftover processes from a previous run, use the included `start.sh` script:

```bash
chmod +x start.sh
./start.sh
```

This will:
1. Kill any running Node processes
2. Free up ports `5173`, `10000`, and `10001`
3. Start the app with `npm run dev`

---

## 📖 How to Use

### 1. Sign In
- Click **"Continue with Google"** on the login screen
- Your vault data is tied to your Google account via Firebase

### 2. Upload a File
- **Drag and drop** a file onto the upload zone, or click to browse
- The file is instantly:
  1. Encrypted with AES-256-GCM
  2. Sharded into 1 MB chunks
  3. Distributed to connected peers (or stored locally if no peers)
  4. Metadata saved to your Firestore vault

### 3. Preview a File
- Hover over a vault file card → click **"Preview"**
- Chunks are fetched from peers, reassembled, decrypted, and displayed in a modal
- Supports images, audio, video, and PDFs

### 4. Download a File
- Hover over a vault file card → click **"Download"**
- The decrypted file downloads to your machine as `unlocked_<filename>`

### 5. View Peer Encryption (Shard View)
- Hover over a file → click **"Peer View"**
- See the raw encrypted gibberish that a hosting peer sees — proving zero-knowledge storage

### 6. Browse Network Files
- Files shared by other peers appear in the **"Network Shared Files"** section
- Click **"Retrieve & Decrypt"** to download them to your device

### 7. Monitor Stats
The dashboard shows real-time statistics:
- **Files Secured** — number of files in your vault
- **Active Peers** — currently connected swarm peers
- **Chunks Hosted** — encrypted chunks you're storing for other peers
- **Storage Freed** — estimated storage distributed to the swarm

---

## 🔒 Security Model

| Aspect | Implementation |
|---|---|
| **Encryption Algorithm** | AES-256-GCM (authenticated encryption) |
| **Key Generation** | `window.crypto.subtle.generateKey()` — browser-native, cryptographically secure |
| **IV (Initialization Vector)** | 12-byte random, unique per file |
| **Zero Knowledge** | Encryption/decryption happens entirely in the browser; the relay server never sees plaintext |
| **Key Storage** | Exported JWK keys are stored in Firestore, accessible only to the authenticated user |
| **Chunk Opacity** | Peers hosting your chunks see only AES-encrypted binary data — mathematically useless without your key |

---

## 🌐 Multi-Peer Testing (LAN)

To test P2P chunk distribution between two browsers on the same network:

1. Start the app on **Machine A**: `npm run dev`
2. On **Machine B**, open: `http://<Machine-A-IP>:5173`
   - The IP is printed in the terminal when Vite starts (e.g., `http://192.168.0.107:5173`)
3. Sign in with **different** Google accounts on each browser
4. Upload a file on Machine A — chunks will be distributed to Machine B
5. Both peers will see each other in the **Active Peers** count

---

## 🏭 Building for Production

```bash
# Build the optimized production bundle
npm run build

# Preview the production build locally
npm run serve
```

The production output is generated in the `dist/` directory.

> **Note:** For production deployment, you will also need to deploy `relay.js` separately (e.g., on [Render](https://render.com)) and update the relay multiaddr in `src/utils/p2p.js`.

---

## 🔧 Configuration

### Firebase

Firebase configuration is in [`src/firebase.js`](src/firebase.js). To use your own Firebase project:

1. Create a project at [Firebase Console](https://console.firebase.google.com/)
2. Enable **Authentication** → Google Sign-In
3. Enable **Cloud Firestore**
4. Replace the `firebaseConfig` object in `src/firebase.js` with your project's config

### Relay Server

The relay server's persistent identity is stored in `relay-key.json` (auto-generated on first run). The Peer ID is deterministic from this key, so it stays the same across restarts.

To deploy the relay to a cloud service like Render:
1. Deploy `relay.js` with its dependencies
2. Update the bootstrap multiaddr in `src/utils/p2p.js` to point to your deployed URL

---

## 📦 Key Dependencies

| Package | Version | Purpose |
|---|---|---|
| `react` / `react-dom` | ^18.2.0 | UI framework |
| `vite` | ^5.1.0 | Build tool and dev server |
| `tailwindcss` | ^3.4.19 | CSS framework |
| `lucide-react` | ^1.31.0 | Icon library |
| `firebase` | ^12.17.1 | Auth + Firestore SDK |
| `libp2p` | ^3.3.8 | P2P networking core |
| `@libp2p/websockets` | ^10.1.19 | WebSocket transport |
| `@libp2p/webrtc` | ^6.0.29 | WebRTC transport |
| `@libp2p/circuit-relay-v2` | ^4.2.11 | Circuit relay (NAT traversal) |
| `@chainsafe/libp2p-gossipsub` | ^14.1.2 | PubSub for peer discovery |
| `@chainsafe/libp2p-noise` | ^17.0.0 | Encrypted connections |
| `@chainsafe/libp2p-yamux` | ^8.0.1 | Stream multiplexing |
| `@libp2p/bootstrap` | ^12.0.29 | Bootstrap peer list |
| `@libp2p/identify` | ^4.1.12 | Peer identification protocol |
| `@libp2p/pubsub-peer-discovery` | ^12.0.0 | PubSub-based discovery |
| `ws` | ^8.21.3 | WebSocket server (relay) |
| `concurrently` | ^8.2.2 | Run multiple scripts |
| `uint8arrays` | ^6.1.1 | Binary data helpers |

---

## 🧪 Troubleshooting

| Problem | Solution |
|---|---|
| `EADDRINUSE` on port 5173/10000/10001 | Run `./start.sh` to kill leftover processes, or manually: `lsof -ti:5173 \| xargs kill -9` |
| Peers not discovering each other | Ensure both browsers are on the same network and can reach the relay on port `10001` |
| `npm install` fails | Delete `node_modules` and `package-lock.json`, then run `npm install` again |
| Google Sign-In popup blocked | Allow popups for `localhost:5173` in your browser settings |
| Chunks not retrievable | Check the Network Log in the sidebar for errors. Ensure the relay server is running. |
| Vite dev server won't start | Make sure Node.js ≥ 18 is installed: `node --version` |

---

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Commit your changes: `git commit -m "Add my feature"`
4. Push to the branch: `git push origin feature/my-feature`
5. Open a Pull Request

---

## 📄 License

This project is private. See the repository settings for access details.

---

<p align="center">
  <strong>SwarmVault</strong> — Your files. Your keys. Your peers. 🛡️
</p>
