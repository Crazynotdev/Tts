require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const path = require('path');
const fs = require('fs').promises;

// ==================== CONFIGURATION ====================
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});
const PORT = process.env.PORT || 3000;

// ==================== STOCKAGE DES SESSIONS ====================
const activeSessions = new Map(); // socketId -> { number, socket, pairingCode, status }
const userSessions = new Map();   // number -> socketId

// ==================== FONCTION PRINCIPALE DE CONNEXION ====================
async function createWhatsAppSession(number, socketId) {
  console.log(`🔗 Création session pour: ${number}`);
  
  try {
    // Nettoyer le numéro (enlever le +)
    const cleanNumber = number.replace('+', '');
    
    // Créer le dossier de session
    const sessionDir = path.join(__dirname, 'sessions', cleanNumber);
    await fs.mkdir(sessionDir, { recursive: true });
    
    // Initialiser l'état d'authentification
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    
    // Créer la socket WhatsApp
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      connectTimeoutMs: 60000,
      browser: ['CRAZY MINI XMD', 'Chrome', '3.0'],
      syncFullHistory: false,
      mobile: false,
    });
    
    // Sauvegarder les credentials
    sock.ev.on('creds.update', saveCreds);
    
    // ============ GÉNÉRATION DU PAIRING CODE ============
    console.log(`📱 Génération pairing code pour: ${cleanNumber}`);
    
    try {
      // ⭐⭐ C'EST ICI QUE LE PAIRING CODE EST GÉNÉRÉ ⭐⭐
      const pairingResult = await sock.requestPairingCode(cleanNumber);
      console.log('✅ Pairing code généré:', pairingResult);
      
      const pairingCode = pairingResult.code;
      const formattedCode = pairingCode.match(/.{1,3}/g)?.join(' ') || pairingCode;
      
      // Stocker la session
      activeSessions.set(socketId, {
        number,
        socket: sock,
        pairingCode: formattedCode,
        rawCode: pairingCode,
        status: 'awaiting_pairing',
        createdAt: new Date(),
        socketId
      });
      
      userSessions.set(number, socketId);
      
      // Envoyer le code au front via Socket.IO
      io.to(socketId).emit('pairing_code', {
        success: true,
        number,
        code: formattedCode,
        rawCode: pairingCode,
        message: 'Utilisez ce code dans WhatsApp > Appareils connectés'
      });
      
      console.log(`📤 Code envoyé au client: ${formattedCode}`);
      
    } catch (pairingError) {
      console.error('❌ Erreur requestPairingCode:', pairingError);
      io.to(socketId).emit('pairing_error', {
        error: 'Impossible de générer le code. Vérifiez le numéro.'
      });
      throw pairingError;
    }
    
    // ============ GESTION DES ÉVÉNEMENTS DE CONNEXION ============
    sock.ev.on('connection.update', async (update) => {
      console.log('📡 Update connexion:', update.connection);
      
      if (update.connection === 'open') {
        console.log(`✅ Connexion réussie pour: ${number}`);
        
        const session = activeSessions.get(socketId);
        if (session) {
          session.status = 'connected';
          session.connectedAt = new Date();
          activeSessions.set(socketId, session);
        }
        
        // Notifier le front
        io.to(socketId).emit('connection_success', {
          success: true,
          number,
          message: '✅ Bot WhatsApp connecté avec succès!',
          timestamp: new Date().toISOString()
        });
        
        // Initialiser le handler de messages
        setupMessageHandler(sock, number);
      }
      
      if (update.connection === 'close') {
        console.log(`❌ Déconnexion: ${number}`);
        
        const session = activeSessions.get(socketId);
        if (session) {
          // Si déconnecté manuellement de WhatsApp
          if (update.lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut) {
            // Supprimer les fichiers de session
            try {
              await fs.rm(sessionDir, { recursive: true });
            } catch (e) {}
          }
        }
        
        activeSessions.delete(socketId);
        userSessions.delete(number);
        
        io.to(socketId).emit('connection_closed', {
          number,
          message: 'Déconnecté de WhatsApp'
        });
      }
    });
    
    // Timeout après 2 minutes
    setTimeout(() => {
      const session = activeSessions.get(socketId);
      if (session && session.status === 'awaiting_pairing') {
        console.log(`⏱️ Timeout pairing pour ${number}`);
        
        io.to(socketId).emit('pairing_timeout', {
          number,
          message: 'Code expiré. Veuillez réessayer.'
        });
        
        sock.logout();
        activeSessions.delete(socketId);
        userSessions.delete(number);
      }
    }, 120000); // 2 minutes
    
    return true;
    
  } catch (error) {
    console.error('❌ Erreur création session:', error);
    io.to(socketId).emit('connection_error', {
      error: error.message || 'Erreur lors de la création de la session'
    });
    return false;
  }
}

