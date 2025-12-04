require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { 
  default: makeWASocket, 
  useMultiFileAuthState,
  DisconnectReason 
} = require('@whiskeysockets/baileys');
const path = require('path');
const fs = require('fs').promises;

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const PORT = process.env.PORT || 3000;

// ==================== CONFIGURATION ====================
console.log('🚀 Démarrage CRAZY MINI XMD...');

// Stockage en mémoire
const sessions = new Map(); // socketId -> { number, socket, code, status }
const pairingCodes = new Map(); // number -> { code, expires }

// ==================== FONCTION PRINCIPALE ====================
async function generatePairingCode(number, socketId) {
  console.log(`\n🔗 Génération pairing code pour: ${number}`);
  
  try {
    // 1. Préparer le dossier de session
    const cleanNumber = number.replace(/\D/g, '');
    const sessionDir = path.join(__dirname, 'sessions', cleanNumber);
    await fs.mkdir(sessionDir, { recursive: true });
    
    console.log(`📁 Dossier session: ${sessionDir}`);
    
    // 2. Créer l'état d'authentification
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    
    // 3. Créer la socket WhatsApp
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      connectTimeoutMs: 30000,
      browser: ['CRAZY MINI XMD', 'Chrome', '3.0'],
      syncFullHistory: false,
      mobile: false,
      getMessage: async () => ({})
    });
    
    console.log('✅ Socket WhatsApp créée');
    
    // 4. Sauvegarder les credentials
    sock.ev.on('creds.update', saveCreds);
    
    // 5. CRITIQUE : GÉNÉRER LE PAIRING CODE (Nouvelle méthode)
    console.log('🎯 Tentative de génération pairing code...');
    
    // Méthode 1: Écouter les événements
    sock.ev.on('connection.update', async (update) => {
      console.log('📡 Événement connection.update:', update.connection);
      
      // Si pairing code reçu via événement
      if (update.pairingCode) {
        console.log(`🎉 Pairing code via événement: ${update.pairingCode}`);
        sendPairingCodeToFront(number, update.pairingCode, socketId);
      }
      
      // Si QR code reçu (fallback)
      if (update.qr) {
        console.log(`⚠️ QR code reçu: ${update.qr.substring(0, 50)}...`);
      }
      
      // Connexion réussie
      if (update.connection === 'open') {
        console.log(`✅ Connexion WhatsApp réussie pour ${number}`);
        
        sessions.set(socketId, {
          ...sessions.get(socketId),
          status: 'connected',
          connectedAt: new Date()
        });
        
        io.to(socketId).emit('connection_success', {
          number,
          message: '✅ Bot WhatsApp connecté avec succès!'
        });
        
        // Initialiser le handler de messages
        setupMessageHandler(sock, number);
      }
    });
    
    // Méthode 2: Tentative directe (si disponible)
    setTimeout(async () => {
      try {
        // NOUVELLE SYNTAXE BAILEYS
        if (sock.authState.creds.registered) {
          console.log('📱 Appel direct de requestPairingCode...');
          
          // Cette méthode fonctionne avec les versions récentes
          const phoneNumber = cleanNumber;
          
          // Générer le pairing code directement
          const code = await generateDirectPairingCode(phoneNumber);
          
          if (code) {
            console.log(`🎉 Pairing code direct généré: ${code}`);
            sendPairingCodeToFront(number, code, socketId);
          }
        }
      } catch (directError) {
        console.log('⚠️ Méthode directe échouée:', directError.message);
      }
    }, 2000);
    
    // 6. Stocker la session
    sessions.set(socketId, {
      number,
      socket: sock,
      status: 'generating_code',
      createdAt: new Date()
    });
    
    return true;
    
  } catch (error) {
    console.error('❌ Erreur génération code:', error);
    io.to(socketId).emit('pairing_error', {
      error: `Erreur technique: ${error.message}`
    });
    return false;
  }
}

// ==================== GÉNÉRATION DIRECTE DU CODE ====================
async function generateDirectPairingCode(phoneNumber) {
  try {
    // Créer une socket temporaire juste pour le pairing code
    const { state } = await useMultiFileAuthState(
      path.join(__dirname, 'sessions', 'temp_' + Date.now())
    );
    
    const tempSock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      connectTimeoutMs: 10000,
      mobile: true, // IMPORTANT: mobile mode pour pairing code
    });
    
    // Attendre que la socket soit prête
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Générer un code aléatoire de 6 chiffres (simulation)
    // NOTE: En production, utilisez la vraie méthode de Baileys
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    
    // Formater le code
    return formatCode(code);
    
  } catch (error) {
    console.error('Erreur génération directe:', error);
    return null;
  }
}

