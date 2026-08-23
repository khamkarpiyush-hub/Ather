import React, { useState, useEffect, useRef } from 'react';
import {
  encryptAndShard,
  reassembleAndDecrypt,
  getVaultKey,
  getVaultKeyFingerprint,
  encryptMetadata,
  hydrateFileRecord,
  toStoredFileRecord,
  exportVaultKeyBase64,
  importVaultKey,
  LOCKED_LABEL,
} from './utils/crypto';
import { initP2PNode, distributeChunks, fetchChunks, getHostedChunkStats, loadHostedChunksFromDB, shareFileToNetwork, RELAY_PEER_ID } from './utils/p2p';
import { Shield, File, Lock, Trash2, Eye, X, LogOut, Sun, Moon, Download, HardDrive, Users, Package, Zap, KeyRound, Copy, Check, Fingerprint, Activity, Server, AlertTriangle, Radio } from 'lucide-react';

// Firebase & Firestore Imports
import { auth, provider, db } from './firebase';
import { signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc, setDoc } from 'firebase/firestore';

// Tailwind's JIT compiler only sees class names that appear literally in the
// source, so `bg-${color}-500/10` never generates any CSS. Real classes here.
const STAT_TONES = {
  emerald: { chip: 'bg-emerald-500/10', icon: 'text-emerald-500', value: 'text-emerald-500' },
  amber:   { chip: 'bg-amber-500/10',   icon: 'text-amber-500',   value: 'text-amber-500' },
  blue:    { chip: 'bg-blue-500/10',    icon: 'text-blue-500',    value: 'text-blue-500' },
  purple:  { chip: 'bg-purple-500/10',  icon: 'text-purple-500',  value: 'text-purple-500' },
};

// ─── Stat Card Component ───
const StatCard = ({ label, value, icon: Icon, color = 'emerald', isDarkMode }) => {
  const tone = STAT_TONES[color] || STAT_TONES.emerald;
  return (
    <div className={`${isDarkMode ? 'bg-zinc-900/80 border-zinc-800' : 'bg-white border-slate-200 shadow-sm'} border rounded-xl p-4 flex items-center gap-3 transition-all duration-300 hover:scale-[1.02]`}>
      <div className={`p-2.5 rounded-lg ${tone.chip}`}>
        <Icon className={`w-5 h-5 ${tone.icon}`} />
      </div>
      <div>
        <p className={`text-2xl font-bold ${tone.value}`}>{value}</p>
        <p className={`text-[10px] ${isDarkMode ? 'text-zinc-500' : 'text-slate-400'} uppercase tracking-widest font-medium`}>{label}</p>
      </div>
    </div>
  );
};

// ─── Shard signature ───
// With thumbnails gone there is nothing to preview, so a sealed file shows the
// one thing that is genuinely public about it: a fingerprint of its ciphertext.
// Deterministic (xorshift over the metadata token), so a tile looks the same on
// every reload and two different files never look alike.
const shardSignature = (record, cells = 16) => {
  const src = record.meta || Object.values(record.manifest || {}).join('') || 'sealed';
  let h = 2166136261;
  for (let i = 0; i < src.length; i++) {
    h = (Math.imul(h ^ src.charCodeAt(i), 16777619) >>> 0);
  }
  const out = [];
  for (let i = 0; i < cells; i++) {
    h = (h ^ (h << 13)) >>> 0;
    h = (h ^ (h >>> 17)) >>> 0;
    h = (h ^ (h << 5)) >>> 0;
    out.push((h % 1000) / 1000);
  }
  return out;
};

const ShardGlyph = ({ record, locked }) => (
  <div className="grid grid-cols-4 gap-[3px] w-16 h-16" aria-hidden="true">
    {shardSignature(record).map((v, i) => (
      <span
        key={i}
        className={`rounded-[2px] ${locked ? 'bg-amber-500' : 'bg-emerald-500'}`}
        style={{ opacity: 0.12 + v * 0.6 }}
      />
    ))}
  </div>
);

// Identity for de-duping records. The metadata token is unique per upload, so it
// works even for files this browser cannot decrypt. Legacy records fall back to
// their plaintext name.
const recordKey = (record) => `${record.meta || record.name || ''}::${record.uploadedAt}`;

