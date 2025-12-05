const express = require("express");
const { Boom } = require("@hapi/boom");
const pino = require("pino");
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
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

if (!fs.existsSync(SEEN_JIDS_FILE)) fs.writeFileSync(SEEN_JIDS_FILE, JSON.stringify([]));
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR);

let sessions = {}; // { sessionId: { sock, socketClientId, isConnecting } }

// -------------------------
// Fonctions commandes
// -------------------------
async function sendMenu(sock, jid) {
  await sock.sendMessage(jid, {
    text: "✅ Commandes disponibles :\n.menu\n.ping\n.hello\n.time",
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
      updateBotCount();
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // -------------------------
  // Gestion des messages entrants
  // -------------------------
  sock.ev.on("messages.upsert", (m) => {
    const messages = m.messages;
    const seenJids = JSON.parse(fs.readFileSync(SEEN_JIDS_FILE));

    messages.forEach(async (msg) => {
      const jid = msg.key.remoteJid;
      if (!seenJids.includes(jid)) {
        seenJids.push(jid);
        fs.writeFileSync(SEEN_JIDS_FILE, JSON.stringify(seenJids, null, 2));
      }

      if (!msg.message || msg.key.fromMe) return;

      const body = msg.message.conversation || msg.message?.extendedTextMessage?.text || "";
      if (!body.startsWith(".")) return;

      const args = body.slice(1).trim().split(/ +/);
      const command = args[0].toLowerCase();

      // -------------------------
      // Switch/case des commandes
      // -------------------------
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
        default:
          await sock.sendMessage(jid, { text: "❌ Commande inconnue" });
          break;
      }
    });
  });

  return sessionId;
}

// -------------------------
// API pour connecter un bot
// -------------------------
app.post("/api/connect", async (req, res) => {
  const { number, socketId } = req.body;
  if (!number) return res.status(400).json({ error: "Numéro manquant" });

  try {
    await startSession(number, socketId);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// -------------------------
// Socket.IO
// -------------------------
io.on("connection", (socket) => {
  socket.on("join_session", (id) => socket.join(id));
});

// -------------------------
// Compteur de bots connectés
// -------------------------
function updateBotCount() {
  const count = Object.keys(sessions).length;
  io.emit("bots_update", count);
}

// -------------------------
// Route principale
// -------------------------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// -------------------------
// Lancement serveur
// -------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Serveur lancé sur http://localhost:${PORT}`));
