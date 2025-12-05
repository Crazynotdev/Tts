const express = require("express");
const { Boom } = require("@hapi/boom");
const pino = require("pino");
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} = require("@whiskeysockets/baileys");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: "*" });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const SESSIONS_DIR = path.join(__dirname, "sessions");
const SEEN_JIDS_FILE = path.join(__dirname, "seen_jids.json");

if (!fs.existsSync(SEEN_JIDS_FILE)) fs.writeFileSync(SEEN_JIDS_FILE, "[]");
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR);

let sessions = {}; // { sessionId: { sock, socketClientId, isConnecting } }

// -------------------------
// Fonctions commandes
// -------------------------
async function sendMenu(sock, jid) {
  await sock.sendMessage(jid, {
    text: `✅ Commandes disponibles :
.menu - Afficher les commandes
.ping - Vérifier si le bot répond
.hello - Saluer le bot
.time - Heure actuelle
.info - Infos sur le bot
.quote - Citation aléatoire
.randomnum - Nombre aléatoire
.sticker - Créer sticker (répondez à une image avec .sticker)
.waifu - Image waifu
.dl - Télécharger un média (répondez avec .dl)
`,
  });
}

async function sendPing(sock, jid) {
  await sock.sendMessage(jid, { text: "🏓 Pong!" });
}

async function sendHello(sock, jid, pushName) {
  await sock.sendMessage(jid, { text: `👋 Hello ${pushName || "user"}!` });
}

async function sendTime(sock, jid) {
  const now = new Date().toLocaleString();
  await sock.sendMessage(jid, { text: `⏰ Heure actuelle : ${now}` });
}

async function sendInfo(sock, jid) {
  await sock.sendMessage(jid, {
    text: `🤖 Bot: CRAZY MINI XMD
Sessions actives: ${Object.keys(sessions).length}
Préfixe: .`,
  });
}

async function sendQuote(sock, jid) {
  const quotes = [
    "La vie est belle !",
    "Ne rêve pas ta vie, vis tes rêves !",
    "Le succès est la somme de petits efforts répétés.",
    "Rien n'est impossible, l'impossible prend juste un peu plus de temps."
  ];
  const q = quotes[Math.floor(Math.random() * quotes.length)];
  await sock.sendMessage(jid, { text: `💬 Citation : ${q}` });
}

async function sendRandomNum(sock, jid) {
  const num = Math.floor(Math.random() * 1000);
  await sock.sendMessage(jid, { text: `🔢 Nombre aléatoire : ${num}` });
}

async function sendWaifu(sock, jid) {
  const waifus = [
    "https://i.imgur.com/1.png",
    "https://i.imgur.com/2.png",
    "https://i.imgur.com/3.png"
  ];
  const img = waifus[Math.floor(Math.random() * waifus.length)];
  await sock.sendMessage(jid, { image: { url: img }, caption: "✨ Waifu aléatoire" });
}

