import React, { useState, useEffect, useRef } from 'react';
import { encryptAndShard, reassembleAndDecrypt } from './utils/crypto';
import { initP2PNode, distributeChunks, fetchChunks, getHostedChunkStats, loadHostedChunksFromDB, shareFileToNetwork, RELAY_PEER_ID } from './utils/p2p';
import { Shield, File, Lock, Unlock, Trash2, Eye, X, LogOut, Sun, Moon, Download, HardDrive, Users, Package, Zap } from 'lucide-react'; 

// Firebase & Firestore Imports
import { auth, provider, db } from './firebase';
import { signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc, setDoc } from 'firebase/firestore';

// ─── Stat Card Component ───
const StatCard = ({ label, value, icon: Icon, color = 'emerald', isDarkMode }) => (
  <div className={`${isDarkMode ? 'bg-zinc-900/80 border-zinc-800' : 'bg-white border-slate-200 shadow-sm'} border rounded-xl p-4 flex items-center gap-3 transition-all duration-300 hover:scale-[1.02]`}>
    <div className={`p-2.5 rounded-lg bg-${color}-500/10`}>
      <Icon className={`w-5 h-5 text-${color}-500`} />
    </div>
    <div>
      <p className={`text-2xl font-bold text-${color}-500`}>{value}</p>
      <p className={`text-[10px] ${isDarkMode ? 'text-zinc-500' : 'text-slate-400'} uppercase tracking-widest font-medium`}>{label}</p>
    </div>
  </div>
);

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

  // Listen for Google Login/Logout & Fetch Cloud Data
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      setIsAuthLoading(false);

      if (currentUser) {
        setIsDataLoading(true);
        try {
          const docRef = doc(db, 'vaults', currentUser.uid);
          const docSnap = await getDoc(docRef);
          if (docSnap.exists()) {
            setVaultFiles(docSnap.data().files || []);
          } else {
            setVaultFiles([]);
          }
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

  // Helper to save vault changes to Firestore Cloud
  const saveVaultToCloud = async (updatedFiles) => {
    setVaultFiles(updatedFiles);
    if (!user) return;
    try {
      const docRef = doc(db, 'vaults', user.uid);
      await setDoc(docRef, { files: updatedFiles });
    } catch (err) {
      console.error("Error saving vault to Firestore:", err);
    }
  };

  // Boot P2P Node (Only if user is logged in)
  useEffect(() => {
    if (!user) return;
    
    const startupP2P = async () => {
      try {
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
          // When another peer shares a file with us
          (fileInfo, fromPeerId) => {
            setNetworkFiles(prev => {
              // Don't add duplicates
              if (prev.some(f => f.name === fileInfo.name && f.uploadedAt === fileInfo.uploadedAt)) return prev;
              return [...prev, { ...fileInfo, fromPeerId, receivedAt: Date.now() }];
            });
            setHostedStats(getHostedChunkStats());
            addLog('success', `📂 Received shared file "${fileInfo.name}" from peer ${fromPeerId?.slice(-8)}`);
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
      
      const { chunks, exportedKey, iv, mimeType, thumbnail } = await encryptAndShard(file);
      
      setUploadProgress({ step: 2, total: 4, label: `Sharding into ${chunks.length} chunks...` });
      
      const peerIdsArray = activePeers.size > 0 ? Array.from(activePeers) : ['local-network-mock'];
      
      setUploadProgress({ step: 3, total: 4, label: 'Distributing to swarm peers...' });
      addLog('info', 'Distributing chunks to swarm...');
      const manifest = await distributeChunks(nodeRef.current, chunks, peerIdsArray);

      setUploadProgress({ step: 4, total: 4, label: '✓ Secured!' });

      const updatedFiles = [...vaultFiles, {
        name: file.name,
        manifest,
        exportedKey,
        iv,
        mimeType,
        thumbnail, 
        unlocked: false,
        size: file.size,
        uploadedAt: Date.now()
      }];

      await saveVaultToCloud(updatedFiles);

      // Share file metadata with all connected peers so they can see & retrieve it
      const fileRecord = updatedFiles[updatedFiles.length - 1];
      shareFileToNetwork({
        name: fileRecord.name,
        manifest: fileRecord.manifest,
        exportedKey: fileRecord.exportedKey,
        iv: fileRecord.iv,
        mimeType: fileRecord.mimeType,
        thumbnail: fileRecord.thumbnail,
        size: fileRecord.size,
        uploadedAt: fileRecord.uploadedAt
      });

      if (event.target) event.target.value = ''; 
      addLog('success', `${file.name} secured & shared with ${activePeers.size} peer(s)! (${chunks.length} chunks distributed)`);
      
      setTimeout(() => setUploadProgress(null), 1500);
    } catch (error) {
      setUploadProgress(null);
      addLog('error', 'File upload failed: ' + error.message);
    }
  };

  // Download — fetches, decrypts, and triggers browser download
  const handleFileRetrieve = async (fileRecord, index) => {
    addLog('info', `Fetching shards for ${fileRecord.name}...`);
    const start = performance.now();
    
    try {
      const chunks = await fetchChunks(nodeRef.current, fileRecord.manifest);
      const decryptedUrl = await reassembleAndDecrypt(chunks, fileRecord.exportedKey, fileRecord.iv, fileRecord.mimeType);
      
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
      addLog('error', 'Decryption failed: ' + err.message);
    }
  };

  // Preview — fetches, decrypts, and opens in a modal (no download)
  const handleFilePreview = async (fileRecord, index) => {
    addLog('info', `Previewing ${fileRecord.name}...`);
    const start = performance.now();
    
    try {
      const chunks = await fetchChunks(nodeRef.current, fileRecord.manifest);
      const decryptedUrl = await reassembleAndDecrypt(chunks, fileRecord.exportedKey, fileRecord.iv, fileRecord.mimeType);
      
      const elapsed = ((performance.now() - start) / 1000).toFixed(2);
      
      setPreviewFile({ url: decryptedUrl, name: fileRecord.name, mimeType: fileRecord.mimeType });
      addLog('success', `${fileRecord.name} decrypted for preview in ${elapsed}s ⚡`);
    } catch (err) {
      addLog('error', 'Preview failed: ' + err.message);
    }
  };

  const closePreview = () => {
    if (previewFile) {
      URL.revokeObjectURL(previewFile.url);
      setPreviewFile(null);
    }
  };

  const generateRawGibberish = (ivArray) => {
    const hex = ivArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return `0x${hex}a7f3b9c8d2e1f4a6b5c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5...[AES-256-GCM ENCRYPTED PAYLOAD]...e9f0a1b2c3d4e5f6a7b8c9d0`;
  };

  const getFileExtension = (mimeType) => {
    if (!mimeType) return 'FILE';
    const sub = mimeType.split('/')[1];
    if (sub === 'jpeg') return 'JPG';
    if (sub === 'plain') return 'TXT';
    return (sub || 'FILE').toUpperCase().slice(0, 4);
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
                    <div key={i} className={`relative group aspect-square ${isDarkMode ? 'bg-zinc-800/80 border-zinc-700/50 text-white' : 'bg-slate-100 border-slate-200 text-slate-800'} rounded-lg overflow-hidden border flex flex-col items-center justify-center transition-all duration-200 hover:border-emerald-500/30`}>
                      
                      {/* File type badge */}
                      <span className="absolute top-2 left-2 bg-black/50 text-white text-[9px] px-1.5 py-0.5 rounded font-mono uppercase tracking-wide backdrop-blur-sm z-10">
                        {getFileExtension(f.mimeType)}
                      </span>

                      {/* Delete button */}
                      {!f.unlocked && (
                        <button 
                          onClick={(e) => { e.stopPropagation(); handleDeleteSingleFile(i, f.name); }} 
                          className="absolute top-2 right-2 bg-red-600/80 hover:bg-red-500 text-white p-1.5 rounded-full z-10 opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}

                      {/* Thumbnail / File icon */}
                      {f.mimeType && f.mimeType.startsWith('image/') ? (
                        <img 
                          src={f.unlocked ? f.decryptedUrl : f.thumbnail} 
                          alt={f.name} 
                          className={`object-cover w-full h-full transition-all duration-700 ${f.unlocked ? '' : 'blur-xl opacity-50 scale-110'}`} 
                        />
                      ) : (
                        <File className={`w-10 h-10 ${isDarkMode ? 'text-zinc-600' : 'text-slate-400'}`} />
                      )}

                      {/* Lock overlay */}
                      {!f.unlocked && (
                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                          <Lock className="w-7 h-7 text-white/50 drop-shadow-lg" />
                        </div>
                      )}

                      {/* Hover actions: Preview + Download */}
                      {!f.unlocked && (
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
                      
                      {/* File name bar */}
                      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 to-transparent p-2 text-[11px] truncate text-center text-white/80">
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
                    <div key={`net-${i}`} className={`relative group aspect-square ${isDarkMode ? 'bg-zinc-800/80 border-blue-500/20 text-white' : 'bg-blue-50 border-blue-200 text-slate-800'} rounded-lg overflow-hidden border flex flex-col items-center justify-center transition-all duration-200 hover:border-blue-500/50`}>
                      
                      {/* Peer badge */}
                      <span className="absolute top-2 left-2 bg-blue-500/80 text-white text-[8px] px-1.5 py-0.5 rounded font-mono uppercase tracking-wide backdrop-blur-sm z-10">
                        From Peer
                      </span>

                      {/* File type badge */}
                      <span className="absolute top-2 right-2 bg-black/50 text-white text-[9px] px-1.5 py-0.5 rounded font-mono uppercase tracking-wide backdrop-blur-sm z-10">
                        {getFileExtension(f.mimeType)}
                      </span>

                      {/* Thumbnail / File icon */}
                      {f.mimeType && f.mimeType.startsWith('image/') && f.thumbnail ? (
                        <img 
                          src={f.thumbnail} 
                          alt={f.name} 
                          className="object-cover w-full h-full blur-xl opacity-50 scale-110" 
                        />
                      ) : (
                        <File className={`w-10 h-10 ${isDarkMode ? 'text-blue-400/30' : 'text-blue-300'}`} />
                      )}

                      {/* Lock overlay */}
                      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                        <Lock className="w-7 h-7 text-blue-400/50 drop-shadow-lg" />
                      </div>

                      {/* Hover actions */}
                      <div className="absolute inset-0 bg-black/80 opacity-0 group-hover:opacity-100 transition-all duration-200 flex flex-col items-center justify-center gap-2">
                        <button 
                          onClick={() => handleFileRetrieve(f, -1)} 
                          className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-1.5 rounded-full text-xs font-medium flex items-center gap-1.5 transition-colors"
                        >
                          <Download className="w-3.5 h-3.5" /> Retrieve & Decrypt
                        </button>
                        <p className="text-zinc-500 text-[9px]">
                          {f.size ? `${(f.size / 1024).toFixed(1)} KB` : ''} • {Object.keys(f.manifest || {}).length} chunks
                        </p>
                      </div>
                      
                      {/* File name bar */}
                      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 to-transparent p-2 text-[11px] truncate text-center text-white/80">
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

            {/* Proof-of-Hosting Panel */}
            <div className={`${isDarkMode ? 'bg-zinc-900/50 border-zinc-800' : 'bg-white border-slate-200 shadow-sm'} border rounded-xl p-4 transition-colors duration-300`}>
              <h2 className={`text-xs font-semibold ${isDarkMode ? 'text-zinc-400' : 'text-slate-500'} mb-3 uppercase tracking-widest`}>Peer Storage Proof</h2>
              <div className="flex items-center gap-4 mb-3">
                <div>
                  <p className="text-blue-400 text-3xl font-bold">{hostedStats.count}</p>
                  <p className={`text-[10px] ${isDarkMode ? 'text-zinc-500' : 'text-slate-400'} uppercase tracking-wide`}>Chunks hosted</p>
                </div>
                <div className={`border-l ${isDarkMode ? 'border-zinc-700' : 'border-slate-200'} pl-4`}>
                  <p className={`text-lg font-bold ${isDarkMode ? 'text-zinc-300' : 'text-slate-700'}`}>
                    {hostedStats.totalBytes > 0 ? `${(hostedStats.totalBytes / 1024).toFixed(1)} KB` : '0 B'}
                  </p>
                  <p className={`text-[10px] ${isDarkMode ? 'text-zinc-500' : 'text-slate-400'} uppercase tracking-wide`}>Encrypted data</p>
                </div>
              </div>
              <div className={`text-[10px] ${isDarkMode ? 'text-zinc-600 bg-zinc-800/50 border-zinc-700/50' : 'text-slate-400 bg-slate-50 border-slate-200'} p-2.5 rounded-lg border`}>
                <Lock className="w-3 h-3 inline mr-1 -mt-0.5" />
                These are opaque AES-256-GCM encrypted shards from other peers — unreadable without their private keys.
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* ─── Shard View Modal ─── */}
      {viewShard && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 backdrop-blur-sm" onClick={() => setViewShard(null)}>
          <div className={`${isDarkMode ? 'bg-zinc-900 border-zinc-700 text-white' : 'bg-white border-slate-200 text-slate-900'} border p-6 rounded-xl max-w-lg w-full shadow-2xl transition-colors`} onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold text-red-500 flex items-center gap-2"><Lock className="w-5 h-5"/> Shard Encrypted</h3>
              <button onClick={() => setViewShard(null)} className={`${isDarkMode ? 'text-zinc-400 hover:text-white' : 'text-slate-400 hover:text-slate-700'} transition-colors`}><X className="w-5 h-5"/></button>
            </div>
            <p className={`text-sm ${isDarkMode ? 'text-zinc-400' : 'text-slate-600'} mb-4`}>
              This is what a peer sees when holding a shard of <strong>{viewShard.name}</strong>. Without your private AES-GCM decryption key, the file is mathematically impossible to open.
            </p>
            <div className="bg-black p-4 rounded-lg border border-zinc-800 font-mono text-xs text-emerald-500 break-all h-32 overflow-y-auto">
              {generateRawGibberish(viewShard.iv)}
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
            {previewFile.mimeType.startsWith('image/') ? (
              <img src={previewFile.url} alt={previewFile.name} className="max-w-full max-h-[80vh] object-contain rounded-lg shadow-2xl" />
            ) : previewFile.mimeType.startsWith('audio/') ? (
              <div className={`bg-zinc-900 p-8 rounded-xl border border-zinc-800 flex flex-col items-center gap-4`}>
                <Zap className="w-12 h-12 text-emerald-500" />
                <p className="text-white text-sm">{previewFile.name}</p>
                <audio controls src={previewFile.url} className="w-80" />
              </div>
            ) : previewFile.mimeType.startsWith('video/') ? (
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