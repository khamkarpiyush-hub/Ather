import React, { useState, useEffect, useRef } from 'react';
import { encryptAndShard, reassembleAndDecrypt } from './utils/crypto';
import { initP2PNode, distributeChunks, fetchChunks } from './utils/p2p';
import { Shield, File, Lock, Unlock, Trash2, Eye, X, LogOut, Sun, Moon } from 'lucide-react'; 

// Firebase & Firestore Imports
import { auth, provider, db } from './firebase';
import { signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc, setDoc } from 'firebase/firestore';

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
  const nodeRef = useRef(null); 

  const [vaultFiles, setVaultFiles] = useState([]);
  const [isDataLoading, setIsDataLoading] = useState(false);

  const isLocalMode = activePeers.size === 0;

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
        const node = await initP2PNode(
          (newPeer) => setActivePeers(prev => new Set(prev).add(newPeer.toString())),
          (lostPeer) => setActivePeers(prev => {
             const updated = new Set(prev);
             updated.delete(lostPeer.toString());
             return updated;
          })
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
    setStatusLog(prev => [...prev, { type, message }]);
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
    
    addLog('info', `Encrypting ${file.name}...`);
    
    try {
      const { chunks, exportedKey, iv, mimeType, thumbnail } = await encryptAndShard(file);
      const peerIdsArray = activePeers.size > 0 ? Array.from(activePeers) : ['local-network-mock'];
      
      addLog('info', 'Distributing chunks to swarm...');
      const manifest = await distributeChunks(nodeRef.current, chunks, peerIdsArray);

      const updatedFiles = [...vaultFiles, {
        name: file.name,
        manifest,
        exportedKey,
        iv,
        mimeType,
        thumbnail, 
        unlocked: false 
      }];

      await saveVaultToCloud(updatedFiles);

      if (event.target) event.target.value = ''; 
      addLog('success', `${file.name} secured in SwarmVault!`);
    } catch (error) {
      addLog('error', 'File upload failed: ' + error.message);
    }
  };

  const handleFileRetrieve = async (fileRecord, index) => {
    addLog('info', `Fetching shards for ${fileRecord.name}...`);
    try {
      const chunks = await fetchChunks(nodeRef.current, fileRecord.manifest);
      const decryptedUrl = await reassembleAndDecrypt(chunks, fileRecord.exportedKey, fileRecord.iv, fileRecord.mimeType);
      
      setVaultFiles(prev => {
        const newFiles = [...prev];
        newFiles[index].unlocked = true;
        newFiles[index].decryptedUrl = decryptedUrl;
        return newFiles;
      });

      const link = document.createElement('a');
      link.href = decryptedUrl;
      link.download = `unlocked_${fileRecord.name}`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      addLog('success', `${fileRecord.name} decrypted successfully!`);

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

    } catch (err) {
      addLog('error', 'Decryption failed: ' + err.message);
    }
  };

  const generateRawGibberish = (ivArray) => {
    const hex = ivArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return `0x${hex}a7f3b9c8d2e1f4a6b5c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5...[AES-256-GCM ENCRYPTED PAYLOAD]...e9f0a1b2c3d4e5f6a7b8c9d0`;
  };

  // --- RENDER LOGIN SCREEN IF NOT AUTHENTICATED ---
  if (isAuthLoading || isDataLoading) {
    return (
      <div className={`${isDarkMode ? 'bg-[#121212] text-emerald-500' : 'bg-slate-100 text-emerald-600'} h-screen w-full flex items-center justify-center font-medium`}>
        Loading SwarmVault Cloud...
      </div>
    );
  }

  if (!user) {
    return (
      <div className={`${isDarkMode ? 'bg-[#121212] text-white' : 'bg-slate-50 text-slate-900'} h-screen w-full flex flex-col items-center justify-center font-sans transition-colors duration-300`}>
        <div className="absolute top-6 right-6">
          <button 
            onClick={() => setIsDarkMode(!isDarkMode)} 
            className={`p-2.5 rounded-full ${isDarkMode ? 'bg-zinc-800 text-amber-400 hover:bg-zinc-700' : 'bg-white text-slate-700 shadow-md hover:bg-slate-100'} transition-colors`}
            title="Toggle Theme"
          >
            {isDarkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
          </button>
        </div>
        <div className={`${isDarkMode ? 'bg-zinc-900 border-zinc-800 text-white' : 'bg-white border-slate-200 text-slate-900 shadow-xl'} border p-10 rounded-2xl flex flex-col items-center max-w-md w-full text-center transition-colors duration-300`}>
          <Shield className="text-emerald-500 w-16 h-16 mb-6" />
          <h1 className="text-3xl font-bold tracking-wider mb-2">SwarmVault</h1>
          <p className={`${isDarkMode ? 'text-zinc-400' : 'text-slate-500'} mb-8`}>Decentralized, mathematically secure file storage.</p>
          <button 
            onClick={handleLogin}
            className={`w-full ${isDarkMode ? 'bg-white hover:bg-zinc-200 text-black' : 'bg-slate-900 hover:bg-slate-800 text-white'} font-semibold py-3 px-4 rounded-xl flex items-center justify-center gap-3 transition-colors`}
          >
            <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google" className="w-5 h-5" />
            Continue with Google
          </button>
        </div>
      </div>
    );
  }

  // --- RENDER VAULT IF AUTHENTICATED ---
  return (
    <div className={`${isDarkMode ? 'bg-[#121212] text-white' : 'bg-slate-50 text-slate-900'} min-h-screen flex flex-col font-sans relative transition-colors duration-300`}>
      <header className={`flex justify-between items-center p-6 border-b ${isDarkMode ? 'border-zinc-800' : 'border-slate-200'} transition-colors duration-300`}>
        <div className="flex items-center gap-2">
          <Shield className="text-emerald-500" />
          <h1 className="text-2xl font-bold tracking-wider">SwarmVault</h1>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <div className={`hidden md:flex items-center gap-2 ${isDarkMode ? 'bg-zinc-800 text-zinc-200' : 'bg-slate-200 text-slate-700'} px-3 py-1 rounded-full`}>
            <span className={`w-2 h-2 rounded-full ${isLocalMode ? 'bg-amber-500' : 'bg-emerald-500'}`}></span>
            <p>{activePeers.size} Peers</p>
          </div>
          
          <button onClick={handleEmptyVault} className="hidden md:flex items-center gap-2 bg-red-600/20 hover:bg-red-600/40 text-red-500 px-3 py-1 rounded-full transition-colors">
            <Trash2 className="w-4 h-4" /> Empty Vault
          </button>

          <button 
            onClick={() => setIsDarkMode(!isDarkMode)} 
            className={`p-2 rounded-full ${isDarkMode ? 'bg-zinc-800 text-amber-400 hover:bg-zinc-700' : 'bg-slate-200 text-slate-700 hover:bg-slate-300'} transition-colors`}
            title="Toggle Theme"
          >
            {isDarkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>

          <div className={`flex items-center gap-3 pl-4 border-l ${isDarkMode ? 'border-zinc-700' : 'border-slate-300'}`}>
            {user.photoURL && !imgError ? (
              <img 
                src={user.photoURL} 
                alt="Profile" 
                onError={() => setImgError(true)} 
                className="w-8 h-8 rounded-full object-cover border border-emerald-500" 
              />
            ) : (
              <div className="w-8 h-8 rounded-full bg-emerald-600 flex items-center justify-center text-white font-bold text-xs">
                {user.displayName ? user.displayName[0].toUpperCase() : 'U'}
              </div>
            )}
            <button onClick={handleLogout} className={`${isDarkMode ? 'text-zinc-400 hover:text-white' : 'text-slate-500 hover:text-slate-900'} transition-colors`} title="Sign Out">
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      <main className="flex flex-col flex-1 p-8 max-w-5xl mx-auto w-full gap-8">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          <div className="md:col-span-2 flex flex-col gap-4">
            <div 
              className={`border-2 border-dashed ${isDarkMode ? 'border-zinc-700 hover:border-emerald-500 bg-zinc-900/50' : 'border-slate-300 hover:border-emerald-500 bg-white shadow-sm'} transition-colors rounded-xl p-12 flex flex-col items-center justify-center text-center cursor-pointer`}
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleFileDrop}
              onClick={() => document.getElementById('fileInput').click()}
            >
              <input id="fileInput" type="file" className="hidden" onChange={handleFileDrop} />
              <div className={`${isDarkMode ? 'bg-zinc-800' : 'bg-slate-100'} p-4 rounded-full mb-4`}>
                 <File className="text-emerald-500 w-8 h-8" />
              </div>
              <h3 className={`text-lg font-medium mb-1 ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>Upload to the Swarm</h3>
              <p className={`text-sm ${isDarkMode ? 'text-zinc-400' : 'text-slate-500'}`}>Drag & drop a file, or click to browse</p>
            </div>

            <div className={`${isDarkMode ? 'bg-zinc-900 border-zinc-800' : 'bg-white border-slate-200 shadow-sm'} rounded-xl border p-6 flex-1 transition-colors duration-300`}>
              <h2 className={`text-lg font-medium mb-4 ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>Your Encrypted Vault</h2>
              {vaultFiles.length === 0 ? (
                <p className={`${isDarkMode ? 'text-zinc-500' : 'text-slate-400'} text-sm`}>No files in the vault yet.</p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                  {vaultFiles.map((f, i) => (
                    <div key={i} className={`relative group aspect-square ${isDarkMode ? 'bg-zinc-800 border-zinc-700 text-white' : 'bg-slate-100 border-slate-200 text-slate-800'} rounded-lg overflow-hidden border flex flex-col items-center justify-center`}>
                      
                      {!f.unlocked && (
                        <button 
                          onClick={(e) => { e.stopPropagation(); handleDeleteSingleFile(i, f.name); }} 
                          className="absolute top-2 right-2 bg-red-600/80 hover:bg-red-500 text-white p-1.5 rounded-full z-10 opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}

                      {f.mimeType && f.mimeType.startsWith('image/') ? (
                        <img 
                          src={f.unlocked ? f.decryptedUrl : f.thumbnail} 
                          alt={f.name} 
                          className={`object-cover w-full h-full transition-all duration-700 ${f.unlocked ? '' : 'blur-xl opacity-60 scale-110'}`} 
                        />
                      ) : (
                        <File className="w-12 h-12 text-zinc-500" />
                      )}

                      {!f.unlocked && (
                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                          <Lock className="w-8 h-8 text-white/70 drop-shadow-lg" />
                        </div>
                      )}

                      {!f.unlocked && (
                        <div className="absolute inset-0 bg-black/80 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-3">
                          <button onClick={() => handleFileRetrieve(f, i)} className="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded-full text-sm font-medium flex items-center gap-2">
                            <Unlock className="w-4 h-4" /> Retrieve
                          </button>
                          <button onClick={() => setViewShard(f)} className="bg-zinc-700 hover:bg-zinc-600 text-white px-4 py-2 rounded-full text-xs font-medium flex items-center gap-2">
                            <Eye className="w-3 h-3" /> Peer View
                          </button>
                        </div>
                      )}
                      
                      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 to-transparent p-2 text-xs truncate text-center text-white">
                        {f.name}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className={`${isDarkMode ? 'bg-zinc-900 border-zinc-800 text-white' : 'bg-white border-slate-200 text-slate-900 shadow-sm'} border rounded-xl p-4 flex flex-col h-[500px] transition-colors duration-300`}>
            <h2 className={`text-sm font-medium ${isDarkMode ? 'text-zinc-400' : 'text-slate-500'} mb-4 uppercase tracking-wider`}>Network Log</h2>
            <div className="flex flex-col gap-2 overflow-y-auto flex-1">
              {statusLog.map((log, index) => (
                <div key={index} className={`text-xs p-2 rounded border-l-2 ${
                  log.type === 'error' ? 'border-red-500 bg-red-500/10 text-red-300' :
                  log.type === 'success' ? 'border-emerald-500 bg-emerald-500/10 text-emerald-300' :
                  'border-blue-500 bg-blue-500/10 text-blue-300'
                }`}>
                  {log.message}
                </div>
              ))}
            </div>
          </div>
        </div>
      </main>

      {viewShard && (
        <div className="absolute inset-0 bg-black/80 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
          <div className={`${isDarkMode ? 'bg-zinc-900 border-zinc-700 text-white' : 'bg-white border-slate-200 text-slate-900'} border p-6 rounded-xl max-w-lg w-full shadow-2xl transition-colors`}>
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold text-red-500 flex items-center gap-2"><Lock className="w-5 h-5"/> Shard Encrypted</h3>
              <button onClick={() => setViewShard(null)} className={`${isDarkMode ? 'text-zinc-400 hover:text-white' : 'text-slate-400 hover:text-slate-700'}`}><X className="w-5 h-5"/></button>
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
    </div>
  );
};

export default App;




// data base inclusion firestore
// import React, { useState, useEffect, useRef } from 'react';
// import { encryptAndShard, reassembleAndDecrypt } from './utils/crypto';
// import { initP2PNode, registerSilentStorageReceiver, distributeChunks, fetchChunks } from './utils/p2p';
// import { Shield, File, Lock, Unlock, Trash2, Eye, X, LogOut, Sun, Moon } from 'lucide-react'; 
// import { db } from './firebase';
// import { doc, getDoc, setDoc } from 'firebase/firestore';

// // Firebase Imports
// import { auth, provider } from './firebase';
// import { signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';

// const App = () => {
//   // Authentication State
//   const [user, setUser] = useState(null);
//   const [isAuthLoading, setIsAuthLoading] = useState(true);
//   const [imgError, setImgError] = useState(false);

//   // Theme State (Dark / Light Mode)
//   const [isDarkMode, setIsDarkMode] = useState(() => {
//     const saved = localStorage.getItem('swarmvault_theme');
//     return saved !== null ? JSON.parse(saved) : true;
//   });

//   useEffect(() => {
//     localStorage.setItem('swarmvault_theme', JSON.stringify(isDarkMode));
//   }, [isDarkMode]);

//   // Vault & Network State
//   const [peerId, setPeerId] = useState('Connecting to Swarm...');
//   const [activePeers, setActivePeers] = useState(new Set());
//   const [statusLog, setStatusLog] = useState([]);
//   const [viewShard, setViewShard] = useState(null); 
//   const nodeRef = useRef(null); 

//   const [vaultFiles, setVaultFiles] = useState(() => {
//     const saved = localStorage.getItem('swarmvault_files');
//     return saved ? JSON.parse(saved) : [];
//   });

//   const isLocalMode = activePeers.size === 0;

//   // Listen for Google Login/Logout
//   useEffect(() => {
//     const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
//       setUser(currentUser);
//       setIsAuthLoading(false);
//     });
//     return () => unsubscribe();
//   }, []);

//   // Save files to local storage automatically
//   useEffect(() => {
//     localStorage.setItem('swarmvault_files', JSON.stringify(vaultFiles));
//   }, [vaultFiles]);

//   // Boot P2P Node (Only if user is logged in)
//   useEffect(() => {
//     if (!user) return;
    
//     const startupP2P = async () => {
//       try {
//         const node = await initP2PNode(
//           (newPeer) => setActivePeers(prev => new Set(prev).add(newPeer.toString())),
//           (lostPeer) => setActivePeers(prev => {
//              const updated = new Set(prev);
//              updated.delete(lostPeer.toString());
//              return updated;
//           })
//         );
//         nodeRef.current = node;
//         setPeerId(node.peerId.toString());
//         addLog('success', 'Connected to the P2P Swarm');
//       } catch (err) {
//         addLog('error', 'Failed to start P2P node: ' + err.message);
//       }
//     };
//     startupP2P();
//   }, [user]);

//   const addLog = (type, message) => {
//     setStatusLog(prev => [...prev, { type, message }]);
//   };

//   // Auth Functions
//   const handleLogin = async () => {
//     try {
//       await signInWithPopup(auth, provider);
//     } catch (error) {
//       console.error("Login Failed", error);
//     }
//   };

//   const handleLogout = async () => {
//     await signOut(auth);
//     setVaultFiles([]); 
//     localStorage.removeItem('swarmvault_files');
//   };

//   // Vault Functions
//   const handleEmptyVault = () => {
//     if(window.confirm("Are you sure you want to permanently delete all files in your vault? This cannot be undone.")) {
//       setVaultFiles([]);
//       localStorage.removeItem('swarmvault_files');
//       indexedDB.deleteDatabase('SwarmVaultDB'); 
//       addLog('error', 'Vault completely wiped and destroyed.');
//     }
//   };

//   const handleDeleteSingleFile = (indexToRemove, fileName) => {
//     if(window.confirm(`Are you sure you want to delete ${fileName}?`)) {
//       setVaultFiles(prev => prev.filter((_, i) => i !== indexToRemove));
//       addLog('success', `${fileName} deleted from the vault.`);
//     }
//   };

//   const handleFileDrop = async (event) => {
//     event.preventDefault(); 
//     const file = event.dataTransfer ? event.dataTransfer.files[0] : event.target.files[0];
//     if (!file || !nodeRef.current) return;
    
//     addLog('info', `Encrypting ${file.name}...`);
    
//     try {
//       const { chunks, exportedKey, iv, mimeType, thumbnail } = await encryptAndShard(file);
//       const peerIdsArray = activePeers.size > 0 ? Array.from(activePeers) : ['local-network-mock'];
      
//       addLog('info', 'Distributing chunks to swarm...');
//       const manifest = await distributeChunks(nodeRef.current, chunks, peerIdsArray);

//       setVaultFiles(prev => [...prev, {
//         name: file.name,
//         manifest,
//         exportedKey,
//         iv,
//         mimeType,
//         thumbnail, 
//         unlocked: false 
//       }]);

//       if (event.target) event.target.value = ''; 
//       addLog('success', `${file.name} secured in SwarmVault!`);
//     } catch (error) {
//       addLog('error', 'File upload failed: ' + error.message);
//     }
//   };

//   const handleFileRetrieve = async (fileRecord, index) => {
//     addLog('info', `Fetching shards for ${fileRecord.name}...`);
//     try {
//       const chunks = await fetchChunks(nodeRef.current, fileRecord.manifest);
//       const decryptedUrl = await reassembleAndDecrypt(chunks, fileRecord.exportedKey, fileRecord.iv, fileRecord.mimeType);
      
//       setVaultFiles(prev => {
//         const newFiles = [...prev];
//         newFiles[index].unlocked = true;
//         newFiles[index].decryptedUrl = decryptedUrl;
//         return newFiles;
//       });

//       const link = document.createElement('a');
//       link.href = decryptedUrl;
//       link.download = `unlocked_${fileRecord.name}`;
//       document.body.appendChild(link);
//       link.click();
//       document.body.removeChild(link);
      
//       addLog('success', `${fileRecord.name} decrypted successfully!`);

//       setTimeout(() => {
//         setVaultFiles(prev => {
//           const newFiles = [...prev];
//           newFiles[index].unlocked = false;
//           URL.revokeObjectURL(newFiles[index].decryptedUrl);
//           return newFiles;
//         });
//       }, 3000);

//     } catch (err) {
//       addLog('error', 'Decryption failed: ' + err.message);
//     }
//   };

//   const generateRawGibberish = (ivArray) => {
//     const hex = ivArray.map(b => b.toString(16).padStart(2, '0')).join('');
//     return `0x${hex}a7f3b9c8d2e1f4a6b5c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5...[AES-256-GCM ENCRYPTED PAYLOAD]...e9f0a1b2c3d4e5f6a7b8c9d0`;
//   };

//   // --- RENDER LOGIN SCREEN IF NOT AUTHENTICATED ---
//   if (isAuthLoading) {
//     return (
//       <div className={`${isDarkMode ? 'bg-[#121212] text-emerald-500' : 'bg-slate-100 text-emerald-600'} h-screen w-full flex items-center justify-center font-medium`}>
//         Loading SwarmVault...
//       </div>
//     );
//   }

//   if (!user) {
//     return (
//       <div className={`${isDarkMode ? 'bg-[#121212] text-white' : 'bg-slate-50 text-slate-900'} h-screen w-full flex flex-col items-center justify-center font-sans transition-colors duration-300`}>
//         <div className="absolute top-6 right-6">
//           <button 
//             onClick={() => setIsDarkMode(!isDarkMode)} 
//             className={`p-2.5 rounded-full ${isDarkMode ? 'bg-zinc-800 text-amber-400 hover:bg-zinc-700' : 'bg-white text-slate-700 shadow-md hover:bg-slate-100'} transition-colors`}
//             title="Toggle Theme"
//           >
//             {isDarkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
//           </button>
//         </div>
//         <div className={`${isDarkMode ? 'bg-zinc-900 border-zinc-800 text-white' : 'bg-white border-slate-200 text-slate-900 shadow-xl'} border p-10 rounded-2xl flex flex-col items-center max-w-md w-full text-center transition-colors duration-300`}>
//           <Shield className="text-emerald-500 w-16 h-16 mb-6" />
//           <h1 className="text-3xl font-bold tracking-wider mb-2">SwarmVault</h1>
//           <p className={`${isDarkMode ? 'text-zinc-400' : 'text-slate-500'} mb-8`}>Decentralized, mathematically secure file storage.</p>
//           <button 
//             onClick={handleLogin}
//             className={`w-full ${isDarkMode ? 'bg-white hover:bg-zinc-200 text-black' : 'bg-slate-900 hover:bg-slate-800 text-white'} font-semibold py-3 px-4 rounded-xl flex items-center justify-center gap-3 transition-colors`}
//           >
//             <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google" className="w-5 h-5" />
//             Continue with Google
//           </button>
//         </div>
//       </div>
//     );
//   }

//   // --- RENDER VAULT IF AUTHENTICATED ---
//   return (
//     <div className={`${isDarkMode ? 'bg-[#121212] text-white' : 'bg-slate-50 text-slate-900'} min-h-screen flex flex-col font-sans relative transition-colors duration-300`}>
//       <header className={`flex justify-between items-center p-6 border-b ${isDarkMode ? 'border-zinc-800' : 'border-slate-200'} transition-colors duration-300`}>
//         <div className="flex items-center gap-2">
//           <Shield className="text-emerald-500" />
//           <h1 className="text-2xl font-bold tracking-wider">SwarmVault</h1>
//         </div>
//         <div className="flex items-center gap-4 text-sm">
//           <div className={`hidden md:flex items-center gap-2 ${isDarkMode ? 'bg-zinc-800 text-zinc-200' : 'bg-slate-200 text-slate-700'} px-3 py-1 rounded-full`}>
//             <span className={`w-2 h-2 rounded-full ${isLocalMode ? 'bg-amber-500' : 'bg-emerald-500'}`}></span>
//             <p>{activePeers.size} Peers</p>
//           </div>
          
//           <button onClick={handleEmptyVault} className="hidden md:flex items-center gap-2 bg-red-600/20 hover:bg-red-600/40 text-red-500 px-3 py-1 rounded-full transition-colors">
//             <Trash2 className="w-4 h-4" /> Empty Vault
//           </button>

//           <button 
//             onClick={() => setIsDarkMode(!isDarkMode)} 
//             className={`p-2 rounded-full ${isDarkMode ? 'bg-zinc-800 text-amber-400 hover:bg-zinc-700' : 'bg-slate-200 text-slate-700 hover:bg-slate-300'} transition-colors`}
//             title="Toggle Theme"
//           >
//             {isDarkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
//           </button>

//           <div className={`flex items-center gap-3 pl-4 border-l ${isDarkMode ? 'border-zinc-700' : 'border-slate-300'}`}>
//             {user.photoURL && !imgError ? (
//               <img 
//                 src={user.photoURL} 
//                 alt="Profile" 
//                 onError={() => setImgError(true)} 
//                 className="w-8 h-8 rounded-full object-cover border border-emerald-500" 
//               />
//             ) : (
//               <div className="w-8 h-8 rounded-full bg-emerald-600 flex items-center justify-center text-white font-bold text-xs">
//                 {user.displayName ? user.displayName[0].toUpperCase() : 'U'}
//               </div>
//             )}
//             <button onClick={handleLogout} className={`${isDarkMode ? 'text-zinc-400 hover:text-white' : 'text-slate-500 hover:text-slate-900'} transition-colors`} title="Sign Out">
//               <LogOut className="w-5 h-5" />
//             </button>
//           </div>
//         </div>
//       </header>

//       <main className="flex flex-col flex-1 p-8 max-w-5xl mx-auto w-full gap-8">
//         <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
//           <div className="md:col-span-2 flex flex-col gap-4">
//             <div 
//               className={`border-2 border-dashed ${isDarkMode ? 'border-zinc-700 hover:border-emerald-500 bg-zinc-900/50' : 'border-slate-300 hover:border-emerald-500 bg-white shadow-sm'} transition-colors rounded-xl p-12 flex flex-col items-center justify-center text-center cursor-pointer`}
//               onDragOver={(e) => e.preventDefault()}
//               onDrop={handleFileDrop}
//               onClick={() => document.getElementById('fileInput').click()}
//             >
//               <input id="fileInput" type="file" className="hidden" onChange={handleFileDrop} />
//               <div className={`${isDarkMode ? 'bg-zinc-800' : 'bg-slate-100'} p-4 rounded-full mb-4`}>
//                  <File className="text-emerald-500 w-8 h-8" />
//               </div>
//               <h3 className={`text-lg font-medium mb-1 ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>Upload to the Swarm</h3>
//               <p className={`text-sm ${isDarkMode ? 'text-zinc-400' : 'text-slate-500'}`}>Drag & drop a file, or click to browse</p>
//             </div>

//             <div className={`${isDarkMode ? 'bg-zinc-900 border-zinc-800' : 'bg-white border-slate-200 shadow-sm'} rounded-xl border p-6 flex-1 transition-colors duration-300`}>
//               <h2 className={`text-lg font-medium mb-4 ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>Your Encrypted Vault</h2>
//               {vaultFiles.length === 0 ? (
//                 <p className={`${isDarkMode ? 'text-zinc-500' : 'text-slate-400'} text-sm`}>No files in the vault yet.</p>
//               ) : (
//                 <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
//                   {vaultFiles.map((f, i) => (
//                     <div key={i} className={`relative group aspect-square ${isDarkMode ? 'bg-zinc-800 border-zinc-700 text-white' : 'bg-slate-100 border-slate-200 text-slate-800'} rounded-lg overflow-hidden border flex flex-col items-center justify-center`}>
                      
//                       {!f.unlocked && (
//                         <button 
//                           onClick={(e) => { e.stopPropagation(); handleDeleteSingleFile(i, f.name); }} 
//                           className="absolute top-2 right-2 bg-red-600/80 hover:bg-red-500 text-white p-1.5 rounded-full z-10 opacity-0 group-hover:opacity-100 transition-opacity"
//                         >
//                           <Trash2 className="w-3 h-3" />
//                         </button>
//                       )}

//                       {f.mimeType && f.mimeType.startsWith('image/') ? (
//                         <img 
//                           src={f.unlocked ? f.decryptedUrl : f.thumbnail} 
//                           alt={f.name} 
//                           className={`object-cover w-full h-full transition-all duration-700 ${f.unlocked ? '' : 'blur-xl opacity-60 scale-110'}`} 
//                         />
//                       ) : (
//                         <File className="w-12 h-12 text-zinc-500" />
//                       )}

//                       {!f.unlocked && (
//                         <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
//                           <Lock className="w-8 h-8 text-white/70 drop-shadow-lg" />
//                         </div>
//                       )}

//                       {!f.unlocked && (
//                         <div className="absolute inset-0 bg-black/80 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-3">
//                           <button onClick={() => handleFileRetrieve(f, i)} className="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded-full text-sm font-medium flex items-center gap-2">
//                             <Unlock className="w-4 h-4" /> Retrieve
//                           </button>
//                           <button onClick={() => setViewShard(f)} className="bg-zinc-700 hover:bg-zinc-600 text-white px-4 py-2 rounded-full text-xs font-medium flex items-center gap-2">
//                             <Eye className="w-3 h-3" /> Peer View
//                           </button>
//                         </div>
//                       )}
                      
//                       <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 to-transparent p-2 text-xs truncate text-center text-white">
//                         {f.name}
//                       </div>
//                     </div>
//                   ))}
//                 </div>
//               )}
//             </div>
//           </div>

//           <div className={`${isDarkMode ? 'bg-zinc-900 border-zinc-800 text-white' : 'bg-white border-slate-200 text-slate-900 shadow-sm'} border rounded-xl p-4 flex flex-col h-[500px] transition-colors duration-300`}>
//             <h2 className={`text-sm font-medium ${isDarkMode ? 'text-zinc-400' : 'text-slate-500'} mb-4 uppercase tracking-wider`}>Network Log</h2>
//             <div className="flex flex-col gap-2 overflow-y-auto flex-1">
//               {statusLog.map((log, index) => (
//                 <div key={index} className={`text-xs p-2 rounded border-l-2 ${
//                   log.type === 'error' ? 'border-red-500 bg-red-500/10 text-red-300' :
//                   log.type === 'success' ? 'border-emerald-500 bg-emerald-500/10 text-emerald-300' :
//                   'border-blue-500 bg-blue-500/10 text-blue-300'
//                 }`}>
//                   {log.message}
//                 </div>
//               ))}
//             </div>
//           </div>
//         </div>
//       </main>

//       {viewShard && (
//         <div className="absolute inset-0 bg-black/80 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
//           <div className={`${isDarkMode ? 'bg-zinc-900 border-zinc-700 text-white' : 'bg-white border-slate-200 text-slate-900'} border p-6 rounded-xl max-w-lg w-full shadow-2xl transition-colors`}>
//             <div className="flex justify-between items-center mb-4">
//               <h3 className="text-lg font-bold text-red-500 flex items-center gap-2"><Lock className="w-5 h-5"/> Shard Encrypted</h3>
//               <button onClick={() => setViewShard(null)} className={`${isDarkMode ? 'text-zinc-400 hover:text-white' : 'text-slate-400 hover:text-slate-700'}`}><X className="w-5 h-5"/></button>
//             </div>
//             <p className={`text-sm ${isDarkMode ? 'text-zinc-400' : 'text-slate-600'} mb-4`}>
//               This is what a peer sees when holding a shard of <strong>{viewShard.name}</strong>. Without your private AES-GCM decryption key, the file is mathematically impossible to open.
//             </p>
//             <div className="bg-black p-4 rounded-lg border border-zinc-800 font-mono text-xs text-emerald-500 break-all h-32 overflow-y-auto">
//               {generateRawGibberish(viewShard.iv)}
//             </div>
//           </div>
//         </div>
//       )}
//     </div>
//   );
// };

// export default App;


//  elements related to signin are added
// import React, { useState, useEffect, useRef } from 'react';
// import { encryptAndShard, reassembleAndDecrypt } from './utils/crypto';
// import { initP2PNode, registerSilentStorageReceiver, distributeChunks, fetchChunks } from './utils/p2p';
// import { Shield, File, Lock, Unlock, Trash2, Eye, X, LogIn, LogOut } from 'lucide-react'; 

// // NEW: Firebase Imports
// import { auth, provider } from './firebase';
// import { signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';

// const App = () => {
//   // Authentication State
//   const [user, setUser] = useState(null);
//   const [isAuthLoading, setIsAuthLoading] = useState(true);

//   // Vault & Network State
//   const [peerId, setPeerId] = useState('Connecting to Swarm...');
//   const [activePeers, setActivePeers] = useState(new Set());
//   const [statusLog, setStatusLog] = useState([]);
//   const [viewShard, setViewShard] = useState(null); 
//   const nodeRef = useRef(null); 

//   const [vaultFiles, setVaultFiles] = useState(() => {
//     const saved = localStorage.getItem('swarmvault_files');
//     return saved ? JSON.parse(saved) : [];
//   });

//   const isLocalMode = activePeers.size === 0;

//   // Listen for Google Login/Logout
//   useEffect(() => {
//     const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
//       setUser(currentUser);
//       setIsAuthLoading(false);
//     });
//     return () => unsubscribe();
//   }, []);

//   // Save files to local storage automatically
//   useEffect(() => {
//     localStorage.setItem('swarmvault_files', JSON.stringify(vaultFiles));
//   }, [vaultFiles]);

//   // Boot P2P Node (Only if user is logged in)
//   useEffect(() => {
//     if (!user) return;
    
//     const startupP2P = async () => {
//       try {
//         const node = await initP2PNode(
//           (newPeer) => setActivePeers(prev => new Set(prev).add(newPeer.toString())),
//           (lostPeer) => setActivePeers(prev => {
//              const updated = new Set(prev);
//              updated.delete(lostPeer.toString());
//              return updated;
//           })
//         );
//         nodeRef.current = node;
//         setPeerId(node.peerId.toString());
//         addLog('success', 'Connected to the P2P Swarm');
//       } catch (err) {
//         addLog('error', 'Failed to start P2P node: ' + err.message);
//       }
//     };
//     startupP2P();
//   }, [user]);

//   const addLog = (type, message) => {
//     setStatusLog(prev => [...prev, { type, message }]);
//   };

//   // Auth Functions
//   const handleLogin = async () => {
//     try {
//       await signInWithPopup(auth, provider);
//     } catch (error) {
//       console.error("Login Failed", error);
//     }
//   };

//   const handleLogout = async () => {
//     await signOut(auth);
//     setVaultFiles([]); // Clear local UI on logout for security
//     localStorage.removeItem('swarmvault_files');
//   };

//   // Vault Functions
//   const handleEmptyVault = () => {
//     if(window.confirm("Are you sure you want to permanently delete all files in your vault? This cannot be undone.")) {
//       setVaultFiles([]);
//       localStorage.removeItem('swarmvault_files');
//       indexedDB.deleteDatabase('SwarmVaultDB'); 
//       addLog('error', 'Vault completely wiped and destroyed.');
//     }
//   };

//   const handleDeleteSingleFile = (indexToRemove, fileName) => {
//     if(window.confirm(`Are you sure you want to delete ${fileName}?`)) {
//       setVaultFiles(prev => prev.filter((_, i) => i !== indexToRemove));
//       addLog('success', `${fileName} deleted from the vault.`);
//     }
//   };

//   const handleFileDrop = async (event) => {
//     event.preventDefault(); 
//     const file = event.dataTransfer ? event.dataTransfer.files[0] : event.target.files[0];
//     if (!file || !nodeRef.current) return;
    
//     addLog('info', `Encrypting ${file.name}...`);
    
//     try {
//       const { chunks, exportedKey, iv, mimeType, thumbnail } = await encryptAndShard(file);
//       const peerIdsArray = activePeers.size > 0 ? Array.from(activePeers) : ['local-network-mock'];
      
//       addLog('info', 'Distributing chunks to swarm...');
//       const manifest = await distributeChunks(nodeRef.current, chunks, peerIdsArray);

//       setVaultFiles(prev => [...prev, {
//         name: file.name,
//         manifest,
//         exportedKey,
//         iv,
//         mimeType,
//         thumbnail, 
//         unlocked: false 
//       }]);

//       if (event.target) event.target.value = ''; 
//       addLog('success', `${file.name} secured in SwarmVault!`);
//     } catch (error) {
//       addLog('error', 'File upload failed: ' + error.message);
//     }
//   };

//   const handleFileRetrieve = async (fileRecord, index) => {
//     addLog('info', `Fetching shards for ${fileRecord.name}...`);
//     try {
//       const chunks = await fetchChunks(nodeRef.current, fileRecord.manifest);
//       const decryptedUrl = await reassembleAndDecrypt(chunks, fileRecord.exportedKey, fileRecord.iv, fileRecord.mimeType);
      
//       setVaultFiles(prev => {
//         const newFiles = [...prev];
//         newFiles[index].unlocked = true;
//         newFiles[index].decryptedUrl = decryptedUrl;
//         return newFiles;
//       });

//       const link = document.createElement('a');
//       link.href = decryptedUrl;
//       link.download = `unlocked_${fileRecord.name}`;
//       document.body.appendChild(link);
//       link.click();
//       document.body.removeChild(link);
      
//       addLog('success', `${fileRecord.name} decrypted successfully!`);

//       setTimeout(() => {
//         setVaultFiles(prev => {
//           const newFiles = [...prev];
//           newFiles[index].unlocked = false;
//           URL.revokeObjectURL(newFiles[index].decryptedUrl);
//           return newFiles;
//         });
//       }, 3000);

//     } catch (err) {
//       addLog('error', 'Decryption failed: ' + err.message);
//     }
//   };

//   const generateRawGibberish = (ivArray) => {
//     const hex = ivArray.map(b => b.toString(16).padStart(2, '0')).join('');
//     return `0x${hex}a7f3b9c8d2e1f4a6b5c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5...[AES-256-GCM ENCRYPTED PAYLOAD]...e9f0a1b2c3d4e5f6a7b8c9d0`;
//   };

//   // --- RENDER LOGIN SCREEN IF NOT AUTHENTICATED ---
//   if (isAuthLoading) return <div className="bg-[#121212] h-screen w-full flex items-center justify-center text-emerald-500">Loading SwarmVault...</div>;

//   if (!user) {
//     return (
//       <div className="bg-[#121212] h-screen w-full flex flex-col items-center justify-center text-white font-sans">
//         <div className="bg-zinc-900 border border-zinc-800 p-10 rounded-2xl flex flex-col items-center max-w-md w-full text-center shadow-2xl">
//           <Shield className="text-emerald-500 w-16 h-16 mb-6" />
//           <h1 className="text-3xl font-bold tracking-wider mb-2">SwarmVault</h1>
//           <p className="text-zinc-400 mb-8">Decentralized, mathematically secure file storage.</p>
//           <button 
//             onClick={handleLogin}
//             className="w-full bg-white hover:bg-zinc-200 text-black font-semibold py-3 px-4 rounded-xl flex items-center justify-center gap-3 transition-colors"
//           >
//             <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google" className="w-5 h-5" />
//             Continue with Google
//           </button>
//         </div>
//       </div>
//     );
//   }

//   // --- RENDER VAULT IF AUTHENTICATED ---
//   return (
//     <div className="bg-[#121212] text-white min-h-screen flex flex-col font-sans relative">
//       <header className="flex justify-between items-center p-6 border-b border-zinc-800">
//         <div className="flex items-center gap-2">
//           <Shield className="text-emerald-500" />
//           <h1 className="text-2xl font-bold tracking-wider">SwarmVault</h1>
//         </div>
//         <div className="flex items-center gap-4 text-sm">
//           <div className="hidden md:flex items-center gap-2 bg-zinc-800 px-3 py-1 rounded-full">
//             <span className={`w-2 h-2 rounded-full ${isLocalMode ? 'bg-zinc-500' : 'bg-emerald-500'}`}></span>
//             <p>{activePeers.size} Peers</p>
//           </div>
//           <button onClick={handleEmptyVault} className="hidden md:flex items-center gap-2 bg-red-600/20 hover:bg-red-600/40 text-red-500 px-3 py-1 rounded-full transition-colors">
//             <Trash2 className="w-4 h-4" /> Empty Vault
//           </button>
//           <div className="flex items-center gap-3 pl-4 border-l border-zinc-700">
//             <img src={user.photoURL} alt="Profile" className="w-8 h-8 rounded-full" />
//             <button onClick={handleLogout} className="text-zinc-400 hover:text-white transition-colors" title="Sign Out">
//               <LogOut className="w-5 h-5" />
//             </button>
//           </div>
//         </div>
//       </header>

//       <main className="flex flex-col flex-1 p-8 max-w-5xl mx-auto w-full gap-8">
//         <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
//           <div className="md:col-span-2 flex flex-col gap-4">
//             <div 
//               className="border-2 border-dashed border-zinc-700 hover:border-emerald-500 transition-colors rounded-xl p-12 flex flex-col items-center justify-center text-center cursor-pointer bg-zinc-900/50"
//               onDragOver={(e) => e.preventDefault()}
//               onDrop={handleFileDrop}
//               onClick={() => document.getElementById('fileInput').click()}
//             >
//               <input id="fileInput" type="file" className="hidden" onChange={handleFileDrop} />
//               <div className="bg-zinc-800 p-4 rounded-full mb-4">
//                  <File className="text-emerald-500 w-8 h-8" />
//               </div>
//               <h3 className="text-lg font-medium mb-1">Upload to the Swarm</h3>
//               <p className="text-sm text-zinc-400">Drag & drop a file, or click to browse</p>
//             </div>

//             <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-6 flex-1">
//               <h2 className="text-lg font-medium mb-4">Your Encrypted Vault</h2>
//               {vaultFiles.length === 0 ? (
//                 <p className="text-zinc-500 text-sm">No files in the vault yet.</p>
//               ) : (
//                 <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
//                   {vaultFiles.map((f, i) => (
//                     <div key={i} className="relative group aspect-square bg-zinc-800 rounded-lg overflow-hidden border border-zinc-700 flex flex-col items-center justify-center">
                      
//                       {!f.unlocked && (
//                         <button 
//                           onClick={(e) => { e.stopPropagation(); handleDeleteSingleFile(i, f.name); }} 
//                           className="absolute top-2 right-2 bg-red-600/80 hover:bg-red-500 text-white p-1.5 rounded-full z-10 opacity-0 group-hover:opacity-100 transition-opacity"
//                         >
//                           <Trash2 className="w-3 h-3" />
//                         </button>
//                       )}

//                       {f.mimeType && f.mimeType.startsWith('image/') ? (
//                         <img 
//                           src={f.unlocked ? f.decryptedUrl : f.thumbnail} 
//                           alt={f.name} 
//                           className={`object-cover w-full h-full transition-all duration-700 ${f.unlocked ? '' : 'blur-xl opacity-60 scale-110'}`} 
//                         />
//                       ) : (
//                         <File className="w-12 h-12 text-zinc-600" />
//                       )}

//                       {!f.unlocked && (
//                         <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
//                           <Lock className="w-8 h-8 text-white/50 drop-shadow-lg" />
//                         </div>
//                       )}

//                       {!f.unlocked && (
//                         <div className="absolute inset-0 bg-black/80 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-3">
//                           <button onClick={() => handleFileRetrieve(f, i)} className="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded-full text-sm font-medium flex items-center gap-2">
//                             <Unlock className="w-4 h-4" /> Retrieve
//                           </button>
//                           <button onClick={() => setViewShard(f)} className="bg-zinc-700 hover:bg-zinc-600 text-white px-4 py-2 rounded-full text-xs font-medium flex items-center gap-2">
//                             <Eye className="w-3 h-3" /> Peer View
//                           </button>
//                         </div>
//                       )}
                      
//                       <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 to-transparent p-2 text-xs truncate text-center">
//                         {f.name}
//                       </div>
//                     </div>
//                   ))}
//                 </div>
//               )}
//             </div>
//           </div>

//           <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex flex-col h-[500px]">
//             <h2 className="text-sm font-medium text-zinc-400 mb-4 uppercase tracking-wider">Network Log</h2>
//             <div className="flex flex-col gap-2 overflow-y-auto">
//               {statusLog.map((log, index) => (
//                 <div key={index} className={`text-xs p-2 rounded border-l-2 ${
//                   log.type === 'error' ? 'border-red-500 bg-red-500/10 text-red-200' :
//                   log.type === 'success' ? 'border-emerald-500 bg-emerald-500/10 text-emerald-200' :
//                   'border-blue-500 bg-blue-500/10 text-blue-200'
//                 }`}>
//                   {log.message}
//                 </div>
//               ))}
//             </div>
//           </div>
//         </div>
//       </main>

//       {viewShard && (
//         <div className="absolute inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
//           <div className="bg-zinc-900 border border-zinc-700 p-6 rounded-xl max-w-lg w-full">
//             <div className="flex justify-between items-center mb-4">
//               <h3 className="text-lg font-bold text-red-500 flex items-center gap-2"><Lock className="w-5 h-5"/> Shard Encrypted</h3>
//               <button onClick={() => setViewShard(null)} className="text-zinc-400 hover:text-white"><X className="w-5 h-5"/></button>
//             </div>
//             <p className="text-sm text-zinc-400 mb-4">
//               This is what a peer sees when holding a shard of <strong>{viewShard.name}</strong>. Without your private AES-GCM decryption key, the file is mathematically impossible to open.
//             </p>
//             <div className="bg-black p-4 rounded-lg border border-zinc-800 font-mono text-xs text-emerald-500 break-all h-32 overflow-y-auto">
//               {generateRawGibberish(viewShard.iv)}
//             </div>
//           </div>
//         </div>
//       )}
//     </div>
//   );
// };

// export default App;





// final app change adding signin page 
// import React, { useState, useEffect, useRef } from 'react';
// import { encryptAndShard, reassembleAndDecrypt } from './utils/crypto';
// import { initP2PNode, registerSilentStorageReceiver, distributeChunks, fetchChunks } from './utils/p2p';
// import { Shield, File, Lock, Unlock, Trash2, Eye, X } from 'lucide-react'; 

// const App = () => {
//   const [peerId, setPeerId] = useState('Connecting to Swarm...');
//   const [activePeers, setActivePeers] = useState(new Set());
//   const [statusLog, setStatusLog] = useState([]);
//   const [viewShard, setViewShard] = useState(null); 
//   const nodeRef = useRef(null); 

//   const [vaultFiles, setVaultFiles] = useState(() => {
//     const saved = localStorage.getItem('swarmvault_files');
//     return saved ? JSON.parse(saved) : [];
//   });

//   useEffect(() => {
//     localStorage.setItem('swarmvault_files', JSON.stringify(vaultFiles));
//   }, [vaultFiles]);

//   const isLocalMode = activePeers.size === 0;

//   useEffect(() => {
//     const startupP2P = async () => {
//       try {
//         const node = await initP2PNode(
//           (newPeer) => setActivePeers(prev => new Set(prev).add(newPeer.toString())),
//           (lostPeer) => setActivePeers(prev => {
//              const updated = new Set(prev);
//              updated.delete(lostPeer.toString());
//              return updated;
//           })
//         );
//         nodeRef.current = node;
//         setPeerId(node.peerId.toString());
//         addLog('success', 'Connected to the P2P Swarm');
//       } catch (err) {
//         addLog('error', 'Failed to start P2P node: ' + err.message);
//       }
//     };
//     startupP2P();
//   }, []);

//   const addLog = (type, message) => {
//     setStatusLog(prev => [...prev, { type, message }]);
//   };

//   const handleEmptyVault = () => {
//     if(window.confirm("Are you sure you want to permanently delete all files in your vault? This cannot be undone.")) {
//       setVaultFiles([]);
//       localStorage.removeItem('swarmvault_files');
//       indexedDB.deleteDatabase('SwarmVaultDB'); 
//       addLog('error', 'Vault completely wiped and destroyed.');
//     }
//   };

//   // --- NEW: SINGLE FILE DELETION ---
//   const handleDeleteSingleFile = (indexToRemove, fileName) => {
//     if(window.confirm(`Are you sure you want to delete ${fileName}?`)) {
//       setVaultFiles(prev => prev.filter((_, i) => i !== indexToRemove));
//       addLog('success', `${fileName} deleted from the vault.`);
//     }
//   };

//   const handleFileDrop = async (event) => {
//     event.preventDefault(); 
//     const file = event.dataTransfer ? event.dataTransfer.files[0] : event.target.files[0];
//     if (!file || !nodeRef.current) return;
    
//     addLog('info', `Encrypting ${file.name}...`);
    
//     try {
//       const { chunks, exportedKey, iv, mimeType, thumbnail } = await encryptAndShard(file);
//       const peerIdsArray = activePeers.size > 0 ? Array.from(activePeers) : ['local-network-mock'];
      
//       addLog('info', 'Distributing chunks to swarm...');
//       const manifest = await distributeChunks(nodeRef.current, chunks, peerIdsArray);

//       setVaultFiles(prev => [...prev, {
//         name: file.name,
//         manifest,
//         exportedKey,
//         iv,
//         mimeType,
//         thumbnail, 
//         unlocked: false 
//       }]);

//       if (event.target) event.target.value = ''; 
//       addLog('success', `${file.name} secured in SwarmVault!`);
//     } catch (error) {
//       addLog('error', 'File upload failed: ' + error.message);
//     }
//   };

//   const handleFileRetrieve = async (fileRecord, index) => {
//     addLog('info', `Fetching shards for ${fileRecord.name}...`);
//     try {
//       const chunks = await fetchChunks(nodeRef.current, fileRecord.manifest);
//       const decryptedUrl = await reassembleAndDecrypt(chunks, fileRecord.exportedKey, fileRecord.iv, fileRecord.mimeType);
      
//       setVaultFiles(prev => {
//         const newFiles = [...prev];
//         newFiles[index].unlocked = true;
//         newFiles[index].decryptedUrl = decryptedUrl;
//         return newFiles;
//       });

//       const link = document.createElement('a');
//       link.href = decryptedUrl;
//       link.download = `unlocked_${fileRecord.name}`;
//       document.body.appendChild(link);
//       link.click();
//       document.body.removeChild(link);
      
//       addLog('success', `${fileRecord.name} decrypted successfully!`);

//       setTimeout(() => {
//         setVaultFiles(prev => {
//           const newFiles = [...prev];
//           newFiles[index].unlocked = false;
//           URL.revokeObjectURL(newFiles[index].decryptedUrl);
//           return newFiles;
//         });
//       }, 3000);

//     } catch (err) {
//       addLog('error', 'Decryption failed: ' + err.message);
//     }
//   };

//   const generateRawGibberish = (ivArray) => {
//     const hex = ivArray.map(b => b.toString(16).padStart(2, '0')).join('');
//     return `0x${hex}a7f3b9c8d2e1f4a6b5c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5...[AES-256-GCM ENCRYPTED PAYLOAD]...e9f0a1b2c3d4e5f6a7b8c9d0`;
//   };

//   return (
//     <div className="bg-[#121212] text-white min-h-screen flex flex-col font-sans relative">
//       <header className="flex justify-between items-center p-6 border-b border-zinc-800">
//         <div className="flex items-center gap-2">
//           <Shield className="text-emerald-500" />
//           <h1 className="text-2xl font-bold tracking-wider">SwarmVault</h1>
//         </div>
//         <div className="flex items-center gap-4 text-sm">
//           <p className="text-zinc-400">Node ID: <span className="text-zinc-100">{peerId.slice(0, 8)}...</span></p>
//           <div className="flex items-center gap-2 bg-zinc-800 px-3 py-1 rounded-full">
//             <span className={`w-2 h-2 rounded-full ${isLocalMode ? 'bg-zinc-500' : 'bg-emerald-500'}`}></span>
//             <p>{activePeers.size} Peers</p>
//           </div>
//           <button onClick={handleEmptyVault} className="flex items-center gap-2 bg-red-600/20 hover:bg-red-600/40 text-red-500 px-3 py-1 rounded-full transition-colors">
//             <Trash2 className="w-4 h-4" /> Empty Vault
//           </button>
//         </div>
//       </header>

//       <main className="flex flex-col flex-1 p-8 max-w-5xl mx-auto w-full gap-8">
//         <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
//           <div className="md:col-span-2 flex flex-col gap-4">
//             <div 
//               className="border-2 border-dashed border-zinc-700 hover:border-emerald-500 transition-colors rounded-xl p-12 flex flex-col items-center justify-center text-center cursor-pointer bg-zinc-900/50"
//               onDragOver={(e) => e.preventDefault()}
//               onDrop={handleFileDrop}
//               onClick={() => document.getElementById('fileInput').click()}
//             >
//               <input id="fileInput" type="file" className="hidden" onChange={handleFileDrop} />
//               <div className="bg-zinc-800 p-4 rounded-full mb-4">
//                  <File className="text-emerald-500 w-8 h-8" />
//               </div>
//               <h3 className="text-lg font-medium mb-1">Upload to the Swarm</h3>
//               <p className="text-sm text-zinc-400">Drag & drop a file, or click to browse</p>
//             </div>

//             <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-6 flex-1">
//               <h2 className="text-lg font-medium mb-4">Your Encrypted Vault</h2>
//               {vaultFiles.length === 0 ? (
//                 <p className="text-zinc-500 text-sm">No files in the vault yet.</p>
//               ) : (
//                 <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
//                   {vaultFiles.map((f, i) => (
//                     <div key={i} className="relative group aspect-square bg-zinc-800 rounded-lg overflow-hidden border border-zinc-700 flex flex-col items-center justify-center">
                      
//                       {/* NEW: Single File Delete Button (Appears on Hover) */}
//                       {!f.unlocked && (
//                         <button 
//                           onClick={(e) => { e.stopPropagation(); handleDeleteSingleFile(i, f.name); }} 
//                           className="absolute top-2 right-2 bg-red-600/80 hover:bg-red-500 text-white p-1.5 rounded-full z-10 opacity-0 group-hover:opacity-100 transition-opacity"
//                         >
//                           <Trash2 className="w-3 h-3" />
//                         </button>
//                       )}

//                       {f.mimeType && f.mimeType.startsWith('image/') ? (
//                         <img 
//                           src={f.unlocked ? f.decryptedUrl : f.thumbnail} 
//                           alt={f.name} 
//                           className={`object-cover w-full h-full transition-all duration-700 ${f.unlocked ? '' : 'blur-xl opacity-60 scale-110'}`} 
//                         />
//                       ) : (
//                         <File className="w-12 h-12 text-zinc-600" />
//                       )}

//                       {!f.unlocked && (
//                         <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
//                           <Lock className="w-8 h-8 text-white/50 drop-shadow-lg" />
//                         </div>
//                       )}

//                       {!f.unlocked && (
//                         <div className="absolute inset-0 bg-black/80 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-3">
//                           <button onClick={() => handleFileRetrieve(f, i)} className="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded-full text-sm font-medium flex items-center gap-2">
//                             <Unlock className="w-4 h-4" /> Retrieve
//                           </button>
//                           <button onClick={() => setViewShard(f)} className="bg-zinc-700 hover:bg-zinc-600 text-white px-4 py-2 rounded-full text-xs font-medium flex items-center gap-2">
//                             <Eye className="w-3 h-3" /> Peer View
//                           </button>
//                         </div>
//                       )}
                      
//                       <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 to-transparent p-2 text-xs truncate text-center">
//                         {f.name}
//                       </div>
//                     </div>
//                   ))}
//                 </div>
//               )}
//             </div>
//           </div>

//           <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex flex-col h-[500px]">
//             <h2 className="text-sm font-medium text-zinc-400 mb-4 uppercase tracking-wider">Network Log</h2>
//             <div className="flex flex-col gap-2 overflow-y-auto">
//               {statusLog.map((log, index) => (
//                 <div key={index} className={`text-xs p-2 rounded border-l-2 ${
//                   log.type === 'error' ? 'border-red-500 bg-red-500/10 text-red-200' :
//                   log.type === 'success' ? 'border-emerald-500 bg-emerald-500/10 text-emerald-200' :
//                   'border-blue-500 bg-blue-500/10 text-blue-200'
//                 }`}>
//                   {log.message}
//                 </div>
//               ))}
//             </div>
//           </div>
//         </div>
//       </main>

//       {viewShard && (
//         <div className="absolute inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
//           <div className="bg-zinc-900 border border-zinc-700 p-6 rounded-xl max-w-lg w-full">
//             <div className="flex justify-between items-center mb-4">
//               <h3 className="text-lg font-bold text-red-500 flex items-center gap-2"><Lock className="w-5 h-5"/> Shard Encrypted</h3>
//               <button onClick={() => setViewShard(null)} className="text-zinc-400 hover:text-white"><X className="w-5 h-5"/></button>
//             </div>
//             <p className="text-sm text-zinc-400 mb-4">
//               This is what a peer sees when holding a shard of <strong>{viewShard.name}</strong>. Without your private AES-GCM decryption key, the file is mathematically impossible to open.
//             </p>
//             <div className="bg-black p-4 rounded-lg border border-zinc-800 font-mono text-xs text-emerald-500 break-all h-32 overflow-y-auto">
//               {generateRawGibberish(viewShard.iv)}
//             </div>
//           </div>
//         </div>
//       )}
//     </div>
//   );
// };

// export default App;





//  changes delete button and removing storagge progress bar
// import React, { useState, useEffect, useRef } from 'react';
// import { encryptAndShard, reassembleAndDecrypt } from './utils/crypto';
// import { initP2PNode, registerSilentStorageReceiver, distributeChunks, fetchChunks } from './utils/p2p';
// import { Shield, HardDrive, File, Lock, Unlock, Image as ImageIcon } from 'lucide-react'; 

// const App = () => {
//   const [peerId, setPeerId] = useState('Connecting to Swarm...');
//   const [activePeers, setActivePeers] = useState(new Set());
//   const [statusLog, setStatusLog] = useState([]);
//   const nodeRef = useRef(null); 

//   // Load vault history from local storage on boot
//   const [vaultFiles, setVaultFiles] = useState(() => {
//     const saved = localStorage.getItem('swarmvault_files');
//     return saved ? JSON.parse(saved) : [];
//   });

//   // Save to local storage automatically whenever vault changes
//   useEffect(() => {
//     localStorage.setItem('swarmvault_files', JSON.stringify(vaultFiles));
//   }, [vaultFiles]);

//   // Dynamic Storage Logic: If 0 peers, we use local space. If peers exist, local drops to 0.
//   const isLocalMode = activePeers.size === 0;
//   const storagePercent = isLocalMode ? Math.min(vaultFiles.length * 15, 100) : 0;

//   useEffect(() => {
//     const startupP2P = async () => {
//       try {
//         const node = await initP2PNode(
//           (newPeer) => setActivePeers(prev => new Set(prev).add(newPeer.toString())),
//           (lostPeer) => setActivePeers(prev => {
//              const updated = new Set(prev);
//              updated.delete(lostPeer.toString());
//              return updated;
//           })
//         );
//         nodeRef.current = node;
//         setPeerId(node.peerId.toString());
//         addLog('success', 'Connected to the P2P Swarm');
//       } catch (err) {
//         addLog('error', 'Failed to start P2P node: ' + err.message);
//       }
//     };
//     startupP2P();
//   }, []);

//   const addLog = (type, message) => {
//     setStatusLog(prev => [...prev, { type, message }]);
//   };

//   const handleFileDrop = async (event) => {
//     event.preventDefault(); 
//     const file = event.dataTransfer ? event.dataTransfer.files[0] : event.target.files[0];
//     if (!file || !nodeRef.current) return;
    
//     addLog('info', `Encrypting ${file.name}...`);
    
//     try {
//       const { chunks, exportedKey, iv, mimeType, thumbnail } = await encryptAndShard(file);
//       const peerIdsArray = activePeers.size > 0 ? Array.from(activePeers) : ['local-network-mock'];
      
//       addLog('info', 'Distributing chunks to swarm...');
//       const manifest = await distributeChunks(nodeRef.current, chunks, peerIdsArray);

//       setVaultFiles(prev => [...prev, {
//         name: file.name,
//         manifest,
//         exportedKey,
//         iv,
//         mimeType,
//         thumbnail, 
//         unlocked: false 
//       }]);

//       if (event.target) event.target.value = ''; 
//       addLog('success', `${file.name} secured in SwarmVault!`);
//     } catch (error) {
//       addLog('error', 'File upload failed: ' + error.message);
//     }
//   };

//   const handleFileRetrieve = async (fileRecord, index) => {
//     addLog('info', `Fetching shards for ${fileRecord.name}...`);
//     try {
//       const chunks = await fetchChunks(nodeRef.current, fileRecord.manifest);
//       const decryptedUrl = await reassembleAndDecrypt(chunks, fileRecord.exportedKey, fileRecord.iv, fileRecord.mimeType);
      
//       // Un-blur the image
//       setVaultFiles(prev => {
//         const newFiles = [...prev];
//         newFiles[index].unlocked = true;
//         newFiles[index].decryptedUrl = decryptedUrl;
//         return newFiles;
//       });

//       // Auto-download
//       const link = document.createElement('a');
//       link.href = decryptedUrl;
//       link.download = `unlocked_${fileRecord.name}`;
//       document.body.appendChild(link);
//       link.click();
//       document.body.removeChild(link);
      
//       addLog('success', `${fileRecord.name} decrypted successfully!`);

//       // Re-blur automatically after 3 seconds
//       setTimeout(() => {
//         setVaultFiles(prev => {
//           const newFiles = [...prev];
//           newFiles[index].unlocked = false;
//           URL.revokeObjectURL(newFiles[index].decryptedUrl); // Clean up memory
//           return newFiles;
//         });
//       }, 3000);

//     } catch (err) {
//       addLog('error', 'Decryption failed: ' + err.message);
//     }
//   };

//   return (
//     <div className="bg-[#121212] text-white min-h-screen flex flex-col font-sans">
//       <header className="flex justify-between items-center p-6 border-b border-zinc-800">
//         <div className="flex items-center gap-2">
//           <Shield className="text-emerald-500" />
//           <h1 className="text-2xl font-bold tracking-wider">SwarmVault</h1>
//         </div>
//         <div className="flex items-center gap-4 text-sm">
//           <p className="text-zinc-400">Node ID: <span className="text-zinc-100">{peerId.slice(0, 8)}...</span></p>
//           <div className="flex items-center gap-2 bg-zinc-800 px-3 py-1 rounded-full">
//             <span className={`w-2 h-2 rounded-full ${isLocalMode ? 'bg-zinc-500' : 'bg-emerald-500'}`}></span>
//             <p>{activePeers.size} Peers</p>
//           </div>
//         </div>
//       </header>

//       <main className="flex flex-col flex-1 p-8 max-w-5xl mx-auto w-full gap-8">
//         <div className="flex items-center gap-4 w-full bg-zinc-900 p-4 rounded-xl border border-zinc-800">
//           <HardDrive className="text-zinc-400" />
//           <div className="flex-1 h-2 bg-zinc-800 rounded-full overflow-hidden">
//              <div className={`h-full transition-all duration-1000 ${isLocalMode ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${storagePercent}%` }}></div>
//           </div>
//           <p className="text-sm text-zinc-400">
//             {isLocalMode ? `${storagePercent}% Local Fallback (Waiting for Swarm)` : '0% - Fully Distributed to Network'}
//           </p>
//         </div>

//         <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
//           <div className="md:col-span-2 flex flex-col gap-4">
//             <div 
//               className="border-2 border-dashed border-zinc-700 hover:border-emerald-500 transition-colors rounded-xl p-12 flex flex-col items-center justify-center text-center cursor-pointer bg-zinc-900/50"
//               onDragOver={(e) => e.preventDefault()}
//               onDrop={handleFileDrop}
//               onClick={() => document.getElementById('fileInput').click()}
//             >
//               <input id="fileInput" type="file" className="hidden" onChange={handleFileDrop} />
//               <div className="bg-zinc-800 p-4 rounded-full mb-4">
//                  <File className="text-emerald-500 w-8 h-8" />
//               </div>
//               <h3 className="text-lg font-medium mb-1">Upload to the Swarm</h3>
//               <p className="text-sm text-zinc-400">Drag & drop a file, or click to browse</p>
//             </div>

//             <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-6 flex-1">
//               <h2 className="text-lg font-medium mb-4">Your Encrypted Vault</h2>
//               {vaultFiles.length === 0 ? (
//                 <p className="text-zinc-500 text-sm">No files in the vault yet.</p>
//               ) : (
//                 <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
//                   {vaultFiles.map((f, i) => (
//                     <div key={i} className="relative group aspect-square bg-zinc-800 rounded-lg overflow-hidden border border-zinc-700 flex flex-col items-center justify-center">
                      
//                       {f.mimeType.startsWith('image/') ? (
//                         <img 
//                           src={f.unlocked ? f.decryptedUrl : f.thumbnail} 
//                           alt={f.name} 
//                           className={`object-cover w-full h-full transition-all duration-700 ${f.unlocked ? '' : 'blur-xl opacity-60 scale-110'}`} 
//                         />
//                       ) : (
//                         <File className="w-12 h-12 text-zinc-600" />
//                       )}

//                       {!f.unlocked && (
//                         <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
//                           <Lock className="w-8 h-8 text-white/50 drop-shadow-lg" />
//                         </div>
//                       )}

//                       {!f.unlocked && (
//                         <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center cursor-pointer" onClick={() => handleFileRetrieve(f, i)}>
//                           <button className="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded-full text-sm font-medium flex items-center gap-2">
//                             <Unlock className="w-4 h-4" /> Retrieve
//                           </button>
//                         </div>
//                       )}
                      
//                       <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 to-transparent p-2 text-xs truncate">
//                         {f.name}
//                       </div>
//                     </div>
//                   ))}
//                 </div>
//               )}
//             </div>
//           </div>

//           <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex flex-col h-[500px]">
//             <h2 className="text-sm font-medium text-zinc-400 mb-4 uppercase tracking-wider">Network Log</h2>
//             <div className="flex flex-col gap-2 overflow-y-auto">
//               {statusLog.map((log, index) => (
//                 <div key={index} className={`text-xs p-2 rounded border-l-2 ${
//                   log.type === 'error' ? 'border-red-500 bg-red-500/10 text-red-200' :
//                   log.type === 'success' ? 'border-emerald-500 bg-emerald-500/10 text-emerald-200' :
//                   'border-blue-500 bg-blue-500/10 text-blue-200'
//                 }`}>
//                   {log.message}
//                 </div>
//               ))}
//             </div>
//           </div>
//         </div>
//       </main>
//     </div>
//   );
// };

// export default App;


//  making peer based storage and relocking the image (2)
// import React, { useState, useEffect, useRef } from 'react';
// import { encryptAndShard, reassembleAndDecrypt } from './utils/crypto';
// import { initP2PNode, registerSilentStorageReceiver, distributeChunks, fetchChunks } from './utils/p2p';
// import { Shield, HardDrive, File, Lock, Unlock, Image as ImageIcon } from 'lucide-react'; 

// const App = () => {
//   const [peerId, setPeerId] = useState('Connecting to Swarm...');
//   const [activePeers, setActivePeers] = useState(new Set()); // Now tracking ACTUAL peers
//   const [storageUsed, setStorageUsed] = useState(0);
//   const [statusLog, setStatusLog] = useState([]);
//   const [vaultFiles, setVaultFiles] = useState([]); 
//   const nodeRef = useRef(null); 

//   useEffect(() => {
//     const startupP2P = async () => {
//       try {
//         const node = await initP2PNode(
//           (newPeer) => {
//              setActivePeers(prev => new Set(prev).add(newPeer.toString()));
//           },
//           (lostPeer) => {
//              setActivePeers(prev => {
//                const updated = new Set(prev);
//                updated.delete(lostPeer.toString());
//                return updated;
//              });
//           }
//         );
//         nodeRef.current = node;
//         setPeerId(node.peerId.toString());
//         addLog('success', 'Connected to the P2P Swarm');
//       } catch (err) {
//         addLog('error', 'Failed to start P2P node: ' + err.message);
//       }
//     };
//     startupP2P();
//   }, []);

//   const addLog = (type, message) => {
//     setStatusLog(prev => [...prev, { type, message }]);
//   };

//   const handleFileDrop = async (event) => {
//     event.preventDefault(); 
//     const file = event.dataTransfer ? event.dataTransfer.files[0] : event.target.files[0];
    
//     if (!file || !nodeRef.current) return;
    
//     addLog('info', `Encrypting ${file.name}...`);
    
//     try {
//       // We pull the thumbnail out of the crypto engine here
//       const { chunks, exportedKey, iv, mimeType, thumbnail } = await encryptAndShard(file);
      
//       // If real peers exist, use them. Otherwise, fall back to local testing.
//       const peerIdsArray = activePeers.size > 0 ? Array.from(activePeers) : ['local-network-mock'];
      
//       addLog('info', 'Distributing chunks to swarm...');
//       const manifest = await distributeChunks(nodeRef.current, chunks, peerIdsArray);

//       setVaultFiles(prev => [...prev, {
//         name: file.name,
//         manifest,
//         exportedKey,
//         iv,
//         mimeType,
//         thumbnail, // Save the visual preview
//         unlocked: false // Track if it has been retrieved
//       }]);

//       if (event.target) event.target.value = ''; 
//       setStorageUsed(prev => prev + 5); 
//       addLog('success', `${file.name} secured in SwarmVault!`);
//     } catch (error) {
//       addLog('error', 'File upload failed: ' + error.message);
//     }
//   };

//   const handleFileRetrieve = async (fileRecord, index) => {
//     addLog('info', `Fetching shards for ${fileRecord.name}...`);
//     try {
//       const chunks = await fetchChunks(nodeRef.current, fileRecord.manifest);
//       const decryptedUrl = await reassembleAndDecrypt(chunks, fileRecord.exportedKey, fileRecord.iv, fileRecord.mimeType);
      
//       // Update the UI to show the unlocked file
//       setVaultFiles(prev => {
//         const newFiles = [...prev];
//         newFiles[index].unlocked = true;
//         newFiles[index].decryptedUrl = decryptedUrl;
//         return newFiles;
//       });

//       // Auto-download the reassembled file
//       const link = document.createElement('a');
//       link.href = decryptedUrl;
//       link.download = `unlocked_${fileRecord.name}`;
//       document.body.appendChild(link);
//       link.click();
//       document.body.removeChild(link);
      
//       addLog('success', `${fileRecord.name} decrypted successfully!`);
//     } catch (err) {
//       addLog('error', 'Decryption failed: ' + err.message);
//     }
//   };

//   return (
//     <div className="bg-[#121212] text-white min-h-screen flex flex-col font-sans">
//       <header className="flex justify-between items-center p-6 border-b border-zinc-800">
//         <div className="flex items-center gap-2">
//           <Shield className="text-emerald-500" />
//           <h1 className="text-2xl font-bold tracking-wider">SwarmVault</h1>
//         </div>
//         <div className="flex items-center gap-4 text-sm">
//           <p className="text-zinc-400">Node ID: <span className="text-zinc-100">{peerId.slice(0, 8)}...</span></p>
//           <div className="flex items-center gap-2 bg-zinc-800 px-3 py-1 rounded-full">
//             <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
//             <p>{activePeers.size} Peers</p>
//           </div>
//         </div>
//       </header>

//       <main className="flex flex-col flex-1 p-8 max-w-5xl mx-auto w-full gap-8">
//         <div className="flex items-center gap-4 w-full bg-zinc-900 p-4 rounded-xl border border-zinc-800">
//           <HardDrive className="text-zinc-400" />
//           <div className="flex-1 h-2 bg-zinc-800 rounded-full overflow-hidden">
//              <div className="h-full bg-emerald-500 transition-all duration-500" style={{ width: `${storageUsed}%` }}></div>
//           </div>
//           <p className="text-sm text-zinc-400">{storageUsed}% of Local Limit</p>
//         </div>

//         <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
//           <div className="md:col-span-2 flex flex-col gap-4">
//             <div 
//               className="border-2 border-dashed border-zinc-700 hover:border-emerald-500 transition-colors rounded-xl p-12 flex flex-col items-center justify-center text-center cursor-pointer bg-zinc-900/50"
//               onDragOver={(e) => e.preventDefault()}
//               onDrop={handleFileDrop}
//               onClick={() => document.getElementById('fileInput').click()}
//             >
//               <input id="fileInput" type="file" className="hidden" onChange={handleFileDrop} />
//               <div className="bg-zinc-800 p-4 rounded-full mb-4">
//                  <File className="text-emerald-500 w-8 h-8" />
//               </div>
//               <h3 className="text-lg font-medium mb-1">Upload to the Swarm</h3>
//               <p className="text-sm text-zinc-400">Drag & drop a file, or click to browse</p>
//             </div>

//             <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-6 flex-1">
//               <h2 className="text-lg font-medium mb-4">Your Encrypted Vault</h2>
//               {vaultFiles.length === 0 ? (
//                 <p className="text-zinc-500 text-sm">No files in the vault yet.</p>
//               ) : (
//                 <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
//                   {vaultFiles.map((f, i) => (
//                     <div key={i} className="relative group aspect-square bg-zinc-800 rounded-lg overflow-hidden border border-zinc-700 flex flex-col items-center justify-center">
                      
//                       {/* Render Blurred Image or File Icon */}
//                       {f.mimeType.startsWith('image/') ? (
//                         <img 
//                           src={f.unlocked ? f.decryptedUrl : f.thumbnail} 
//                           alt={f.name} 
//                           className={`object-cover w-full h-full transition-all duration-700 ${f.unlocked ? '' : 'blur-xl opacity-60 scale-110'}`} 
//                         />
//                       ) : (
//                         <File className="w-12 h-12 text-zinc-600" />
//                       )}

//                       {/* Lock Icon overlay for encrypted state */}
//                       {!f.unlocked && (
//                         <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
//                           <Lock className="w-8 h-8 text-white/50 drop-shadow-lg" />
//                         </div>
//                       )}

//                       {/* Hover action to retrieve */}
//                       {!f.unlocked && (
//                         <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center cursor-pointer" onClick={() => handleFileRetrieve(f, i)}>
//                           <button className="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded-full text-sm font-medium flex items-center gap-2">
//                             <Unlock className="w-4 h-4" /> Retrieve
//                           </button>
//                         </div>
//                       )}
                      
//                       {/* Name label at bottom */}
//                       <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 to-transparent p-2 text-xs truncate">
//                         {f.name}
//                       </div>
//                     </div>
//                   ))}
//                 </div>
//               )}
//             </div>
//           </div>

//           <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex flex-col h-[500px]">
//             <h2 className="text-sm font-medium text-zinc-400 mb-4 uppercase tracking-wider">Network Log</h2>
//             <div className="flex flex-col gap-2 overflow-y-auto">
//               {statusLog.map((log, index) => (
//                 <div key={index} className={`text-xs p-2 rounded border-l-2 ${
//                   log.type === 'error' ? 'border-red-500 bg-red-500/10 text-red-200' :
//                   log.type === 'success' ? 'border-emerald-500 bg-emerald-500/10 text-emerald-200' :
//                   'border-blue-500 bg-blue-500/10 text-blue-200'
//                 }`}>
//                   {log.message}
//                 </div>
//               ))}
//             </div>
//           </div>
//         </div>
//       </main>
//     </div>
//   );
// };

// export default App;



// image blur need to be added (1)
// import React, { useState, useEffect, useRef } from 'react';
// import { encryptAndShard, reassembleAndDecrypt } from './utils/crypto';
// import { initP2PNode, registerSilentStorageReceiver, distributeChunks, fetchChunks } from './utils/p2p';
// import { Shield, HardDrive, File } from 'lucide-react'; 

// const App = () => {
//   const [peerId, setPeerId] = useState('Connecting to Swarm...');
//   const [activePeersCount, setActivePeersCount] = useState(0);
//   const [storageUsed, setStorageUsed] = useState(0);
//   const [statusLog, setStatusLog] = useState([]);
//   const [vaultFiles, setVaultFiles] = useState([]); 
//   const nodeRef = useRef(null); 

//   useEffect(() => {
//     const startupP2P = async () => {
//       try {
//         const node = await initP2PNode(
//           (newPeer) => {
//              setActivePeersCount((prev) => prev + 1);
//           },
//           (lostPeer) => {
//              setActivePeersCount((prev) => Math.max(0, prev - 1));
//           }
//         );
//         nodeRef.current = node;
//         setPeerId(node.peerId.toString());
//         addLog('success', 'Connected to the P2P Swarm');
//       } catch (err) {
//         addLog('error', 'Failed to start P2P node: ' + err.message);
//       }
//     };
//     startupP2P();
//   }, []);

//   const addLog = (type, message) => {
//     setStatusLog(prev => [...prev, { type, message }]);
//   };

//   const handleFileDrop = async (event) => {
//     event.preventDefault(); 
//     const file = event.dataTransfer ? event.dataTransfer.files[0] : event.target.files[0];
    
//     if (!file || !nodeRef.current) return;
    
//     addLog('info', `Encrypting ${file.name}...`);
    
//     try {
//       const { chunks, exportedKey, iv, mimeType } = await encryptAndShard(file);
      
//       const peerIdsArray = ['local-network-mock']; // In a full app, this pulls from the P2P active peers map
      
//       addLog('info', 'Distributing chunks to swarm...');
//       const manifest = await distributeChunks(nodeRef.current, chunks, peerIdsArray);

//       setVaultFiles(prev => [...prev, {
//         name: file.name,
//         manifest,
//         exportedKey,
//         iv,
//         mimeType
//       }]);

//       if (event.target) event.target.value = ''; 
      
//       setStorageUsed(prev => prev + 5); 
//       addLog('success', `${file.name} secured in SwarmVault!`);
//     } catch (error) {
//       addLog('error', 'File upload failed: ' + error.message);
//     }
//   };

//   const handleFileRetrieve = async (fileRecord) => {
//     addLog('info', `Fetching shards for ${fileRecord.name}...`);
//     try {
//       const chunks = await fetchChunks(nodeRef.current, fileRecord.manifest);
//       const decryptedUrl = await reassembleAndDecrypt(chunks, fileRecord.exportedKey, fileRecord.iv, fileRecord.mimeType);
      
//       // Auto-download the reassembled file
//       const link = document.createElement('a');
//       link.href = decryptedUrl;
//       link.download = `unlocked_${fileRecord.name}`;
//       document.body.appendChild(link);
//       link.click();
//       document.body.removeChild(link);
      
//       addLog('success', `${fileRecord.name} decrypted successfully!`);
//     } catch (err) {
//       addLog('error', 'Decryption failed: ' + err.message);
//     }
//   };

//   return (
//     <div className="bg-[#121212] text-white min-h-screen flex flex-col font-sans">
//       <header className="flex justify-between items-center p-6 border-b border-zinc-800">
//         <div className="flex items-center gap-2">
//           <Shield className="text-emerald-500" />
//           <h1 className="text-2xl font-bold tracking-wider">SwarmVault</h1>
//         </div>
//         <div className="flex items-center gap-4 text-sm">
//           <p className="text-zinc-400">Node ID: <span className="text-zinc-100">{peerId.slice(0, 8)}...</span></p>
//           <div className="flex items-center gap-2 bg-zinc-800 px-3 py-1 rounded-full">
//             <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
//             <p>{activePeersCount} Peers</p>
//           </div>
//         </div>
//       </header>

//       <main className="flex flex-col flex-1 p-8 max-w-5xl mx-auto w-full gap-8">
//         <div className="flex items-center gap-4 w-full bg-zinc-900 p-4 rounded-xl border border-zinc-800">
//           <HardDrive className="text-zinc-400" />
//           <div className="flex-1 h-2 bg-zinc-800 rounded-full overflow-hidden">
//              <div className="h-full bg-emerald-500 transition-all duration-500" style={{ width: `${storageUsed}%` }}></div>
//           </div>
//           <p className="text-sm text-zinc-400">{storageUsed}% of Local Limit</p>
//         </div>

//         <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
//           <div className="md:col-span-2 flex flex-col gap-4">
//             <div 
//               className="border-2 border-dashed border-zinc-700 hover:border-emerald-500 transition-colors rounded-xl p-12 flex flex-col items-center justify-center text-center cursor-pointer bg-zinc-900/50"
//               onDragOver={(e) => e.preventDefault()}
//               onDrop={handleFileDrop}
//               onClick={() => document.getElementById('fileInput').click()}
//             >
//               <input id="fileInput" type="file" className="hidden" onChange={handleFileDrop} />
//               <div className="bg-zinc-800 p-4 rounded-full mb-4">
//                  <File className="text-emerald-500 w-8 h-8" />
//               </div>
//               <h3 className="text-lg font-medium mb-1">Upload to the Swarm</h3>
//               <p className="text-sm text-zinc-400">Drag & drop a file, or click to browse</p>
//             </div>

//             <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-6 flex-1">
//               <h2 className="text-lg font-medium mb-4">Your Encrypted Vault</h2>
//               {vaultFiles.length === 0 ? (
//                 <p className="text-zinc-500 text-sm">No files in the vault yet.</p>
//               ) : (
//                 <div className="flex flex-col gap-2">
//                   {vaultFiles.map((f, i) => (
//                     <div key={i} className="flex justify-between items-center p-3 bg-zinc-800/50 rounded-lg border border-zinc-700/50">
//                       <span className="text-sm">{f.name}</span>
//                       <button onClick={() => handleFileRetrieve(f)} className="text-xs bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1 rounded transition-colors">
//                         Retrieve
//                       </button>
//                     </div>
//                   ))}
//                 </div>
//               )}
//             </div>
//           </div>

//           <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex flex-col h-full">
//             <h2 className="text-sm font-medium text-zinc-400 mb-4 uppercase tracking-wider">Network Log</h2>
//             <div className="flex flex-col gap-2 overflow-y-auto max-h-[400px]">
//               {statusLog.map((log, index) => (
//                 <div key={index} className={`text-xs p-2 rounded border-l-2 ${
//                   log.type === 'error' ? 'border-red-500 bg-red-500/10 text-red-200' :
//                   log.type === 'success' ? 'border-emerald-500 bg-emerald-500/10 text-emerald-200' :
//                   'border-blue-500 bg-blue-500/10 text-blue-200'
//                 }`}>
//                   {log.message}
//                 </div>
//               ))}
//             </div>
//           </div>
//         </div>
//       </main>
//     </div>
//   );
// };

// export default App;