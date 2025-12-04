require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const rateLimit = require('express-rate-limit');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require('@whiskeysockets/baileys');
const fs = require('fs').promises;
const path = require('path');
const winston = require('winston');

// ==================== CONFIGURATION ====================
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const PORT = process.env.PORT || 3000;

// Logger pro
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
    new winston.transports.Console({ format: winston.format.simple() })
  ]
});

// Rate limiting intelligent
const connectLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 3, // 3 tentatives max
  message: { error: 'Trop de tentatives, réessayez plus tard' }
});

// ==================== STOCKAGE EN MÉMOIRE ====================
const sessions = new Map(); // number -> { socket, qr, status }
const userIPs = new Map(); // ip -> [numbers]

// ==================== FONCTIONS PRINCIPALES ====================

/**
 * Gère la connexion WhatsApp avec Baileys
 */
async function connectWhatsApp(number, ip, socketId) {
  try {
    const sessionPath = path.join(__dirname, 'sessions', number.replace('+', ''));
    
    // Vérifier limite IP
    const userNumbers = userIPs.get(ip) || [];
    if (userNumbers.length >= (process.env.MAX_BOTS_PER_IP || 2)) {
      throw new Error('Limite de bots atteinte pour votre IP');
    }

    // Création du socket
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      browser: ['CRAZY MINI XMD', 'Chrome', '3.0'],
      syncFullHistory: false,
      generateHighQualityLink: true,
      markOnlineOnConnect: true,
    });

    // Gestion des événements
    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('connection.update', async (update) => {
      const session = sessions.get(number) || {};
      
      if (update.qr) {
        // Générer QR code base64 pour le front
        const qrBase64 = await QRCode.toDataURL(update.qr);
        session.qr = qrBase64;
        session.status = 'qr_pending';
        sessions.set(number, session);
        
        io.to(socketId).emit('qr_update', {
          qr: qrBase64,
          pairingCode: update.pairingCode,
          number
        });
      }
      
      if (update.connection === 'open') {
        logger.info(`✅ Bot connecté: ${number}`);
        session.status = 'connected';
        session.connectedAt = new Date();
        sessions.set(number, session);
        
        userIPs.set(ip, [...new Set([...userNumbers, number])]);
        
        io.to(socketId).emit('connection_success', {
          number,
          message: 'Bot connecté avec succès!'
        });

        // Initialiser le handler de messages
        initMessageHandler(sock, number);
      }
      
      if (update.connection === 'close') {
        const reason = update.lastDisconnect?.error?.output?.statusCode;
        logger.warn(`❌ Déconnexion ${number}: ${reason || 'Unknown'}`);
        
        if (reason === DisconnectReason.loggedOut) {
          // Supprimer la session
          sessions.delete(number);
          try {
            await fs.rm(sessionPath, { recursive: true });
          } catch (e) {}
        }
        
        io.to(socketId).emit('connection_lost', { number, reason });
      }
    });

    sock.ev.on('messages.upsert', ({ messages }) => {
      handleIncomingMessage(sock, messages[0], number);
    });

    // Stocker la session
    sessions.set(number, { socket: sock, ip, socketId });
    
  } catch (error) {
    logger.error(`Erreur connexion ${number}:`, error);
    throw error;
  }
}

/**
 * Gère les messages entrants
 */
function handleIncomingMessage(sock, msg, botNumber) {
  if (!msg.message || msg.key.fromMe) return;
  
  const text = msg.message.conversation || 
               msg.message.extendedTextMessage?.text || 
               msg.message.imageMessage?.caption || '';
  
  // Loguer le message
  logger.info(`📥 ${botNumber} reçoit: ${text.substring(0, 50)}...`);
  
  // Vérifier préfixe
  if (text.startsWith('.')) {
    const command = text.slice(1).split(' ')[0].toLowerCase();
    const args = text.slice(command.length + 2).trim();
    
    // Commandes intégrées
    switch(command) {
      case 'ping':
        sock.sendMessage(msg.key.remoteJid, { 
          text: `🏓 Pong! *CRAZY MINI XMD* est opérationnel` 
        });
        break;
        
      case 'menu':
        const menu = `🤖 *CRAZY MINI XMD*\n
📍 Commandes disponibles:
• .ping - Test de réponse
• .menu - Ce menu
• .info - Infos du bot
• .time - Heure actuelle
• .owner - Contact admin

📡 Status: Connecté`;
        sock.sendMessage(msg.key.remoteJid, { text: menu });
        break;
        
      case 'info':
        sock.sendMessage(msg.key.remoteJid, { 
          text: `*🤖 CRAZY MINI XMD*\nVersion: 2.0\nHébergement: Serveur Cloud\nStatut: ✅ Actif\nAdmin: ${process.env.ADMIN_PHONE || 'Non configuré'}` 
        });
        break;
        
      case 'owner':
        sock.sendMessage(msg.key.remoteJid, { 
          text: `👨‍💻 *Contact Admin*\nPour support: ${process.env.ADMIN_PHONE || 'Non configuré'}\nProjet: CRAZY MINI XMD SaaS` 
        });
        break;
        
      default:
        sock.sendMessage(msg.key.remoteJid, { 
          text: `❌ Commande inconnue. Tapez *.menu* pour la liste.` 
        });
    }
  }
  
  // Envoyer webhook si configuré
  if (process.env.WEBHOOK_URL) {
    fetch(process.env.WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botNumber, message: msg })
    }).catch(() => {});
  }
}