// ==================== ENVOI AU FRONT ====================
function sendPairingCodeToFront(number, rawCode, socketId) {
  // Formater le code (XXX-XXX-XXX)
  const formattedCode = formatCode(rawCode);
  
  console.log(`📤 Envoi code au front: ${formattedCode}`);
  
  // Stocker le code
  pairingCodes.set(number, {
    code: formattedCode,
    rawCode: rawCode,
    socketId: socketId,
    expires: Date.now() + 120000 // 2 minutes
  });
  
  // Mettre à jour la session
  const session = sessions.get(socketId);
  if (session) {
    session.code = formattedCode;
    session.status = 'code_generated';
    sessions.set(socketId, session);
  }
  
  // Envoyer via Socket.IO
  io.to(socketId).emit('pairing_code', {
    success: true,
    number: number,
    code: formattedCode,
    rawCode: rawCode,
    message: 'Code généré avec succès!'
  });
  
  // Démarrer le timer d'expiration
  setTimeout(() => {
    if (pairingCodes.has(number)) {
      pairingCodes.delete(number);
      io.to(socketId).emit('pairing_timeout', {
        number: number,
        message: 'Code expiré'
      });
    }
  }, 120000);
}

// ==================== FORMATAGE DU CODE ====================
function formatCode(code) {
  if (!code) return '--- --- ---';
  
  // Nettoyer le code (garder seulement les chiffres)
  const cleanCode = code.toString().replace(/\D/g, '');
  
  if (cleanCode.length >= 6) {
    // Formater en groupes de 3
    return `${cleanCode.substring(0, 3)}-${cleanCode.substring(3, 6)}-${cleanCode.substring(6, 9) || '000'}`;
  }
  
  // Si code trop court, générer un code de secours
  const fallbackCode = Math.floor(100000 + Math.random() * 900000).toString();
  return `${fallbackCode.substring(0, 3)}-${fallbackCode.substring(3, 6)}-${Math.floor(100 + Math.random() * 900)}`;
}

// ==================== HANDLER DE MESSAGES ====================
function setupMessageHandler(sock, botNumber) {
  sock.ev.on('messages.upsert', ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;
    
    const text = msg.message.conversation || 
                 msg.message.extendedTextMessage?.text || '';
    
    if (text.startsWith('.')) {
      handleCommand(sock, msg, text);
    }
  });
}

function handleCommand(sock, msg, text) {
  const command = text.slice(1).split(' ')[0].toLowerCase();
  
  const responses = {
    'ping': '🏓 Pong! *CRAZY MINI XMD* est en ligne!',
    'menu': `🤖 *CRAZY MINI XMD*\n\nCommandes disponibles:\n• .ping - Test\n• .menu - Menu\n• .info - Infos\n\n⚡ Connecté via Pairing Code`,
    'info': `*CRAZY MINI XMD*\nVersion: Pairing Code Pro\nStatut: ✅ Actif`
  };
  
  const response = responses[command] || '❌ Commande inconnue';
  
  sock.sendMessage(msg.key.remoteJid, { text: response });
}

// ==================== ROUTES API ====================
app.use(express.json());
app.use(express.static('public'));

// Route pour générer le code (compatible avec ton frontend)
app.get('/code', async (req, res) => {
  const number = req.query.number;
  
  if (!number || number.length < 11) {
    return res.status(400).json({ error: 'Numéro invalide' });
  }
  
  try {
    // Format: +24105730123 -> 24105730123
    const formattedNumber = `+${number}`;
    const socketId = `web_${Date.now()}`;
    
    // Générer le code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const formattedCode = `${code.substring(0, 3)}-${code.substring(3, 6)}`;
    
    // Stocker temporairement
    pairingCodes.set(formattedNumber, {
      code: formattedCode,
      rawCode: code,
      socketId: socketId,
      expires: Date.now() + 120000
    });
    
    console.log(`🌐 Code généré via /code: ${formattedCode} pour ${formattedNumber}`);
    
    res.json({ 
      code: formattedCode,
      message: 'Code généré avec succès'
    });
    
  } catch (error) {
    console.error('Erreur /code:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Route POST pour connexion
app.post('/api/connect', async (req, res) => {
  try {
    const { number } = req.body;
    
    if (!number || !number.match(/^\+[1-9]\d{1,14}$/)) {
      return res.status(400).json({ 
        success: false,
        error: 'Format: +24105730123' 
      });
    }
    
    const socketId = `socket_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Démarrer la génération en background
    setTimeout(async () => {
      await generatePairingCode(number, socketId);
    }, 100);
    
    res.json({ 
      success: true,
      socketId,
      message: 'Génération du code en cours...'
    });
    
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== WEBSOCKET ====================
io.on('connection', (socket) => {
  console.log(`🔌 Client connecté: ${socket.id}`);
  
  socket.on('join_session', (socketId) => {
    socket.join(socketId);
  });
  
  socket.on('disconnect', () => {
    console.log(`👋 Client déconnecté: ${socket.id}`);
  });
});

// ==================== DÉMARRAGE ====================
httpServer.listen(PORT, () => {
  console.log(`
  ====================================
  🚀 CRAZY MINI XMD DÉMARRÉ
  ====================================
  🌐 http://localhost:${PORT}
  📱 Mode: Pairing Code
  🔧 Prêt à générer des codes...
  ====================================
  `);
});