async function createSticker(sock, jid, quotedMsg) {
  try {
    if (!quotedMsg || (!quotedMsg.imageMessage && !quotedMsg.videoMessage)) {
      await sock.sendMessage(jid, { text: "❌ Veuillez répondre à une image ou vidéo avec .sticker" });
      return;
    }

    await sock.sendMessage(jid, { text: "⏳ Création du sticker en cours..." });
    
    const mediaType = quotedMsg.imageMessage ? 'image' : 'video';
    const buffer = await downloadMediaMessage(
      { message: quotedMsg },
      mediaType,
      {},
      { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
    );

    await sock.sendMessage(jid, {
      sticker: Buffer.from(buffer),
    });
  } catch (error) {
    console.error("Erreur création sticker:", error);
    await sock.sendMessage(jid, { text: "❌ Erreur lors de la création du sticker" });
  }
}

async function downloadMedia(sock, jid, quotedMsg) {
  try {
    if (!quotedMsg || (!quotedMsg.imageMessage && !quotedMsg.videoMessage && !quotedMsg.audioMessage && !quotedMsg.documentMessage)) {
      await sock.sendMessage(jid, { text: "❌ Veuillez répondre à un média avec .dl" });
      return;
    }

    await sock.sendMessage(jid, { text: "⏳ Téléchargement du média en cours..." });
    
    let mediaType = 'unknown';
    if (quotedMsg.imageMessage) mediaType = 'image';
    else if (quotedMsg.videoMessage) mediaType = 'video';
    else if (quotedMsg.audioMessage) mediaType = 'audio';
    else if (quotedMsg.documentMessage) mediaType = 'document';
    
    const buffer = await downloadMediaMessage(
      { message: quotedMsg },
      mediaType,
      {},
      { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
    );

    const extension = mediaType === 'image' ? '.jpg' : 
                     mediaType === 'video' ? '.mp4' : 
                     mediaType === 'audio' ? '.mp3' : '.bin';
    
    const filename = `downloaded_${Date.now()}${extension}`;
    const filePath = path.join(__dirname, 'downloads', filename);
    
    if (!fs.existsSync(path.join(__dirname, 'downloads'))) {
      fs.mkdirSync(path.join(__dirname, 'downloads'));
    }
    
    fs.writeFileSync(filePath, buffer);
    
    await sock.sendMessage(jid, { 
      text: `✅ Média téléchargé: ${filename}\nChemin: ${filePath}` 
    });
  } catch (error) {
    console.error("Erreur téléchargement média:", error);
    await sock.sendMessage(jid, { text: "❌ Erreur lors du téléchargement du média" });
  }
}

// -------------------------
// Message de bienvenue
// -------------------------
async function sendWelcomeMessage(sock, jid, pushName) {
  const welcomeText = `👋 Bienvenue ${pushName || "Cher utilisateur"} !

🤖 *CRAZY MINI XMD* est maintenant connecté.

💡 Tapez *.menu* pour voir les commandes disponibles.

📱 Bot développé avec Baileys
✨ Profitez de toutes les fonctionnalités !`;
  
  await sock.sendMessage(jid, { 
    text: welcomeText,
    contextInfo: {
      mentionedJid: jid.includes('@s.whatsapp.net') ? [jid.split('@')[0]] : []
    }
  });
}

// -------------------------
// Récupérer le texte du message (multi-type)
// -------------------------
function getMessageText(msg) {
  const message = msg.message || msg;
  
  if (msg.messageStubType === 'REVOKE') return '';
  
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.audioMessage?.caption ||
    message.documentMessage?.caption ||
    ""
  );
}

// -------------------------
// Démarrage d'une session WhatsApp
// -------------------------
async function startSession(number, socketClientId) {
  const sessionId = number.replace(/\D/g, "");

  if (sessions[sessionId]?.isConnecting) return;
  sessions[sessionId] = { isConnecting: true };

  const { state, saveCreds } = await useMultiFileAuthState(path.join(SESSIONS_DIR, sessionId));
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    auth: state,
    browser: ["CRAZY MINI XMD", "Chrome", "1.0"],
  });

  sessions[sessionId].sock = sock;
  sessions[sessionId].socketClientId = socketClientId;

  // ----- Connexion QR et statut -----
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const qrImage = await QRCode.toDataURL(qr);
      io.to(socketClientId).emit("pairing_code", { code: qrImage });
      console.log(`[${number}] QR code envoyé`);
    }

    if (connection === "close") {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (reason !== DisconnectReason.loggedOut) {
        console.log(`[${number}] Reconnexion...`);
        sessions[sessionId].isConnecting = false;
        startSession(number, socketClientId);
      } else {
        console.log(`[${number}] Session supprimée`);
        delete sessions[sessionId];
        updateBotCount();
      }
    }

    if (connection === "open") {
      sessions[sessionId].isConnecting = false;
      io.to(socketClientId).emit("connection_success", { number });
      console.log(`[${number}] Bot connecté`);
      
      // Envoi du message de bienvenue au statut
      try {
        await sock.sendMessage(sock.user.id, { 
          text: "✅ *CRAZY MINI XMD* est maintenant connecté !\n\nTapez *.menu* pour voir les commandes disponibles." 
        });
      } catch (error) {
        console.log("Erreur envoi message de bienvenue:", error);
      }
      
      updateBotCount();
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // -------------------------
  // Gestion messages entrants - CORRIGÉ
  // -------------------------
  sock.ev.on("messages.upsert", async (m) => {
    console.log(`[${number}] Message reçu, type: ${m.type}`);
    
    // Accepter tous les types de messages, pas seulement "notify"
    const messages = m.messages;
    const seenJids = JSON.parse(fs.readFileSync(SEEN_JIDS_FILE));

    for (const msg of messages) {
      // Ignorer les messages envoyés par le bot lui-même
      if (msg.key.fromMe) continue;
      
      const jid = msg.key.remoteJid;
      
      // Vérifier si c'est un nouveau contact
      if (!seenJids.includes(jid)) {
        seenJids.push(jid);
        fs.writeFileSync(SEEN_JIDS_FILE, JSON.stringify(seenJids, null, 2));
        await sendWelcomeMessage(sock, jid, msg.pushName);
      }

      // Récupérer le texte du message
      const body = getMessageText(msg);
      console.log(`[${number}] Message texte: "${body}"`);
      
      if (!body.startsWith(".")) continue;

      const args = body.slice(1).trim().split(/ +/);
      const command = args[0].toLowerCase();

      // Récupérer le message cité pour les commandes .sticker et .dl
      let quotedMsg = null;
      if (msg.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
        quotedMsg = msg.message.extendedTextMessage.contextInfo.quotedMessage;
      }

      console.log(`[${number}] Commande détectée: ${command}`);

      // -------------------------
      // Switch/case des commandes
      // -------------------------
      try {
        switch (command) {
          case "menu":
            await sendMenu(sock, jid);
            break;
          case "ping":
            await sendPing(sock, jid);
            break;
          case "hello":
            await sendHello(sock, jid, msg.pushName);
            break;
          case "time":
            await sendTime(sock, jid);
            break;
          case "info":
            await sendInfo(sock, jid);
            break;
          case "quote":
            await sendQuote(sock, jid);
            break;
          case "randomnum":
          case "random":
            await sendRandomNum(sock, jid);
            break;
          case "waifu":
            await sendWaifu(sock, jid);
            break;
          case "sticker":
            await createSticker(sock, jid, quotedMsg);
            break;
          case "dl":
          case "download":
            await downloadMedia(sock, jid, quotedMsg);
            break;
          default:
            await sock.sendMessage(jid, { text: "❌ Commande inconnue. Tapez .menu pour la liste" });
            break;
        }
        console.log(`[${number}] Commande ${command} exécutée avec succès`);
      } catch (error) {
        console.error(`[${number}] Erreur exécution commande ${command}:`, error);
        await sock.sendMessage(jid, { text: "❌ Erreur lors de l'exécution de la commande" });
      }
    }
  });

  // Événement pour les mises à jour des messages (messages supprimés, etc.)
  sock.ev.on("messages.update", (m) => {
    // Gérer les messages supprimés si nécessaire
    console.log(`[${number}] Message mis à jour`);
  });

  // Activer la réception des messages
  sock.ev.on("connection.update", (update) => {
    if (update.connection === "open") {
      console.log(`[${number}] Prêt à recevoir des messages`);
    }
  });

  return sessionId;
}