// ==================== GESTION DES MESSAGES ====================
function setupMessageHandler(sock, botNumber) {
  sock.ev.on('messages.upsert', ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;
    
    const text = msg.message.conversation || 
                 msg.message.extendedTextMessage?.text || 
                 msg.message.imageMessage?.caption || '';
    
    console.log(`📥 Message reçu de ${botNumber}: ${text.substring(0, 50)}`);
    
    // Commandes du bot
    if (text.startsWith('.')) {
      const command = text.slice(1).split(' ')[0].toLowerCase();
      
      switch(command) {
        case 'ping':
          sock.sendMessage(msg.key.remoteJid, { 
            text: '🏓 Pong! *CRAZY MINI XMD* est en ligne!' 
          });
          break;
          
        case 'menu':
          const menu = `🤖 *CRAZY MINI XMD*\n\n` +
                      `📋 **Commandes disponibles:**\n` +
                      `• .ping - Test de réponse\n` +
                      `• .menu - Affiche ce menu\n` +
                      `• .info - Informations du bot\n` +
                      `• .time - Heure actuelle\n` +
                      `• .owner - Contact administrateur\n\n` +
                      `⚡ **Statut:** Connecté ✅\n` +
                      `🌐 **Hébergement:** Serveur Cloud`;
          sock.sendMessage(msg.key.remoteJid, { text: menu });
          break;
          
        case 'info':
          const info = `*🤖 CRAZY MINI XMD*\n\n` +
                      `📱 **Version:** 2.0 Pro\n` +
                      `🔧 **Statut:** Actif\n` +
                      `🌍 **Hébergement:** Serveur 24/7\n` +
                      `🛡️ **Sécurité:** Session chiffrée\n` +
                      `⚡ **Latence:** < 500ms`;
          sock.sendMessage(msg.key.remoteJid, { text: info });
          break;
          
        case 'time':
          const now = new Date();
          const timeStr = now.toLocaleString('fr-FR', {
            timeZone: 'Africa/Libreville',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
          });
          sock.sendMessage(msg.key.remoteJid, { 
            text: `🕐 Heure actuelle (Gabon):\n*${timeStr}*` 
          });
          break;
          
        case 'owner':
          sock.sendMessage(msg.key.remoteJid, { 
            text: `👨‍💻 **Administrateur CRAZY MINI XMD**\n\n` +
                  `Pour support ou questions:\n` +
                  `📞 Contact: +241 XX XX XX XX\n` +
                  `📧 Email: admin@crazyminixmd.com\n` +
                  `🌐 Site: crazyminixmd.com` 
          });
          break;
          
        default:
          sock.sendMessage(msg.key.remoteJid, { 
            text: `❌ Commande inconnue\n\n` +
                  `Tapez *.menu* pour voir les commandes disponibles.` 
          });
      }
    }
  });
}

// ==================== ROUTES API ====================
app.use(express.json());
app.use(express.static('public'));