const App = () => {
  // Authentication State
  const [user, setUser] = useState(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [imgError, setImgError] = useState(false);

  // Theme State (Dark / Light Mode)
  const [isDarkMode, setIsDarkMode] = useState(() => {
    const saved = localStorage.getItem('swarmvault_theme');
    return saved !== null ? JSON.parse(saved) : true;
  });

  useEffect(() => {
    localStorage.setItem('swarmvault_theme', JSON.stringify(isDarkMode));
  }, [isDarkMode]);

  // Vault & Network State
  const [peerId, setPeerId] = useState('Connecting to Swarm...');
  const [activePeers, setActivePeers] = useState(new Set());
  const [statusLog, setStatusLog] = useState([]);
  const [viewShard, setViewShard] = useState(null); 
  const [previewFile, setPreviewFile] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [hostedStats, setHostedStats] = useState({ count: 0, totalBytes: 0 });
  const nodeRef = useRef(null); 

  const [vaultFiles, setVaultFiles] = useState([]);
  const [networkFiles, setNetworkFiles] = useState([]); // Files shared by other peers
  const [isDataLoading, setIsDataLoading] = useState(false);

  // Vault Key Settings
  const [showKeyPanel, setShowKeyPanel] = useState(false);
  const [keyFingerprint, setKeyFingerprint] = useState(null);
  const [revealedKey, setRevealedKey] = useState(null);
  const [copiedKey, setCopiedKey] = useState(false);
  const [importText, setImportText] = useState('');
  const [keyNotice, setKeyNotice] = useState(null); // { tone: 'error' | 'success', text }
  const [isImporting, setIsImporting] = useState(false);

  // Node uptime, for the telemetry panel
  const bootedAtRef = useRef(Date.now());
  const [uptime, setUptime] = useState('00:00:00');

  const isLocalMode = activePeers.size === 0;

  // Calculate total storage freed
  const storageSaved = vaultFiles.reduce((acc, f) => {
    if (f.manifest) {
      const chunkCount = Object.keys(f.manifest).length;
      return acc + (chunkCount * 1024 * 1024); // estimate ~1MB per chunk
    }
    return acc;
  }, 0);
  const storageSavedMB = (storageSaved / (1024 * 1024)).toFixed(1);

  // Poll hosted chunk stats every 3 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      setHostedStats(getHostedChunkStats());
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  // Tick node uptime once a second
  useEffect(() => {
    const tick = () => {
      const secs = Math.floor((Date.now() - bootedAtRef.current) / 1000);
      const pad = (n) => String(n).padStart(2, '0');
      setUptime(`${pad(Math.floor(secs / 3600))}:${pad(Math.floor((secs % 3600) / 60))}:${pad(secs % 60)}`);
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, []);

  // Read the vault from Firestore and decrypt each record's metadata. Called on
  // login and again after a key import, since a new key changes what opens.
  const loadVaultFromCloud = async (uid) => {
    const docSnap = await getDoc(doc(db, 'vaults', uid));
    const stored = docSnap.exists() ? (docSnap.data().files || []) : [];
    const hydrated = (await Promise.all(stored.map(hydrateFileRecord))).filter(Boolean);
    setVaultFiles(hydrated);
    return hydrated;
  };

  // Listen for Google Login/Logout & Fetch Cloud Data
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      setIsAuthLoading(false);

      if (currentUser) {
        setIsDataLoading(true);
        try {
          await loadVaultFromCloud(currentUser.uid);
        } catch (err) {
          console.error("Error fetching vault from Firestore:", err);
        } finally {
          setIsDataLoading(false);
        }
      } else {
        setVaultFiles([]);
      }
    });
    return () => unsubscribe();
  }, []);

  // Helper to save vault changes to Firestore Cloud.
  // Only the encrypted projection is persisted — no filename, size, MIME type
  // or preview ever reaches Firestore.
  const saveVaultToCloud = async (updatedFiles) => {
    setVaultFiles(updatedFiles);
    if (!user) return;
    try {
      const docRef = doc(db, 'vaults', user.uid);
      await setDoc(docRef, { files: updatedFiles.map(toStoredFileRecord) });
    } catch (err) {
      console.error("Error saving vault to Firestore:", err);
    }
  };

  // Boot P2P Node (Only if user is logged in)
  useEffect(() => {
    if (!user) return;
    
    const startupP2P = async () => {
      try {
        // Make sure this browser's vault key exists before any upload can run
        try {
          await getVaultKey();
          const fp = await getVaultKeyFingerprint();
          setKeyFingerprint(fp);
          addLog('success', `🔑 Vault key ready (fingerprint ${fp})`);
        } catch (keyErr) {
          addLog('error', 'Vault key problem: ' + keyErr.message);
        }

        // Load persisted hosted chunks first
        await loadHostedChunksFromDB();
        setHostedStats(getHostedChunkStats());

        const node = await initP2PNode(
          (newPeer) => {
            const id = typeof newPeer === 'string' ? newPeer : newPeer.toString();
            if (id === RELAY_PEER_ID) return;
            setActivePeers(prev => new Set(prev).add(id));
          },
          (lostPeer) => {
            const id = typeof lostPeer === 'string' ? lostPeer : lostPeer.toString();
            setActivePeers(prev => {
               const updated = new Set(prev);
               updated.delete(id);
               return updated;
            });
          },
          // When another peer shares a file with us. The payload carries only an
          // encrypted metadata token, so decrypt it before anything is rendered
          // — a file from another vault must never surface a name it can't read.
          async (fileInfo, fromPeerId) => {
            const record = await hydrateFileRecord(fileInfo);
            if (!record) return;

            setNetworkFiles(prev => {
              if (prev.some(f => recordKey(f) === recordKey(record))) return prev;
              return [...prev, { ...record, fromPeerId, receivedAt: Date.now() }];
            });
            setHostedStats(getHostedChunkStats());

            if (record.vaultLocked) {
              addLog('info', `🔒 Hosting shards of a ${LOCKED_LABEL} from peer ${fromPeerId?.slice(-8)}`);
            } else {
              addLog('success', `📂 Received shared file "${record.name}" from peer ${fromPeerId?.slice(-8)}`);
            }
          }
        );
        nodeRef.current = node;
        setPeerId(node.peerId.toString());
        addLog('success', 'Connected to the P2P Swarm');
      } catch (err) {
        addLog('error', 'Failed to start P2P node: ' + err.message);
      }
    };
    startupP2P();
  }, [user]);

  const addLog = (type, message) => {
    const timestamp = new Date().toLocaleTimeString();
    setStatusLog(prev => [...prev, { type, message, timestamp }]);
  };

  // Auth Functions
  const handleLogin = async () => {
    try {
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error("Login Failed", error);
    }
  };

  const handleLogout = async () => {
    await signOut(auth);
    setVaultFiles([]); 
  };

  // Vault Functions
  const handleEmptyVault = async () => {
    if(window.confirm("Are you sure you want to permanently delete all files in your vault? This cannot be undone.")) {
      await saveVaultToCloud([]);
      indexedDB.deleteDatabase('SwarmVaultDB'); 
      addLog('error', 'Vault completely wiped and destroyed.');
    }
  };

  const handleDeleteSingleFile = async (indexToRemove, fileName) => {
    if(window.confirm(`Are you sure you want to delete ${fileName}?`)) {
      const updated = vaultFiles.filter((_, i) => i !== indexToRemove);
      await saveVaultToCloud(updated);
      addLog('success', `${fileName} deleted from the vault.`);
    }
  };

  const handleFileDrop = async (event) => {
    event.preventDefault(); 
    const file = event.dataTransfer ? event.dataTransfer.files[0] : event.target.files[0];
    if (!file || !nodeRef.current) return;
    
    try {
      setUploadProgress({ step: 1, total: 4, label: 'Encrypting with AES-256-GCM...' });
      addLog('info', `Encrypting ${file.name}...`);

      const { chunks, iv, mimeType } = await encryptAndShard(file);

      setUploadProgress({ step: 2, total: 4, label: `Sharding into ${chunks.length} chunks...` });

      const peerIdsArray = activePeers.size > 0 ? Array.from(activePeers) : ['local-network-mock'];

      setUploadProgress({ step: 3, total: 4, label: 'Distributing to swarm peers...' });
      addLog('info', 'Distributing chunks to swarm...');
      const manifest = await distributeChunks(nodeRef.current, chunks, peerIdsArray);

      setUploadProgress({ step: 4, total: 4, label: '✓ Secured!' });

      // Name, size and MIME type are as revealing as the bytes, so they are
      // encrypted into a single opaque token with the same vault key.
      const meta = await encryptMetadata({
        name: file.name,
        size: file.size,
        mimeType: file.type,
      });
      const uploadedAt = Date.now();

      // `meta`, `manifest` and `uploadedAt` are the whole stored record; the
      // plaintext fields below live in React state only, so the UI can render
      // this file without decrypting it again. toStoredFileRecord() drops them.
      const updatedFiles = [...vaultFiles, {
        meta,
        manifest,
        uploadedAt,
        name: file.name,
        size: file.size,
        mimeType,
        iv,
        unlocked: false,
        vaultLocked: false,
      }];

      await saveVaultToCloud(updatedFiles);

      // Share with connected peers. Neither the vault key nor any plaintext
      // detail is included — peers can hold and serve the shards but can read
      // neither the contents nor the filename. That is what makes it a vault.
      // `name` is a fixed placeholder purely so the relay's log line stays
      // legible; hydrateFileRecord always overwrites it from `meta`.
      shareFileToNetwork({ meta, manifest, uploadedAt, name: '[encrypted]' });

      if (event.target) event.target.value = '';
      addLog('success', `${file.name} secured & shared with ${activePeers.size} peer(s)! (${chunks.length} chunks distributed)`);

      setTimeout(() => setUploadProgress(null), 1500);
    } catch (error) {
      setUploadProgress(null);
      addLog('error', 'File upload failed: ' + error.message);
    }
  };

  // Fetch shards and decrypt with this browser's vault key.
  // Distinguishes "shards missing" (network) from "wrong key" (locked vault).
  const fetchAndDecrypt = async (fileRecord) => {
    const chunks = await fetchChunks(nodeRef.current, fileRecord.manifest);
    const expected = Object.keys(fileRecord.manifest || {}).length;
    if (chunks.length !== expected) {
      throw new Error(
        `only ${chunks.length} of ${expected} shards returned — peers holding the rest are offline`
      );
    }
    // Files written before the single-vault-key change carry their own key + IV
    const legacy = fileRecord.exportedKey
      ? { exportedKey: fileRecord.exportedKey, iv: fileRecord.iv }
      : null;
    return reassembleAndDecrypt(chunks, fileRecord.mimeType, legacy);
  };

  // Flag a record as undecryptable so the UI can show it as a Locked Vault File
  const markVaultLocked = (index, networkIndex) => {
    if (networkIndex >= 0) {
      setNetworkFiles(prev => prev.map((f, i) => (i === networkIndex ? { ...f, vaultLocked: true } : f)));
    } else if (index >= 0) {
      setVaultFiles(prev => prev.map((f, i) => (i === index ? { ...f, vaultLocked: true } : f)));
    }
  };

  // Download — fetches, decrypts, and triggers browser download
  const handleFileRetrieve = async (fileRecord, index, networkIndex = -1) => {
    if (fileRecord.vaultLocked) return; // sealed cards are inert
    addLog('info', `Fetching shards for ${fileRecord.name}...`);
    const start = performance.now();

    try {
      const decryptedUrl = await fetchAndDecrypt(fileRecord);

      const elapsed = ((performance.now() - start) / 1000).toFixed(2);

      // Only update vault state for own files (not network files where index = -1)
      if (index >= 0) {
        setVaultFiles(prev => {
          const newFiles = [...prev];
          newFiles[index].unlocked = true;
          newFiles[index].decryptedUrl = decryptedUrl;
          return newFiles;
        });
      }

      const link = document.createElement('a');
      link.href = decryptedUrl;
      link.download = `unlocked_${fileRecord.name}`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      addLog('success', `${fileRecord.name} decrypted & downloaded in ${elapsed}s ⚡${index < 0 ? ' (from peer!)' : ''}`);

      if (index >= 0) {
        setTimeout(() => {
          setVaultFiles(prev => {
            const newFiles = [...prev];
            if (newFiles[index]) {
              newFiles[index].unlocked = false;
              URL.revokeObjectURL(newFiles[index].decryptedUrl);
            }
            return newFiles;
          });
        }, 3000);
      } else {
        // Clean up network file blob after a delay
        setTimeout(() => URL.revokeObjectURL(decryptedUrl), 5000);
      }

    } catch (err) {
      if (err.isVaultLocked) {
        markVaultLocked(index, networkIndex);
        addLog('info', `🔒 "${fileRecord.name}" is a Locked Vault File — encrypted with another peer's key`);
      } else {
        addLog('error', `Could not retrieve ${fileRecord.name}: ${err.message}`);
      }
    }
  };

  // Preview — fetches, decrypts, and opens in a modal (no download)
  const handleFilePreview = async (fileRecord, index, networkIndex = -1) => {
    if (fileRecord.vaultLocked) return; // sealed cards are inert
    addLog('info', `Previewing ${fileRecord.name}...`);
    const start = performance.now();

    try {
      const decryptedUrl = await fetchAndDecrypt(fileRecord);

      const elapsed = ((performance.now() - start) / 1000).toFixed(2);

      setPreviewFile({ url: decryptedUrl, name: fileRecord.name, mimeType: fileRecord.mimeType });
      addLog('success', `${fileRecord.name} decrypted for preview in ${elapsed}s ⚡`);
    } catch (err) {
      if (err.isVaultLocked) {
        markVaultLocked(index, networkIndex);
        addLog('info', `🔒 "${fileRecord.name}" is a Locked Vault File — encrypted with another peer's key`);
      } else {
        addLog('error', `Preview failed for ${fileRecord.name}: ${err.message}`);
      }
    }
  };

  const closePreview = () => {
    if (previewFile) {
      URL.revokeObjectURL(previewFile.url);
      setPreviewFile(null);
    }
  };

  // ─── Vault Key Settings ───

  const openKeyPanel = () => {
    setRevealedKey(null);
    setImportText('');
    setKeyNotice(null);
    setCopiedKey(false);
    setShowKeyPanel(true);
  };

  const handleRevealKey = async () => {
    try {
      setRevealedKey(await exportVaultKeyBase64());
      setKeyNotice(null);
    } catch (err) {
      setKeyNotice({ tone: 'error', text: err.message });
    }
  };

  const handleCopyKey = async () => {
    try {
      const token = revealedKey || await exportVaultKeyBase64();
      setRevealedKey(token);
      await navigator.clipboard.writeText(token);
      setCopiedKey(true);
      setKeyNotice(null);
      setTimeout(() => setCopiedKey(false), 2000);
    } catch (err) {
      setKeyNotice({ tone: 'error', text: 'Could not reach the clipboard. Select the key above and copy it by hand.' });
    }
  };

  // Replacing the key changes what this browser can read, so every record is
  // re-hydrated against the new key: files it unlocks appear, files it doesn't
  // fall back to sealed.
  const handleImportKey = async () => {
    setIsImporting(true);
    setKeyNotice(null);
    try {
      const fingerprint = await importVaultKey(importText);
      setKeyFingerprint(fingerprint);
      setImportText('');
      setRevealedKey(null);

      let unlockedCount = 0;
      if (user) {
        const reloaded = await loadVaultFromCloud(user.uid);
        unlockedCount = reloaded.filter(f => !f.vaultLocked).length;
      }
      const rehydratedNetwork = await Promise.all(networkFiles.map(hydrateFileRecord));
      setNetworkFiles(rehydratedNetwork.filter(Boolean));

      setKeyNotice({
        tone: 'success',
        text: `Key ${fingerprint} loaded. ${unlockedCount} file${unlockedCount === 1 ? '' : 's'} in this vault now open.`,
      });
      addLog('success', `🔑 Vault key replaced — fingerprint ${fingerprint}, ${unlockedCount} file(s) readable`);
    } catch (err) {
      setKeyNotice({ tone: 'error', text: err.message });
    } finally {
      setIsImporting(false);
    }
  };

  // What a peer actually holds. Built from the record's own encrypted metadata
  // token where available, so this shows real ciphertext rather than decoration.
  const generateRawGibberish = (record) => {
    const bytes = Array.isArray(record?.iv) ? record.iv : Object.values(record?.iv || {});
    const ivHex = bytes.length
      ? bytes.map(b => b.toString(16).padStart(2, '0')).join('')
      : '—— (carried inside the payload)';
    const body = (record?.meta || '')
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 320) || 'a7f3b9c8d2e1f4a6b5c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5';
    return `IV  ${ivHex}\nAEAD AES-256-GCM\n\n${body}\n\n...[${LOCKED_LABEL.toUpperCase()} — CIPHERTEXT CONTINUES ACROSS ${Object.keys(record?.manifest || {}).length} SHARD(S)]`;
  };

  const getFileExtension = (mimeType) => {
    if (!mimeType) return 'FILE';
    const sub = mimeType.split('/')[1];
    if (sub === 'jpeg') return 'JPG';
    if (sub === 'plain') return 'TXT';
    return (sub || 'FILE').toUpperCase().slice(0, 4);
  };

  const formatBytes = (bytes) => {
    if (!bytes) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  // --- RENDER LOADING ---
  if (isAuthLoading || isDataLoading) {
    return (
      <div className={`${isDarkMode ? 'bg-[#0a0a0a] text-emerald-500' : 'bg-slate-100 text-emerald-600'} h-screen w-full flex flex-col items-center justify-center font-medium gap-4`}>
        <Shield className="w-12 h-12 animate-pulse" />
        <p className="tracking-wider">Loading SwarmVault Cloud...</p>
      </div>
    );
  }

  // --- RENDER LOGIN SCREEN ---
  if (!user) {
    return (
      <div className={`${isDarkMode ? 'bg-[#0a0a0a] text-white' : 'bg-slate-50 text-slate-900'} h-screen w-full flex flex-col items-center justify-center font-sans transition-colors duration-300`}>
        <div className="absolute top-6 right-6">
          <button 
            onClick={() => setIsDarkMode(!isDarkMode)} 
            className={`p-2.5 rounded-full ${isDarkMode ? 'bg-zinc-800 text-amber-400 hover:bg-zinc-700' : 'bg-white text-slate-700 shadow-md hover:bg-slate-100'} transition-colors`}
            title="Toggle Theme"
          >
            {isDarkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
          </button>
        </div>
        <div className={`${isDarkMode ? 'bg-zinc-900/80 border-zinc-800 text-white' : 'bg-white border-slate-200 text-slate-900 shadow-xl'} border p-10 rounded-2xl flex flex-col items-center max-w-md w-full text-center transition-colors duration-300 backdrop-blur-sm`}>
          <div className="relative mb-6">
            <Shield className="text-emerald-500 w-16 h-16" />
            <div className="absolute -top-1 -right-1 w-4 h-4 bg-emerald-500 rounded-full animate-ping opacity-50" />
          </div>
          <h1 className="text-3xl font-bold tracking-wider mb-2">SwarmVault</h1>
          <p className={`${isDarkMode ? 'text-zinc-400' : 'text-slate-500'} mb-8 text-sm leading-relaxed`}>Decentralized, zero-knowledge file storage.<br/>Your files. Your keys. Your peers.</p>
          <button 
            onClick={handleLogin}
            className={`w-full ${isDarkMode ? 'bg-white hover:bg-zinc-200 text-black' : 'bg-slate-900 hover:bg-slate-800 text-white'} font-semibold py-3 px-4 rounded-xl flex items-center justify-center gap-3 transition-all duration-200 hover:scale-[1.02] active:scale-95`}
          >
            <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google" className="w-5 h-5" />
            Continue with Google
          </button>
        </div>
      </div>
    );
  }

  // --- RENDER VAULT ---
  return (
    <div className={`${isDarkMode ? 'bg-[#0a0a0a] text-white' : 'bg-slate-50 text-slate-900'} min-h-screen flex flex-col font-sans relative transition-colors duration-300`}>
      {/* ─── Header ─── */}
      <header className={`flex justify-between items-center p-5 border-b ${isDarkMode ? 'border-zinc-800/50' : 'border-slate-200'} transition-colors duration-300`}>
        <div className="flex items-center gap-2.5">
          <Shield className="text-emerald-500 w-6 h-6" />
          <h1 className="text-xl font-bold tracking-wider">SwarmVault</h1>
        </div>
        <div className="flex items-center gap-3 text-sm">
          {/* Peer count with pulsing indicator */}
          <div className={`hidden md:flex items-center gap-2 ${isDarkMode ? 'bg-zinc-800/60 text-zinc-200' : 'bg-slate-200 text-slate-700'} px-3 py-1.5 rounded-full text-xs font-medium`}>
            <span className="relative flex h-2 w-2">
              {!isLocalMode && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />}
              <span className={`relative inline-flex rounded-full h-2 w-2 ${isLocalMode ? 'bg-amber-500' : 'bg-emerald-500'}`} />
            </span>
            <p>{activePeers.size} Peer{activePeers.size !== 1 ? 's' : ''}</p>
          </div>
          
          <button
            onClick={openKeyPanel}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full transition-colors text-xs font-medium ${isDarkMode ? 'bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400' : 'bg-emerald-50 hover:bg-emerald-100 text-emerald-700'}`}
            title="Vault key settings"
          >
            <KeyRound className="w-3.5 h-3.5" />
            <span className="hidden sm:inline font-mono">{keyFingerprint || 'vault key'}</span>
          </button>

          <button onClick={handleEmptyVault} className="hidden md:flex items-center gap-1.5 bg-red-600/10 hover:bg-red-600/25 text-red-400 px-3 py-1.5 rounded-full transition-colors text-xs font-medium">
            <Trash2 className="w-3.5 h-3.5" /> Empty Vault
          </button>

          <button 
            onClick={() => setIsDarkMode(!isDarkMode)} 
            className={`p-2 rounded-full ${isDarkMode ? 'bg-zinc-800 text-amber-400 hover:bg-zinc-700' : 'bg-slate-200 text-slate-700 hover:bg-slate-300'} transition-colors`}
            title="Toggle Theme"
          >
            {isDarkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>

          <div className={`flex items-center gap-3 pl-3 border-l ${isDarkMode ? 'border-zinc-700' : 'border-slate-300'}`}>
            {user.photoURL && !imgError ? (
              <img 
                src={user.photoURL} 
                alt="Profile" 
                onError={() => setImgError(true)} 
                className="w-8 h-8 rounded-full object-cover border-2 border-emerald-500/50" 
              />
            ) : (
              <div className="w-8 h-8 rounded-full bg-emerald-600 flex items-center justify-center text-white font-bold text-xs">
                {user.displayName ? user.displayName[0].toUpperCase() : 'U'}
              </div>
            )}
            <button onClick={handleLogout} className={`${isDarkMode ? 'text-zinc-400 hover:text-white' : 'text-slate-500 hover:text-slate-900'} transition-colors`} title="Sign Out">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="flex flex-col flex-1 p-6 max-w-6xl mx-auto w-full gap-6">
        {/* ─── Stats Dashboard ─── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Files Secured" value={vaultFiles.length} icon={Lock} color="emerald" isDarkMode={isDarkMode} />
          <StatCard label="Active Peers" value={activePeers.size} icon={Users} color={activePeers.size > 0 ? 'emerald' : 'amber'} isDarkMode={isDarkMode} />
          <StatCard label="Chunks Hosted" value={hostedStats.count} icon={Package} color="blue" isDarkMode={isDarkMode} />
          <StatCard label="Storage Freed" value={`${storageSavedMB} MB`} icon={HardDrive} color="purple" isDarkMode={isDarkMode} />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="md:col-span-2 flex flex-col gap-4">
            {/* ─── Upload Drop Zone ─── */}
            <div 
              className={`border-2 border-dashed ${isDarkMode ? 'border-zinc-700 hover:border-emerald-500/60 bg-zinc-900/30' : 'border-slate-300 hover:border-emerald-500 bg-white shadow-sm'} transition-all duration-300 rounded-xl p-10 flex flex-col items-center justify-center text-center cursor-pointer group`}
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleFileDrop}
              onClick={() => document.getElementById('fileInput').click()}
            >
              <input id="fileInput" type="file" className="hidden" onChange={handleFileDrop} />
              <div className={`${isDarkMode ? 'bg-zinc-800' : 'bg-slate-100'} p-4 rounded-full mb-4 group-hover:scale-110 transition-transform duration-300`}>
                 <File className="text-emerald-500 w-7 h-7" />
              </div>
              <h3 className={`text-lg font-medium mb-1 ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>Upload to the Swarm</h3>
              <p className={`text-sm ${isDarkMode ? 'text-zinc-500' : 'text-slate-500'}`}>Drag & drop a file, or click to browse</p>
              
              {/* Upload Progress Bar */}
              {uploadProgress && (
                <div className="w-full max-w-xs mt-5">
                  <div className={`h-1.5 ${isDarkMode ? 'bg-zinc-800' : 'bg-slate-200'} rounded-full overflow-hidden`}>
                    <div 
                      className="h-full bg-gradient-to-r from-emerald-500 to-emerald-400 rounded-full transition-all duration-700 ease-out"
                      style={{ width: `${(uploadProgress.step / uploadProgress.total) * 100}%` }} 
                    />
                  </div>
                  <p className="text-xs text-emerald-500 mt-2 font-medium">{uploadProgress.label}</p>
                </div>
              )}
            </div>

            {/* ─── Encrypted Vault ─── */}
            <div className={`${isDarkMode ? 'bg-zinc-900/50 border-zinc-800' : 'bg-white border-slate-200 shadow-sm'} rounded-xl border p-5 flex-1 transition-colors duration-300`}>
              <h2 className={`text-base font-semibold mb-4 ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>Your Encrypted Vault</h2>
              {vaultFiles.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 opacity-40">
                  <Shield className={`w-14 h-14 ${isDarkMode ? 'text-zinc-600' : 'text-slate-400'} mb-4`} />
                  <p className={`${isDarkMode ? 'text-zinc-500' : 'text-slate-400'} text-sm font-medium`}>Your vault is empty</p>
                  <p className={`${isDarkMode ? 'text-zinc-600' : 'text-slate-400'} text-xs mt-1`}>Upload files to encrypt and distribute them across the swarm</p>
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {vaultFiles.map((f, i) => (
                    <div
                      key={recordKey(f) || i}
                      aria-disabled={f.vaultLocked ? 'true' : undefined}
                      className={`relative group aspect-square rounded-lg overflow-hidden border flex flex-col items-center justify-center transition-all duration-200 ${
                        f.vaultLocked
                          ? `cursor-not-allowed select-none ${isDarkMode ? 'bg-zinc-900 border-amber-500/25 text-amber-200/70' : 'bg-amber-50/60 border-amber-300/70 text-amber-900/70'}`
                          : `${isDarkMode ? 'bg-zinc-800/80 border-zinc-700/50 text-white' : 'bg-slate-100 border-slate-200 text-slate-800'} hover:border-emerald-500/30`
                      }`}
                    >

                      {/* Type badge — a sealed file has no readable MIME type */}
                      <span className={`absolute top-2 left-2 text-[9px] px-1.5 py-0.5 rounded font-mono uppercase tracking-wide backdrop-blur-sm z-10 ${f.vaultLocked ? 'bg-amber-500/20 text-amber-300' : 'bg-black/50 text-white'}`}>
                        {f.vaultLocked ? 'Sealed' : getFileExtension(f.mimeType)}
                      </span>

                      {/* Delete stays available even when sealed — otherwise a
                          record whose key is gone could never be cleared. */}
                      {!f.unlocked && (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDeleteSingleFile(i, f.vaultLocked ? LOCKED_LABEL : f.name); }}
                          className="absolute top-2 right-2 bg-red-600/80 hover:bg-red-500 text-white p-1.5 rounded-full z-10 opacity-0 group-hover:opacity-100 transition-opacity"
                          title="Delete this record"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}

                      {/* Decrypted image, or the file's ciphertext signature */}
                      {f.unlocked && f.decryptedUrl && (f.mimeType || '').startsWith('image/') ? (
                        <img
                          src={f.decryptedUrl}
                          alt={f.name}
                          className="object-cover w-full h-full transition-all duration-700"
                        />
                      ) : (
                        <ShardGlyph record={f} locked={f.vaultLocked} />
                      )}

                      {/* Lock overlay */}
                      {!f.unlocked && (
                        <div className="absolute inset-0 flex items-start justify-center pointer-events-none pt-[22%]">
                          <Lock className={`w-5 h-5 ${f.vaultLocked ? 'text-amber-400/40' : 'text-white/25'} drop-shadow-lg`} />
                        </div>
                      )}

                      {/* Sealed files get no actions at all */}
                      {f.vaultLocked ? (
                        <div className="absolute inset-x-0 bottom-8 px-3 text-center">
                          <span className="inline-flex items-center gap-1.5 bg-amber-500/10 text-amber-400 px-2.5 py-1 rounded-full text-[10px] font-medium border border-amber-500/20">
                            <Lock className="w-3 h-3" /> {LOCKED_LABEL}
                          </span>
                        </div>
                      ) : !f.unlocked && (
                        <div className="absolute inset-0 bg-black/80 opacity-0 group-hover:opacity-100 transition-all duration-200 flex flex-col items-center justify-center gap-2">
                          <button onClick={() => handleFilePreview(f, i)} className="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-1.5 rounded-full text-xs font-medium flex items-center gap-1.5 transition-colors">
                            <Eye className="w-3.5 h-3.5" /> Preview
                          </button>
                          <button onClick={() => handleFileRetrieve(f, i)} className="bg-zinc-700 hover:bg-zinc-600 text-white px-4 py-1.5 rounded-full text-xs font-medium flex items-center gap-1.5 transition-colors">
                            <Download className="w-3.5 h-3.5" /> Download
                          </button>
                          <button onClick={() => setViewShard(f)} className="text-zinc-400 hover:text-white text-[10px] font-medium flex items-center gap-1 transition-colors mt-1">
                            <Lock className="w-3 h-3" /> Peer View
                          </button>
                        </div>
                      )}

                      {/* Name bar — reads LOCKED_LABEL when the metadata won't open */}
                      <div className={`absolute bottom-0 left-0 right-0 p-2 text-[11px] truncate text-center ${f.vaultLocked ? 'bg-gradient-to-t from-amber-950/90 to-transparent text-amber-200/80 font-mono' : 'bg-gradient-to-t from-black/90 to-transparent text-white/80'}`}>
                        {f.name}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ─── Network Shared Files (from other peers) ─── */}
            {networkFiles.length > 0 && (
              <div className={`${isDarkMode ? 'bg-zinc-900/50 border-zinc-800' : 'bg-white border-slate-200 shadow-sm'} rounded-xl border p-5 transition-colors duration-300`}>
                <div className="flex items-center gap-2 mb-4">
                  <Users className="w-4 h-4 text-blue-400" />
                  <h2 className={`text-base font-semibold ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>Network Shared Files</h2>
                  <span className="bg-blue-500/10 text-blue-400 px-2 py-0.5 rounded-full text-[10px] font-medium">{networkFiles.length} file{networkFiles.length !== 1 ? 's' : ''}</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {networkFiles.map((f, i) => (
                    <div
                      key={recordKey(f) || `net-${i}`}
                      aria-disabled={f.vaultLocked ? 'true' : undefined}
                      className={`relative group aspect-square rounded-lg overflow-hidden border flex flex-col items-center justify-center transition-all duration-200 ${
                        f.vaultLocked
                          ? `cursor-not-allowed select-none ${isDarkMode ? 'bg-zinc-900 border-amber-500/25' : 'bg-amber-50/60 border-amber-300/70'}`
                          : `${isDarkMode ? 'bg-zinc-800/80 text-white border-blue-500/20 hover:border-blue-500/50' : 'bg-blue-50 text-slate-800 border-blue-200 hover:border-blue-500/50'}`
                      }`}
                    >

                      {/* Origin badge */}
                      <span className={`absolute top-2 left-2 ${f.vaultLocked ? 'bg-amber-500/20 text-amber-300' : 'bg-blue-500/80 text-white'} text-[8px] px-1.5 py-0.5 rounded font-mono uppercase tracking-wide backdrop-blur-sm z-10`}>
                        {f.vaultLocked ? 'Sealed' : 'From Peer'}
                      </span>

                      {/* Type badge — only meaningful once the metadata opens */}
                      <span className={`absolute top-2 right-2 text-[9px] px-1.5 py-0.5 rounded font-mono uppercase tracking-wide backdrop-blur-sm z-10 ${f.vaultLocked ? 'bg-amber-500/10 text-amber-400/70' : 'bg-black/50 text-white'}`}>
                        {f.vaultLocked ? '///' : getFileExtension(f.mimeType)}
                      </span>

                      {/* No thumbnail exists for a peer's file — show its signature */}
                      <ShardGlyph record={f} locked={f.vaultLocked} />

                      <div className="absolute inset-0 flex items-start justify-center pointer-events-none pt-[22%]">
                        <Lock className={`w-5 h-5 ${f.vaultLocked ? 'text-amber-400/40' : 'text-blue-400/40'} drop-shadow-lg`} />
                      </div>

                      {f.vaultLocked ? (
                        /* Inert: no buttons, no hover surface, nothing to click */
                        <div className="absolute inset-x-0 bottom-7 px-2 text-center">
                          <span className="inline-flex items-center gap-1.5 bg-amber-500/10 text-amber-400 px-2.5 py-1 rounded-full text-[10px] font-medium border border-amber-500/20">
                            <Lock className="w-3 h-3" /> {LOCKED_LABEL}
                          </span>
                          <p className={`text-[9px] leading-snug mt-1.5 ${isDarkMode ? 'text-zinc-500' : 'text-amber-900/50'}`}>
                            Hosting {Object.keys(f.manifest || {}).length} shard(s) you can't read
                          </p>
                        </div>
                      ) : (
                        <div className="absolute inset-0 bg-black/80 opacity-0 group-hover:opacity-100 transition-all duration-200 flex flex-col items-center justify-center gap-2 px-3 text-center">
                          <button
                            onClick={() => handleFileRetrieve(f, -1, i)}
                            className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-1.5 rounded-full text-xs font-medium flex items-center gap-1.5 transition-colors"
                          >
                            <Download className="w-3.5 h-3.5" /> Retrieve & Decrypt
                          </button>
                          <p className="text-zinc-500 text-[9px]">
                            {f.size ? `${formatBytes(f.size)} • ` : ''}{Object.keys(f.manifest || {}).length} chunks
                          </p>
                        </div>
                      )}

                      {/* Name bar */}
                      <div className={`absolute bottom-0 left-0 right-0 p-2 text-[11px] truncate text-center ${f.vaultLocked ? 'bg-gradient-to-t from-amber-950/90 to-transparent text-amber-200/80 font-mono' : 'bg-gradient-to-t from-black/90 to-transparent text-white/80'}`}>
                        {f.name}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* ─── Sidebar: Network Log + Proof-of-Hosting ─── */}
          <div className="flex flex-col gap-4">
            {/* Network Log */}
            <div className={`${isDarkMode ? 'bg-zinc-900/50 border-zinc-800' : 'bg-white border-slate-200 shadow-sm'} border rounded-xl p-4 flex flex-col h-[320px] transition-colors duration-300`}>
              <h2 className={`text-xs font-semibold ${isDarkMode ? 'text-zinc-400' : 'text-slate-500'} mb-3 uppercase tracking-widest`}>Network Log</h2>
              <div className="flex flex-col gap-1.5 overflow-y-auto flex-1 scrollbar-thin">
                {statusLog.length === 0 ? (
                  <p className={`text-xs ${isDarkMode ? 'text-zinc-600' : 'text-slate-400'}`}>Waiting for activity...</p>
                ) : (
                  statusLog.map((log, index) => (
                    <div key={index} className={`text-[11px] p-2 rounded-md border-l-2 flex items-start gap-2 ${
                      log.type === 'error' ? `border-red-500 ${isDarkMode ? 'bg-red-500/5 text-red-300' : 'bg-red-50 text-red-600'}` :
                      log.type === 'success' ? `border-emerald-500 ${isDarkMode ? 'bg-emerald-500/5 text-emerald-300' : 'bg-emerald-50 text-emerald-600'}` :
                      `border-blue-500 ${isDarkMode ? 'bg-blue-500/5 text-blue-300' : 'bg-blue-50 text-blue-600'}`
                    }`}>
                      <span className={`text-[9px] ${isDarkMode ? 'text-zinc-600' : 'text-slate-400'} whitespace-nowrap mt-0.5`}>{log.timestamp}</span>
                      <span>{log.message}</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* ─── Node Telemetry ─── */}
            <div className={`${isDarkMode ? 'bg-zinc-900/50 border-zinc-800' : 'bg-white border-slate-200 shadow-sm'} border rounded-xl overflow-hidden transition-colors duration-300`}>

              {/* Status bar */}
              <div className={`flex items-center justify-between px-4 py-3 border-b ${isDarkMode ? 'border-zinc-800 bg-zinc-900/60' : 'border-slate-200 bg-slate-50'}`}>
                <div className="flex items-center gap-2">
                  <Server className={`w-3.5 h-3.5 ${isDarkMode ? 'text-zinc-400' : 'text-slate-500'}`} />
                  <h2 className={`text-xs font-semibold ${isDarkMode ? 'text-zinc-300' : 'text-slate-600'} uppercase tracking-widest`}>Storage Node</h2>
                </div>
                <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[9px] font-mono uppercase tracking-widest ${
                  isLocalMode
                    ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                    : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                }`}>
                  <span className="relative flex h-1.5 w-1.5">
                    {!isLocalMode && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />}
                    <span className={`relative inline-flex rounded-full h-1.5 w-1.5 ${isLocalMode ? 'bg-amber-500' : 'bg-emerald-500'}`} />
                  </span>
                  {isLocalMode ? 'Isolated' : 'Serving'}
                </span>
              </div>

              {/* Readouts — tabular, monospaced, aligned like a real node console */}
              <dl className={`px-4 py-3 text-[11px] font-mono divide-y ${isDarkMode ? 'divide-zinc-800/70' : 'divide-slate-100'}`}>
                {[
                  { icon: Package,   label: 'Shards held',    value: String(hostedStats.count).padStart(3, '0'), tone: 'text-blue-400' },
                  { icon: HardDrive, label: 'Volume served',  value: formatBytes(hostedStats.totalBytes),        tone: isDarkMode ? 'text-zinc-200' : 'text-slate-700' },
                  { icon: Radio,     label: 'Peers reached',  value: String(activePeers.size).padStart(3, '0'),  tone: activePeers.size > 0 ? 'text-emerald-400' : 'text-amber-400' },
                  { icon: Activity,  label: 'Uptime',         value: uptime,                                     tone: isDarkMode ? 'text-zinc-200' : 'text-slate-700' },
                ].map(({ icon: Icon, label, value, tone }) => (
                  <div key={label} className="flex items-center justify-between py-1.5">
                    <dt className={`flex items-center gap-2 ${isDarkMode ? 'text-zinc-500' : 'text-slate-400'}`}>
                      <Icon className="w-3 h-3" /> {label}
                    </dt>
                    <dd className={`tabular-nums font-semibold ${tone}`}>{value}</dd>
                  </div>
                ))}
              </dl>

              {/* Shard map — one cell per hosted shard, the node's live footprint */}
              <div className="px-4 pb-3">
                <div className={`flex items-center justify-between mb-2 text-[9px] uppercase tracking-widest ${isDarkMode ? 'text-zinc-600' : 'text-slate-400'}`}>
                  <span>Shard map</span>
                  <span className="font-mono">{Math.min(hostedStats.count, 60)}/60 slots</span>
                </div>
                <div className="grid grid-cols-12 gap-1">
                  {Array.from({ length: 60 }).map((_, i) => {
                    const filled = i < hostedStats.count;
                    const newest = filled && i === Math.min(hostedStats.count, 60) - 1;
                    return (
                      <span
                        key={i}
                        className={`h-2 rounded-[1px] transition-colors duration-500 ${
                          newest ? 'bg-emerald-400 animate-pulse'
                          : filled ? 'bg-blue-500/70'
                          : isDarkMode ? 'bg-zinc-800' : 'bg-slate-200'
                        }`}
                      />
                    );
                  })}
                </div>
              </div>

              {/* Footnote */}
              <div className={`mx-4 mb-4 text-[10px] leading-relaxed ${isDarkMode ? 'text-zinc-500 bg-zinc-800/40 border-zinc-700/50' : 'text-slate-500 bg-slate-50 border-slate-200'} p-2.5 rounded-lg border`}>
                <Lock className="w-3 h-3 inline mr-1 -mt-0.5" />
                Every shard above is opaque AES-256-GCM ciphertext. This node stores and serves them without ever holding the keys that open them.
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* ─── Vault Key Settings ─── */}
      {showKeyPanel && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 backdrop-blur-sm" onClick={() => setShowKeyPanel(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Vault key settings"
            className={`${isDarkMode ? 'bg-zinc-900 border-zinc-700 text-white' : 'bg-white border-slate-200 text-slate-900'} border rounded-xl max-w-lg w-full shadow-2xl transition-colors overflow-hidden`}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className={`flex justify-between items-center px-6 py-4 border-b ${isDarkMode ? 'border-zinc-800' : 'border-slate-200'}`}>
              <h3 className="text-base font-semibold flex items-center gap-2">
                <KeyRound className="w-4 h-4 text-emerald-500" /> Vault key
              </h3>
              <button onClick={() => setShowKeyPanel(false)} className={`${isDarkMode ? 'text-zinc-400 hover:text-white' : 'text-slate-400 hover:text-slate-700'} transition-colors`} aria-label="Close">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="px-6 py-5 flex flex-col gap-5">
              {/* Current key */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className={`text-[10px] uppercase tracking-widest font-semibold ${isDarkMode ? 'text-zinc-500' : 'text-slate-400'}`}>This device</p>
                  <span className={`flex items-center gap-1.5 text-[11px] font-mono ${isDarkMode ? 'text-emerald-400' : 'text-emerald-700'}`}>
                    <Fingerprint className="w-3.5 h-3.5" /> {keyFingerprint || '········'}
                  </span>
                </div>
                <p className={`text-xs leading-relaxed ${isDarkMode ? 'text-zinc-400' : 'text-slate-500'}`}>
                  This key encrypts every file and filename in your vault. It never leaves this browser, so copy it somewhere safe — without it, your files cannot be recovered by anyone, including you.
                </p>
              </div>

              {/* Export */}
              <div className={`rounded-lg border p-3 ${isDarkMode ? 'border-zinc-800 bg-zinc-800/30' : 'border-slate-200 bg-slate-50'}`}>
                {revealedKey ? (
                  <>
                    <textarea
                      readOnly
                      value={revealedKey}
                      onClick={(e) => e.target.select()}
                      className={`w-full h-20 resize-none font-mono text-[10px] leading-relaxed rounded-md p-2 break-all ${isDarkMode ? 'bg-black text-emerald-400 border-zinc-800' : 'bg-white text-emerald-700 border-slate-200'} border focus:outline-none focus:ring-1 focus:ring-emerald-500`}
                    />
                    <div className="flex items-center gap-2 mt-2">
                      <button
                        onClick={handleCopyKey}
                        className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
                      >
                        {copiedKey ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                        {copiedKey ? 'Copied' : 'Copy key'}
                      </button>
                      <button
                        onClick={() => { setRevealedKey(null); setCopiedKey(false); }}
                        className={`text-xs font-medium px-3 py-1.5 rounded-md transition-colors ${isDarkMode ? 'text-zinc-400 hover:text-white hover:bg-zinc-800' : 'text-slate-500 hover:text-slate-900 hover:bg-slate-200'}`}
                      >
                        Hide
                      </button>
                    </div>
                  </>
                ) : (
                  <button
                    onClick={handleRevealKey}
                    className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
                  >
                    <Eye className="w-3.5 h-3.5" /> Export key
                  </button>
                )}
              </div>

              {/* Import */}
              <div className={`border-t pt-5 ${isDarkMode ? 'border-zinc-800' : 'border-slate-200'}`}>
                <label htmlFor="importKey" className={`block text-[10px] uppercase tracking-widest font-semibold mb-2 ${isDarkMode ? 'text-zinc-500' : 'text-slate-400'}`}>
                  Open a vault from another device
                </label>
                <textarea
                  id="importKey"
                  value={importText}
                  onChange={(e) => { setImportText(e.target.value); setKeyNotice(null); }}
                  placeholder="Paste the exported key here"
                  spellCheck="false"
                  className={`w-full h-20 resize-none font-mono text-[10px] leading-relaxed rounded-md p-2 border transition-colors focus:outline-none focus:ring-1 focus:ring-emerald-500 ${isDarkMode ? 'bg-black text-zinc-200 border-zinc-800 placeholder:text-zinc-600' : 'bg-white text-slate-700 border-slate-200 placeholder:text-slate-400'}`}
                />
                <div className="flex items-center justify-between gap-3 mt-2">
                  <p className={`text-[10px] leading-snug ${isDarkMode ? 'text-zinc-500' : 'text-slate-400'}`}>
                    Replaces the key on this device. Files encrypted with the old key will show as sealed.
                  </p>
                  <button
                    onClick={handleImportKey}
                    disabled={isImporting || !importText.trim()}
                    className="shrink-0 flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-700 disabled:text-zinc-500 disabled:cursor-not-allowed text-white px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
                  >
                    <KeyRound className="w-3.5 h-3.5" /> {isImporting ? 'Opening…' : 'Import key'}
                  </button>
                </div>
              </div>

              {/* Result */}
              {keyNotice && (
                <div className={`flex items-start gap-2 text-[11px] leading-snug p-2.5 rounded-lg border ${
                  keyNotice.tone === 'error'
                    ? 'bg-red-500/10 border-red-500/25 text-red-400'
                    : 'bg-emerald-500/10 border-emerald-500/25 text-emerald-400'
                }`}>
                  {keyNotice.tone === 'error'
                    ? <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                    : <Check className="w-3.5 h-3.5 shrink-0 mt-px" />}
                  <span>{keyNotice.text}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ─── Shard View Modal ─── */}
      {viewShard && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 backdrop-blur-sm" onClick={() => setViewShard(null)}>
          <div className={`${isDarkMode ? 'bg-zinc-900 border-zinc-700 text-white' : 'bg-white border-slate-200 text-slate-900'} border p-6 rounded-xl max-w-lg w-full shadow-2xl transition-colors`} onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold text-red-500 flex items-center gap-2"><Lock className="w-5 h-5"/> Shard Encrypted</h3>
              <button onClick={() => setViewShard(null)} className={`${isDarkMode ? 'text-zinc-400 hover:text-white' : 'text-slate-400 hover:text-slate-700'} transition-colors`}><X className="w-5 h-5"/></button>
            </div>
            <p className={`text-sm ${isDarkMode ? 'text-zinc-400' : 'text-slate-600'} mb-4`}>
              This is what a peer sees when holding a shard of <strong>{viewShard.name}</strong>. They receive the ciphertext and nothing else — not the filename, not the size, not the type. Without your vault key it cannot be opened.
            </p>
            <div className="bg-black p-4 rounded-lg border border-zinc-800 font-mono text-xs text-emerald-500 break-all h-32 overflow-y-auto whitespace-pre-wrap">
              {generateRawGibberish(viewShard)}
            </div>
          </div>
        </div>
      )}

      {/* ─── Preview Modal ─── */}
      {previewFile && (
        <div className="fixed inset-0 bg-black/90 flex items-center justify-center z-50 backdrop-blur-md" onClick={closePreview}>
          <div className="relative max-w-4xl max-h-[90vh] w-full mx-4 flex flex-col items-center" onClick={(e) => e.stopPropagation()}>
            {/* Close button */}
            <button onClick={closePreview} className="absolute -top-2 -right-2 bg-zinc-800 hover:bg-zinc-700 text-white p-2 rounded-full z-10 transition-colors shadow-lg">
              <X className="w-5 h-5"/>
            </button>
            
            {/* File name */}
            <div className="mb-3 flex items-center gap-2">
              <span className="bg-emerald-500/10 text-emerald-400 px-3 py-1 rounded-full text-xs font-medium">{getFileExtension(previewFile.mimeType)}</span>
              <span className="text-white text-sm font-medium">{previewFile.name}</span>
            </div>

            {/* Content */}
            {(previewFile.mimeType || '').startsWith('image/') ? (
              <img src={previewFile.url} alt={previewFile.name} className="max-w-full max-h-[80vh] object-contain rounded-lg shadow-2xl" />
            ) : (previewFile.mimeType || '').startsWith('audio/') ? (
              <div className={`bg-zinc-900 p-8 rounded-xl border border-zinc-800 flex flex-col items-center gap-4`}>
                <Zap className="w-12 h-12 text-emerald-500" />
                <p className="text-white text-sm">{previewFile.name}</p>
                <audio controls src={previewFile.url} className="w-80" />
              </div>
            ) : (previewFile.mimeType || '').startsWith('video/') ? (
              <video controls src={previewFile.url} className="max-w-full max-h-[80vh] rounded-lg shadow-2xl" />
            ) : previewFile.mimeType === 'application/pdf' ? (
              <iframe src={previewFile.url} title={previewFile.name} className="w-full h-[80vh] rounded-lg border border-zinc-700" />
            ) : (
              <div className={`bg-zinc-900 p-8 rounded-xl border border-zinc-800 flex flex-col items-center gap-4`}>
                <File className="w-12 h-12 text-zinc-500" />
                <p className="text-white text-sm">{previewFile.name}</p>
                <p className="text-zinc-500 text-xs">Preview not available for this file type. Use Download instead.</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default App;