// -------------------------
// API pour connecter un bot
// -------------------------
app.post("/api/connect", async (req, res) => {
  const { number, socketId } = req.body;
  if (!number) return res.status(400).json({ error: "Numéro manquant" });
  if (!socketId) return res.status(400).json({ error: "Socket ID manquant" });

  try {
    await startSession(number, socketId);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// -------------------------
// API pour déconnecter un bot
// -------------------------
app.post("/api/disconnect", async (req, res) => {
  const { number } = req.body;
  if (!number) return res.status(400).json({ error: "Numéro manquant" });

  const sessionId = number.replace(/\D/g, "");
  const session = sessions[sessionId];

  if (session) {
    try {
      await session.sock.logout();
      delete sessions[sessionId];
      updateBotCount();
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Erreur lors de la déconnexion" });
    }
  } else {
    res.status(404).json({ error: "Session non trouvée" });
  }
});

// -------------------------
// Socket.IO
// -------------------------
io.on("connection", (socket) => {
  console.log("Client socket connecté:", socket.id);
  
  socket.on("join_session", (id) => {
    socket.join(id);
    console.log(`Socket ${socket.id} a rejoint la session ${id}`);
  });
  
  socket.on("disconnect", () => {
    console.log("Client socket déconnecté:", socket.id);
  });
});

// -------------------------
// Compteur de bots connectés
// -------------------------
function updateBotCount() {
  const count = Object.keys(sessions).length;
  io.emit("bots_update", count);
  console.log(`📊 Bots connectés: ${count}`);
}

// -------------------------
// Route principale
// -------------------------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// -------------------------
// Route d'état des sessions
// -------------------------
app.get("/api/sessions", (req, res) => {
  const sessionList = Object.keys(sessions).map(sessionId => ({
    number: sessionId,
    isConnecting: sessions[sessionId].isConnecting,
    socketClientId: sessions[sessionId].socketClientId,
    isConnected: sessions[sessionId].sock?.user?.id ? true : false
  }));
  res.json({ sessions: sessionList, total: sessionList.length });
});

// -------------------------
// Lancement serveur
// -------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Serveur lancé sur http://localhost:${PORT}`);
  console.log(`📁 Sessions sauvegardées dans: ${SESSIONS_DIR}`);
  console.log(`📝 Logs des commandes activés`);
});