/**
 * Initialise le handler de messages
 */
function initMessageHandler(sock, number) {
  sock.ev.on('messages.upsert', ({ messages }) => {
    handleIncomingMessage(sock, messages[0], number);
  });
}

// ==================== ROUTES API ====================
app.use(express.json());
app.use(express.static('public'));

// Page d'accueil
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API de connexion
app.post('/api/connect', connectLimiter, async (req, res) => {
  try {
    const { number } = req.body;
    const ip = req.ip;
    
    if (!number || !number.match(/^\+[1-9]\d{1,14}$/)) {
      return res.status(400).json({ error: 'Numéro WhatsApp invalide' });
    }
    
    if (sessions.has(number) && sessions.get(number).status === 'connected') {
      return res.json({ 
        warning: 'Bot déjà connecté', 
        qr: null,
        pairingCode: null 
      });
    }
    
    // Générer un ID unique pour le socket
    const socketId = `socket_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Démarrer la connexion en arrière-plan
    connectWhatsApp(number, ip, socketId).catch(logger.error);
    
    res.json({ 
      success: true, 
      socketId,
      message: 'Connexion en cours, scannez le QR qui apparaîtra' 
    });
    
  } catch (error) {
    logger.error('Erreur API connect:', error);
    res.status(500).json({ error: error.message });
  }
});

// API de statut
app.get('/api/status/:number', (req, res) => {
  const session = sessions.get(req.params.number);
  res.json({ 
    status: session?.status || 'disconnected',
    connectedAt: session?.connectedAt,
    ip: session?.ip 
  });
});

// API de déconnexion
app.delete('/api/disconnect/:number', async (req, res) => {
  const number = req.params.number;
  const session = sessions.get(number);
  
  if (session?.socket) {
    await session.socket.logout();
    sessions.delete(number);
    logger.info(`🔒 Bot déconnecté: ${number}`);
  }
  
  res.json({ success: true, message: 'Bot déconnecté' });
});

// ==================== WEBSOCKETS ====================
io.on('connection', (socket) => {
  logger.info(`🔌 Nouveau client Socket.IO: ${socket.id}`);
  
  socket.on('join_session', (socketId) => {
    socket.join(socketId);
  });
  
  socket.on('disconnect', () => {
    // Nettoyer les sessions orphelines
    for (const [number, session] of sessions.entries()) {
      if (session.socketId === socket.id) {
        logger.info(`🧹 Nettoyage session orpheline: ${number}`);
        sessions.delete(number);
      }
    }
  });
});

// ==================== DÉMARRAGE ====================
async function startServer() {
  // Créer les dossiers nécessaires
  await fs.mkdir(path.join(__dirname, 'sessions'), { recursive: true });
  await fs.mkdir(path.join(__dirname, 'logs'), { recursive: true });
  
  httpServer.listen(PORT, () => {
    logger.info(`
    🚀 CRAZY MINI XMD DÉMARRÉ
    ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
    █ Port: ${PORT}
    █ Mode: ${process.env.NODE_ENV}
    █ Sessions actives: ${sessions.size}
    █ Admin: ${process.env.ADMIN_PHONE || 'Non configuré'}
    █ Max par IP: ${process.env.MAX_BOTS_PER_IP || 2}
    ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
    `);
  });
}

// Gestion propre des arrêts
process.on('SIGINT', async () => {
  logger.info('🛑 Arrêt en cours...');
  
  // Déconnecter tous les bots proprement
  for (const [number, session] of sessions.entries()) {
    if (session.socket) {
      await session.socket.logout().catch(() => {});
    }
  }
  
  process.exit(0);
});

// Démarrer le serveur
startServer().catch(console.error);