// Route pour démarrer la connexion
app.post('/api/connect', async (req, res) => {
  try {
    const { number } = req.body;
    
    // Validation du numéro
    if (!number || !number.match(/^\+[1-9]\d{1,14}$/)) {
      return res.status(400).json({ 
        success: false,
        error: 'Format de numéro invalide. Utilisez: +24105730123' 
      });
    }
    
    // Vérifier si déjà connecté
    if (userSessions.has(number)) {
      const existingSocketId = userSessions.get(number);
      const session = activeSessions.get(existingSocketId);
      
      if (session && session.status === 'connected') {
        return res.json({
          success: true,
          alreadyConnected: true,
          message: 'Ce numéro est déjà connecté'
        });
      }
    }
    
    // Générer un ID de socket unique
    const socketId = `socket_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Démarrer la connexion en arrière-plan
    setTimeout(async () => {
      await createWhatsAppSession(number, socketId);
    }, 100);
    
    res.json({ 
      success: true, 
      socketId,
      message: 'Génération du code de connexion...' 
    });
    
  } catch (error) {
    console.error('❌ Erreur /api/connect:', error);
    res.status(500).json({ 
      success: false,
      error: 'Erreur serveur. Veuillez réessayer.' 
    });
  }
});

// Route pour vérifier le statut
app.get('/api/status', (req, res) => {
  const connectedBots = Array.from(activeSessions.values())
    .filter(session => session.status === 'connected')
    .length;
  
  res.json({
    active: connectedBots,
    total: activeSessions.size,
    uptime: process.uptime()
  });
});

// Route pour déconnecter
app.delete('/api/disconnect/:socketId', async (req, res) => {
  const socketId = req.params.socketId;
  const session = activeSessions.get(socketId);
  
  if (session) {
    try {
      if (session.socket) {
        await session.socket.logout();
      }
      
      activeSessions.delete(socketId);
      if (session.number) {
        userSessions.delete(session.number);
      }
      
      console.log(`🔒 Session déconnectée: ${socketId}`);
      
      res.json({ 
        success: true, 
        message: 'Déconnecté avec succès' 
      });
    } catch (error) {
      res.status(500).json({ 
        success: false, 
        error: 'Erreur lors de la déconnexion' 
      });
    }
  } else {
    res.status(404).json({ 
      success: false, 
      error: 'Session non trouvée' 
    });
  }
});

// ==================== WEBSOCKET (Socket.IO) ====================
io.on('connection', (socket) => {
  console.log(`🔌 Nouveau client connecté: ${socket.id}`);
  
  socket.on('join_session', (socketId) => {
    socket.join(socketId);
    console.log(`📡 Client ${socket.id} rejoint session: ${socketId}`);
  });
  
  socket.on('leave_session', (socketId) => {
    socket.leave(socketId);
  });
  
  socket.on('disconnect', () => {
    console.log(`👋 Client déconnecté: ${socket.id}`);
  });
});

// ==================== DÉMARRAGE DU SERVEUR ====================
async function startServer() {
  try {
    // Créer les dossiers nécessaires
    await fs.mkdir(path.join(__dirname, 'sessions'), { recursive: true });
    await fs.mkdir(path.join(__dirname, 'public'), { recursive: true });
    
    httpServer.listen(PORT, () => {
      console.log(`
      🚀 CRAZY MINI XMD DÉMARRÉ !
      ==============================
      🌐 Port: ${PORT}
      📱 Mode: Pairing Code Only
      🔧 Sessions: ${activeSessions.size}
      ⚡ Prêt à recevoir des connexions...
      ==============================
      `);
    });
  } catch (error) {
    console.error('❌ Erreur démarrage serveur:', error);
    process.exit(1);
  }
}

// Gestion propre de l'arrêt
process.on('SIGINT', async () => {
  console.log('🛑 Arrêt en cours...');
  
  // Déconnecter toutes les sessions
  for (const [socketId, session] of activeSessions.entries()) {
    if (session.socket) {
      try {
        await session.socket.logout();
      } catch (e) {}
    }
  }
  
  console.log('✅ Toutes sessions fermées');
  process.exit(0);
});

// Démarrer le serveur
startServer();
