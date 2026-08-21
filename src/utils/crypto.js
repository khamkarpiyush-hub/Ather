
// Helper to convert File/Blob into a permanent Base64 Data URL
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export async function encryptAndShard(file, chunkSize = 1024 * 1024) {
  const key = await window.crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );

  const rawIv = window.crypto.getRandomValues(new Uint8Array(12));
  const fileBuffer = await file.arrayBuffer();

  const encryptedBuffer = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: rawIv },
    key,
    fileBuffer
  );

  const encryptedBytes = new Uint8Array(encryptedBuffer);
  const chunks = [];
  for (let i = 0; i < encryptedBytes.length; i += chunkSize) {
    chunks.push(encryptedBytes.slice(i, i + chunkSize));
  }

  const exportedKey = await window.crypto.subtle.exportKey('jwk', key);
  
  // Create a tiny thumbnail (max 200x200) so it doesn't break Firestore's 1MB limit
  const generateThumbnail = (file) => new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX = 200;
        let { width, height } = img;
        if (width > height && width > MAX) { height *= MAX / width; width = MAX; }
        else if (height > MAX) { width *= MAX / height; height = MAX; }
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.6));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
  
  const thumbnail = file.type.startsWith('image/') ? await generateThumbnail(file) : null;
  const mimeType = file.type;

  // Convert IV to a normal array so JSON.stringify doesn't mangle it
  const iv = Array.from(rawIv);

  return { chunks, exportedKey, iv, thumbnail, mimeType };
}

export async function reassembleAndDecrypt(chunks, exportedKey, ivData, mimeType) {
  const key = await window.crypto.subtle.importKey(
    'jwk',
    exportedKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );

  // Safely reconstruct the Uint8Array IV from array/object
  const iv = new Uint8Array(Object.values(ivData));

  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const combinedBuffer = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combinedBuffer.set(chunk, offset);
    offset += chunk.length;
  }

  const decryptedBuffer = await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    combinedBuffer
  );

  return URL.createObjectURL(new Blob([decryptedBuffer], { type: mimeType }));
}




//  it cant handle base 64 bit needs change of convertion
// export async function encryptAndShard(file, chunkSize = 1024 * 1024) {
//   const key = await window.crypto.subtle.generateKey(
//     { name: 'AES-GCM', length: 256 },
//     true,
//     ['encrypt', 'decrypt']
//   );
//   const iv = window.crypto.getRandomValues(new Uint8Array(12));
//   const fileBuffer = await file.arrayBuffer();

//   const encryptedBuffer = await window.crypto.subtle.encrypt(
//     { name: 'AES-GCM', iv },
//     key,
//     fileBuffer
//   );

//   const encryptedBytes = new Uint8Array(encryptedBuffer);
//   const chunks = [];
//   for (let i = 0; i < encryptedBytes.length; i += chunkSize) {
//     chunks.push(encryptedBytes.slice(i, i + chunkSize));
//   }

//   const exportedKey = await window.crypto.subtle.exportKey('jwk', key);
//   const thumbnail = URL.createObjectURL(file);
//   const mimeType = file.type;

//   return { chunks, exportedKey, iv, thumbnail, mimeType };
// }

// export async function reassembleAndDecrypt(chunks, exportedKey, iv, mimeType) {
//   const key = await window.crypto.subtle.importKey(
//     'jwk',
//     exportedKey,
//     { name: 'AES-GCM', length: 256 },
//     false,
//     ['decrypt']
//   );

//   const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
//   const combinedBuffer = new Uint8Array(totalLength);
//   let offset = 0;
//   for (const chunk of chunks) {
//     combinedBuffer.set(chunk, offset);
//     offset += chunk.length;
//   }

//   const decryptedBuffer = await window.crypto.subtle.decrypt(
//     { name: 'AES-GCM', iv },
//     key,
//     combinedBuffer
//   );

//   return URL.createObjectURL(new Blob([decryptedBuffer], { type: mimeType }));
// }